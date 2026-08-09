// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "../base/GatewayCaller.sol";

/**
 * @title NoctisVaultV2 - Multi-Token Encrypted Asset Vault
 * @notice Token-generic vault with encrypted balances using ZAMA fhEVM v0.9
 * @dev V2 generalizes NoctisVault (ETH/USDT hardcoded) to an owner-managed token
 *      registry. Native ETH is represented by token address(0).
 *
 * Carried over from V1 (battle-tested invariants):
 * - Every FHE.sub on a balance is gated by FHE.le + FHE.select (C-1)
 * - No physical fund transfer before FHE.checkSignatures proof (deduct auth pattern)
 * - Fee-on-transfer measurement on ERC-20 deposits (CRITICAL-1/2)
 * - Pull-over-push claim pattern for ETH payouts (M-3)
 * - Per-token daily circuit breakers + user pattern monitoring (CRITICAL-3)
 * - VaultId privacy indirection for relayer flows
 * - Guardian (pause-only) with 7-day change timelock
 *
 * Intentionally dropped from V1 (dead in the v0.9 self-relaying flow):
 * - Keeper set + keeper change timelock (onlyKeeper had no call sites)
 * - Legacy Gateway address timelock (FHE.checkSignatures is the trust root)
 * - Encrypted recipient surface (withdrawals are self-recipient in MVP scope)
 */
contract NoctisVaultV2 is ReentrancyGuard, Pausable, Ownable, GatewayCaller {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ============================================
    // TOKEN REGISTRY
    // ============================================

    /// @notice Sentinel for native ETH
    address public constant NATIVE = address(0);

    /// @notice Per-token limits and metadata. All amounts in the token's own units.
    struct TokenConfig {
        bool enabled;           // deposits/withdrawals allowed
        uint8 decimals;         // cached (18 for NATIVE)
        uint128 minDeposit;     // dust protection
        uint128 maxDeposit;     // risk management
        uint128 maxWithdrawal;  // per-request cap (bounds KMS blast radius)
        uint128 maxDaily;       // protocol-wide 24h withdrawal circuit breaker
    }

    /// @notice Registered token configurations (address(0) = native ETH)
    mapping(address => TokenConfig) public tokenConfigs;

    /// @notice Enumerable list of registered tokens
    EnumerableSet.AddressSet private tokenList;

    // ============================================
    // ENCRYPTED BALANCES
    // ============================================

    /// @dev NEVER public (ZAMA rule): token => user => encrypted balance
    mapping(address => mapping(address => euint128)) internal balances;

    /// @dev FHE.add on an uninitialized handle is invalid; first credit assigns
    mapping(address => mapping(address => bool)) private depositedFlag;

    /// @dev Per-token per-user deposit rate limit (one deposit per block)
    mapping(address => mapping(address => uint256)) private lastDepositBlock;

    // ============================================
    // VAULT ID SYSTEM (privacy indirection)
    // ============================================

    mapping(uint256 => address) private vaultOwners;
    mapping(address => uint256) private userVaultId;
    uint256 private vaultIdNonce;

    // ============================================
    // WITHDRAWAL STATE
    // ============================================

    struct WithdrawalRequest {
        uint256 requestId;
        address requester;              // withdrawal recipient (MVP: self only)
        address token;                  // NATIVE for ETH
        euint128 encryptedAmount;
        ebool hasSufficientBalance;     // FHE.ge(balance, amount) at request time
        uint256 requestTime;
        bool executed;
        bool decryptionRequested;
        uint256 decryptionRequestTime;
    }

    mapping(uint256 => WithdrawalRequest) public withdrawalRequests;
    uint256 public withdrawalCounter;

    /// @dev H-1: bound the pending queue per user
    mapping(address => uint256) private pendingWithdrawalCount;
    uint256 public constant MAX_PENDING_WITHDRAWALS_PER_USER = 1;

    uint256 public constant CANCELLATION_TIMEOUT = 1 hours;
    uint256 public constant DECRYPTION_TIMEOUT = 1 hours;
    uint256 public constant RETRY_COOLDOWN = 10 minutes;

    /// @dev CRITICAL-2: reject deposit fees > 1%
    uint256 public constant MAX_ACCEPTABLE_FEE_BPS = 100;

    // ============================================
    // WITHDRAWAL MONITORING (per-token circuit breakers)
    // ============================================

    uint256 public constant WITHDRAWAL_WINDOW = 24 hours;
    uint256 public constant MAX_USER_WITHDRAWALS_24H = 5;
    uint256 public constant SUSPICIOUS_WITHDRAWAL_RATIO_BPS = 5000; // 50%

    struct UserWindow {
        uint256 windowStart;
        uint256 count24h;
    }

    mapping(address => UserWindow) private userWindows;
    /// @dev user => token => amount withdrawn in current window
    mapping(address => mapping(address => uint256)) private userAmount24h;
    /// @dev user => token => lifetime deposits (ratio monitoring, per-token units)
    mapping(address => mapping(address => uint256)) private lifetimeDeposits;

    struct TokenWindow {
        uint256 withdrawn24h;
        uint256 windowStart;
    }

    /// @dev token => protocol-wide 24h withdrawal tracking
    mapping(address => TokenWindow) private tokenWithdrawals;

    // ============================================
    // CLAIMABLE ETH (pull-over-push, M-3)
    // ============================================

    mapping(address => uint256) private claimableETH;

    // ============================================
    // SWAP DEDUCT AUTH (fund-safety, same pattern as V1)
    // ============================================

    struct PendingDeductAuth {
        address user;
        address token;
        uint256 amount;         // plaintext amount if known at prepare time
        bool active;
        bool amountKnown;
        ebool hasSufficient;
        euint128 encryptedAmount;
    }

    /// @dev key = keccak256(abi.encode(exchange, orderId))
    mapping(bytes32 => PendingDeductAuth) private pendingDeductAuth;

    // ============================================
    // ACCESS: EXCHANGE + GUARDIAN
    // ============================================

    mapping(address => bool) public authorizedExchanges;

    address public guardian;
    address public pendingGuardian;
    uint256 public guardianChangeTimestamp;
    uint256 public constant GUARDIAN_CHANGE_DELAY = 7 days;

    // ============================================
    // ERRORS
    // ============================================

    error ZeroAmount();
    error InvalidAddress();
    error InsufficientBalance();
    error TransferFailed();
    error TokenNotSupported();
    error TokenAlreadyRegistered();
    error InvalidTokenConfig();
    error BelowMinimumDeposit();
    error ExceedsMaximumDeposit();
    error ExceedsMaximumWithdrawal();
    error DepositTooFrequent();
    error InvalidETHAmount();
    error WithdrawalAlreadyExecuted();
    error WithdrawalNotFound();
    error InvalidWithdrawalAmount();
    error CancellationTooEarly();
    error NotWithdrawalRequester();
    error InvalidVaultId();
    error NoVaultId();
    error DecryptionAlreadyRequested();
    error DecryptionNotRequested();
    error DecryptionTimeoutExceeded();
    error RetryTooEarly(uint256 timeLeft);
    error UnauthorizedExchange();
    error TooManyPendingWithdrawals();
    error InvalidDecryptedValue();
    error InsufficientEncryptedBalance();
    error DeductAuthNotPrepared();
    error DeductAuthAlreadyExists();
    error InvalidSufficiencyProof();
    error DeductAmountMismatch();
    error ExcessiveTransferFee(uint256 feePercentageBPS, uint256 maxAllowedBPS);
    error ZeroReceivedAmount();
    error TooManyWithdrawals24h(uint256 count, uint256 maxAllowed);
    error NothingToClaim();
    error NoGuardianProposal();
    error GuardianChangeTooEarly(uint256 timeLeft);
    error OnlyGuardian();

    // ============================================
    // EVENTS (privacy: no indexed user addresses on flow events)
    // ============================================

    /// @notice Token registered or reconfigured
    event TokenConfigured(address indexed token, bool enabled);

    /// @dev Amount intentionally omitted (visible on-chain anyway; not a privacy boundary)
    event Deposited(address indexed token, address user);

    event TransferFeeDetected(address user, uint256 requestedAmount, uint256 actualReceived, uint256 feeLost);

    event WithdrawalRequested(uint256 indexed requestId, address requester, address token, uint256 timestamp);
    event WithdrawalExecuted(uint256 indexed requestId, address recipient, uint256 amount);
    event WithdrawalCancelled(uint256 indexed requestId, address requester);
    event WithdrawalExecutionFailed(uint256 indexed requestId);

    /// @notice v0.9 self-relay: handles ready for public decryption
    event DecryptionReady(uint256 indexed requestId, bytes32[] handles);
    event DecryptionRetried(uint256 indexed requestId);

    event SuspiciousDecryptedValue(uint256 indexed requestId, uint256 decryptedAmount, string reason);
    event SuspiciousWithdrawalPattern(address user, uint256 count24h, uint256 amount24h, uint256 lifetimeDeposited, string reason);
    event CircuitBreakerTriggered(address indexed token, uint256 attempted, uint256 limit);

    event ClaimableBalanceUpdated(address user, uint256 amount, uint256 newBalance);
    event ETHClaimed(address user, uint256 amount);

    event ExchangeAuthorized(address indexed exchange, bool status);

    event GuardianProposed(address indexed newGuardian, uint256 executeAfter);
    event GuardianChanged(address indexed oldGuardian, address indexed newGuardian);
    event EmergencyPauseActivated(address indexed guardian);

    /// @dev Privacy: token only, no user/amount
    event BalanceDeducted(address indexed token);
    event BalanceCredited(address indexed token);
    event DeductAuthPrepared(uint256 indexed orderId, address indexed token, bytes32 sufficiencyHandle);
    event DeductAuthCancelled(uint256 indexed orderId);

    // ============================================
    // MODIFIERS
    // ============================================

    modifier onlyExchange() {
        if (!authorizedExchanges[msg.sender]) revert UnauthorizedExchange();
        _;
    }

    modifier onlySupported(address token) {
        if (!tokenConfigs[token].enabled) revert TokenNotSupported();
        _;
    }

    // ============================================
    // CONSTRUCTOR
    // ============================================

    /// @param initialOwner Safe multisig for production
    constructor(address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert InvalidAddress();
        // Tokens (including native ETH) are registered post-deploy via configureToken.
        // FHEVM v0.9: coprocessor auto-configured by ZamaEthereumConfig.
    }

    // ============================================
    // TOKEN REGISTRY (owner)
    // ============================================

    /**
     * @notice Register a new token or update the config of an existing one
     * @param token ERC-20 address, or address(0) for native ETH
     * @param decimals Token decimals (18 for NATIVE); passed explicitly so the
     *        vault never trusts token metadata
     */
    function configureToken(
        address token,
        uint8 decimals,
        uint128 minDeposit,
        uint128 maxDeposit,
        uint128 maxWithdrawal,
        uint128 maxDaily
    ) external onlyOwner {
        if (minDeposit == 0 || minDeposit >= maxDeposit) revert InvalidTokenConfig();
        if (maxWithdrawal == 0 || maxDaily == 0) revert InvalidTokenConfig();

        tokenConfigs[token] = TokenConfig({
            enabled: true,
            decimals: decimals,
            minDeposit: minDeposit,
            maxDeposit: maxDeposit,
            maxWithdrawal: maxWithdrawal,
            maxDaily: maxDaily
        });
        tokenList.add(token);

        emit TokenConfigured(token, true);
    }

    /// @notice Enable/disable deposits + withdrawals for a token (funds stay withdrawable
    ///         once re-enabled; disabling is an incident-response lever, not a rug)
    function setTokenEnabled(address token, bool enabled) external onlyOwner {
        if (!tokenList.contains(token)) revert TokenNotSupported();
        tokenConfigs[token].enabled = enabled;
        emit TokenConfigured(token, enabled);
    }

    /// @notice All registered tokens (enabled or not)
    function getSupportedTokens() external view returns (address[] memory) {
        return tokenList.values();
    }

    // ============================================
    // DEPOSITS
    // ============================================

    /// @notice Deposit native ETH into an encrypted balance
    function depositETH() external payable nonReentrant whenNotPaused onlySupported(NATIVE) {
        TokenConfig storage cfg = tokenConfigs[NATIVE];
        if (msg.value == 0) revert ZeroAmount();
        if (msg.value < cfg.minDeposit) revert BelowMinimumDeposit();
        if (msg.value > cfg.maxDeposit) revert ExceedsMaximumDeposit();
        if (block.number == lastDepositBlock[NATIVE][msg.sender]) revert DepositTooFrequent();

        lastDepositBlock[NATIVE][msg.sender] = block.number;
        _assignVaultIdIfNeeded(msg.sender);
        _creditEncrypted(NATIVE, msg.sender, msg.value);

        emit Deposited(NATIVE, msg.sender);
    }

    /**
     * @notice Deposit an ERC-20 token into an encrypted balance
     * @dev Fee-on-transfer safe: credits what actually arrived, rejects fees > 1%
     */
    function depositToken(address token, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        onlySupported(token)
    {
        if (token == NATIVE) revert InvalidAddress();
        TokenConfig storage cfg = tokenConfigs[token];
        if (amount == 0) revert ZeroAmount();
        if (amount < cfg.minDeposit) revert BelowMinimumDeposit();
        if (amount > cfg.maxDeposit) revert ExceedsMaximumDeposit();
        if (block.number == lastDepositBlock[token][msg.sender]) revert DepositTooFrequent();

        lastDepositBlock[token][msg.sender] = block.number;
        _assignVaultIdIfNeeded(msg.sender);

        // Interactions first to measure the amount that actually arrived
        IERC20 erc20 = IERC20(token);
        uint256 balanceBefore = erc20.balanceOf(address(this));
        erc20.safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualReceived = erc20.balanceOf(address(this)) - balanceBefore;

        if (actualReceived == 0) revert ZeroReceivedAmount();
        // Checked arithmetic reverts if a weird token credits MORE than `amount`
        uint256 feeLost = amount - actualReceived;
        uint256 feePercentageBPS = (feeLost * 10000) / amount;
        if (feePercentageBPS > MAX_ACCEPTABLE_FEE_BPS) {
            revert ExcessiveTransferFee(feePercentageBPS, MAX_ACCEPTABLE_FEE_BPS);
        }
        if (feeLost > 0) {
            emit TransferFeeDetected(msg.sender, amount, actualReceived, feeLost);
        }
        // Re-check minimum on what actually arrived (prevents fee-based bypass)
        if (actualReceived < cfg.minDeposit) revert BelowMinimumDeposit();

        _creditEncrypted(token, msg.sender, actualReceived);

        emit Deposited(token, msg.sender);
    }

    /// @dev Silent vaultId assignment on first deposit (no event: privacy).
    ///      PRIVACY: ids are pseudo-random, not sequential — sequential ids let an
    ///      observer rebuild the vaultId<->address table by replaying the public
    ///      ordering of first deposits. (Raw storage reads can still link; see
    ///      ROADMAP_E2E_ENCRYPTED_INTENTS.md phase B.)
    function _assignVaultIdIfNeeded(address user) private {
        if (userVaultId[user] == 0) {
            uint256 vid;
            do {
                vid = uint256(
                    keccak256(abi.encodePacked(user, block.prevrandao, address(this), ++vaultIdNonce))
                );
            } while (vid == 0 || vaultOwners[vid] != address(0));
            userVaultId[user] = vid;
            vaultOwners[vid] = user;
        }
    }

    /// @dev First credit assigns instead of FHE.add (uninitialized handle is invalid),
    ///      then re-grants ACL (vault + owner) after the encrypted write
    function _creditEncrypted(address token, address user, uint256 amount) private {
        euint128 encryptedAmount = FHE.asEuint128(uint128(amount));
        euint128 newBalance;

        if (depositedFlag[token][user]) {
            newBalance = FHE.add(balances[token][user], encryptedAmount);
        } else {
            newBalance = encryptedAmount;
            depositedFlag[token][user] = true;
        }
        balances[token][user] = newBalance;

        FHE.allowThis(newBalance);
        FHE.allow(newBalance, user);

        lifetimeDeposits[user][token] += amount;
    }

    // ============================================
    // BALANCE VIEWS
    // ============================================

    /**
     * @notice Get the encrypted balance handle for a user
     * @dev Handle is returned to any caller (ciphertext alone is not decryptable).
     *      Decrypt ACL is granted ONLY to the owner or an authorized exchange.
     */
    function getEncryptedBalance(address user, address token) external returns (euint128) {
        if (user == address(0)) revert InvalidAddress();
        euint128 balance = balances[token][user];

        // Uninitialized: return storage handle as-is (zero bytes32). Do NOT mint an
        // ephemeral FHE.asEuint128(0) here — it has no ACL and breaks userDecrypt.
        if (depositedFlag[token][user]) {
            FHE.allowThis(balance);
            if (msg.sender == user || authorizedExchanges[msg.sender]) {
                FHE.allow(balance, msg.sender);
            }
        }
        return balance;
    }

    /// @notice Whether the user has an initialized encrypted balance for a token
    function hasUserDeposited(address user, address token) external view returns (bool) {
        return depositedFlag[token][user];
    }

    // ============================================
    // WITHDRAWALS (v0.9 self-relaying pattern)
    // ============================================

    /**
     * @notice Request a withdrawal of `amount` (plaintext) of `token` to msg.sender
     * @dev C-1 discipline: debit gated by FHE.select — balance can never underflow.
     *      MVP scope: recipient is always the requester.
     */
    function requestWithdrawal(address token, uint128 amount)
        external
        nonReentrant
        whenNotPaused
        onlySupported(token)
        returns (uint256)
    {
        if (amount == 0) revert InvalidWithdrawalAmount();
        if (amount > tokenConfigs[token].maxWithdrawal) revert ExceedsMaximumWithdrawal();

        euint128 encryptedAmount = FHE.asEuint128(amount);
        return _createWithdrawal(token, encryptedAmount);
    }

    /**
     * @notice Request a withdrawal with a client-side encrypted amount (mempool privacy)
     * @dev Amount is not visible in tx input data. Max-withdrawal bound is enforced
     *      at callback time on the proven cleartext.
     */
    function requestWithdrawalPrivate(
        address token,
        externalEuint128 encryptedAmount,
        bytes calldata inputProof
    ) external nonReentrant whenNotPaused onlySupported(token) returns (uint256) {
        euint128 encAmount = FHE.fromExternal(encryptedAmount, inputProof);
        return _createWithdrawal(token, encAmount);
    }

    function _createWithdrawal(address token, euint128 encAmount) private returns (uint256) {
        if (pendingWithdrawalCount[msg.sender] >= MAX_PENDING_WITHDRAWALS_PER_USER) {
            revert TooManyPendingWithdrawals();
        }

        euint128 currentBalance = balances[token][msg.sender];

        // C-1: gate the debit — never FHE.sub a balance ungated
        ebool hasSufficientBalance = FHE.ge(currentBalance, encAmount);
        euint128 debit = FHE.select(hasSufficientBalance, encAmount, FHE.asEuint128(0));
        euint128 newBalance = FHE.sub(currentBalance, debit);

        balances[token][msg.sender] = newBalance;
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, msg.sender);

        FHE.allowThis(encAmount);
        FHE.allowThis(hasSufficientBalance);

        uint256 requestId = ++withdrawalCounter;
        withdrawalRequests[requestId] = WithdrawalRequest({
            requestId: requestId,
            requester: msg.sender,
            token: token,
            encryptedAmount: encAmount,
            hasSufficientBalance: hasSufficientBalance,
            requestTime: block.timestamp,
            executed: false,
            decryptionRequested: false,
            decryptionRequestTime: 0
        });

        pendingWithdrawalCount[msg.sender]++;

        emit WithdrawalRequested(requestId, msg.sender, token, block.timestamp);
        return requestId;
    }

    /**
     * @notice Mark withdrawal handles publicly decryptable (step 2 of self-relay)
     * @dev Only the amount and a sufficiency boolean are decrypted — never the balance
     */
    function requestWithdrawalExecution(uint256 requestId) external nonReentrant whenNotPaused {
        WithdrawalRequest storage request = withdrawalRequests[requestId];

        if (request.requestId == 0) revert WithdrawalNotFound();
        if (request.executed) revert WithdrawalAlreadyExecuted();
        if (request.decryptionRequested) revert DecryptionAlreadyRequested();
        if (request.requester != msg.sender) revert NotWithdrawalRequester();

        request.decryptionRequested = true;
        request.decryptionRequestTime = block.timestamp;

        FHE.allowThis(request.encryptedAmount);
        FHE.allowThis(request.hasSufficientBalance);
        // Batch ACL call (works around consecutive makePubliclyDecryptable issue)
        _makePubliclyDecryptableBatchAmountBool(request.encryptedAmount, request.hasSufficientBalance);

        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(request.encryptedAmount);
        handles[1] = FHE.toBytes32(request.hasSufficientBalance);

        emit DecryptionReady(requestId, handles);
    }

    /// @notice Reset a stuck decryption request after a cooldown (transient KMS failures)
    function retryWithdrawalExecution(uint256 requestId) external nonReentrant whenNotPaused {
        WithdrawalRequest storage request = withdrawalRequests[requestId];

        if (request.requestId == 0) revert WithdrawalNotFound();
        if (!request.decryptionRequested) revert DecryptionNotRequested();
        if (request.executed) revert WithdrawalAlreadyExecuted();
        if (request.requester != msg.sender) revert NotWithdrawalRequester();

        uint256 elapsed = block.timestamp - request.decryptionRequestTime;
        if (elapsed < RETRY_COOLDOWN) revert RetryTooEarly(RETRY_COOLDOWN - elapsed);

        request.decryptionRequested = false;
        request.decryptionRequestTime = 0;

        emit DecryptionRetried(requestId);
    }

    /**
     * @notice Execute the withdrawal with proven cleartexts (step 3 of self-relay)
     * @dev Permissionless: FHE.checkSignatures is the authentication. Cleartext is
     *      authoritative ONLY after checkSignatures; limits bound the blast radius
     *      if the KMS is ever wrong.
     */
    function executeWithdrawalCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory decryptionProof
    ) external nonReentrant whenNotPaused {
        WithdrawalRequest storage request = withdrawalRequests[requestId];

        if (request.requestId == 0) revert WithdrawalNotFound();
        if (request.executed) revert WithdrawalAlreadyExecuted();
        if (!request.decryptionRequested) revert DecryptionNotRequested();
        if (block.timestamp > request.decryptionRequestTime + DECRYPTION_TIMEOUT * 2) {
            revert DecryptionTimeoutExceeded();
        }

        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(request.encryptedAmount);
        handles[1] = FHE.toBytes32(request.hasSufficientBalance);
        FHE.checkSignatures(handles, cleartexts, decryptionProof);

        (uint128 decryptedAmount, bool hasSufficientBalance) = abi.decode(cleartexts, (uint128, bool));

        address token = request.token;
        address recipient = request.requester;

        // Defense-in-depth validations on the proven cleartext
        if (decryptedAmount == 0) {
            emit SuspiciousDecryptedValue(requestId, decryptedAmount, "Decrypted amount is zero");
            emit WithdrawalExecutionFailed(requestId);
            revert InvalidWithdrawalAmount();
        }
        if (decryptedAmount > tokenConfigs[token].maxWithdrawal) {
            emit SuspiciousDecryptedValue(requestId, decryptedAmount, "Exceeds maxWithdrawal");
            emit WithdrawalExecutionFailed(requestId);
            revert ExceedsMaximumWithdrawal();
        }
        uint256 contractBalance = token == NATIVE
            ? address(this).balance
            : IERC20(token).balanceOf(address(this));
        if (decryptedAmount > contractBalance) {
            emit SuspiciousDecryptedValue(requestId, decryptedAmount, "Exceeds contract balance");
            emit WithdrawalExecutionFailed(requestId);
            revert InsufficientBalance();
        }

        // Insufficient balance: debit was already gated to 0 at request time —
        // nothing to restore. Mark handled and stop.
        if (!hasSufficientBalance) {
            request.executed = true;
            if (pendingWithdrawalCount[recipient] > 0) {
                pendingWithdrawalCount[recipient]--;
            }
            emit SuspiciousDecryptedValue(requestId, decryptedAmount, "Amount exceeds user balance");
            emit WithdrawalExecutionFailed(requestId);
            return;
        }

        // Circuit breakers + pattern monitoring. When the per-token daily cap trips,
        // the protocol pauses and the request stays pending (retry after unpause).
        if (!_validateWithdrawalLimits(recipient, token, decryptedAmount)) {
            emit WithdrawalExecutionFailed(requestId);
            return;
        }

        // Effects before interactions
        request.executed = true;
        if (pendingWithdrawalCount[recipient] > 0) {
            pendingWithdrawalCount[recipient]--;
        }

        if (token == NATIVE) {
            // M-3: pull-over-push (malicious recipient contracts cannot block flow)
            claimableETH[recipient] += decryptedAmount;
            emit ClaimableBalanceUpdated(recipient, decryptedAmount, claimableETH[recipient]);
        } else {
            IERC20(token).safeTransfer(recipient, decryptedAmount);
        }

        emit WithdrawalExecuted(requestId, recipient, decryptedAmount);
    }

    /// @notice Cancel a withdrawal request; refunds only what was actually debited
    function cancelWithdrawal(uint256 requestId) external nonReentrant {
        WithdrawalRequest storage request = withdrawalRequests[requestId];

        if (request.requestId == 0) revert WithdrawalNotFound();
        if (request.requester != msg.sender) revert NotWithdrawalRequester();
        if (request.executed) revert WithdrawalAlreadyExecuted();

        // Before decryption starts: immediate cancel. After: wait out the timeout
        // (prevents gaming mid-decryption).
        if (request.decryptionRequested) {
            if (block.timestamp < request.decryptionRequestTime + DECRYPTION_TIMEOUT) {
                revert CancellationTooEarly();
            }
        }

        request.executed = true;
        if (pendingWithdrawalCount[msg.sender] > 0) {
            pendingWithdrawalCount[msg.sender]--;
        }

        // C-1: refund = select(hasSufficient, amount, 0) — mirror of the gated debit
        euint128 refund = FHE.select(
            request.hasSufficientBalance,
            request.encryptedAmount,
            FHE.asEuint128(0)
        );
        address token = request.token;
        euint128 newBalance = FHE.add(balances[token][msg.sender], refund);
        balances[token][msg.sender] = newBalance;

        FHE.allowThis(newBalance);
        FHE.allow(newBalance, msg.sender);

        emit WithdrawalCancelled(requestId, msg.sender);
    }

    /// @notice Claim executed ETH withdrawals (pure pull CEI — failing recipient reverts)
    function claimETH() external nonReentrant {
        uint256 amount = claimableETH[msg.sender];
        if (amount == 0) revert NothingToClaim();

        claimableETH[msg.sender] = 0;

        (bool success, ) = msg.sender.call{value: amount}("");
        if (!success) revert TransferFailed();

        emit ETHClaimed(msg.sender, amount);
    }

    /// @dev Per-token circuit breaker + user pattern detection.
    ///      Returns false (after pausing) when the daily cap trips, so the caller can
    ///      leave the request pending instead of reverting the pause away.
    function _validateWithdrawalLimits(address user, address token, uint256 amount)
        internal
        returns (bool)
    {
        UserWindow storage uw = userWindows[user];
        if (block.timestamp > uw.windowStart + WITHDRAWAL_WINDOW) {
            uw.count24h = 0;
            uw.windowStart = block.timestamp;
            // Note: per-token user amounts are lazily superseded — the count window
            // reset is what gates further withdrawals; amounts feed the ratio alert only.
            userAmount24h[user][token] = 0;
        }

        TokenWindow storage tw = tokenWithdrawals[token];
        if (block.timestamp > tw.windowStart + WITHDRAWAL_WINDOW) {
            tw.withdrawn24h = 0;
            tw.windowStart = block.timestamp;
        }

        uint256 maxDaily = tokenConfigs[token].maxDaily;
        if (tw.withdrawn24h + amount > maxDaily) {
            // V1 paused then reverted — the revert rolled the pause back, so the
            // breaker never actually tripped. V2 pauses and returns gracefully.
            _pause();
            emit CircuitBreakerTriggered(token, tw.withdrawn24h + amount, maxDaily);
            return false;
        }

        if (uw.count24h >= MAX_USER_WITHDRAWALS_24H) {
            emit SuspiciousWithdrawalPattern(
                user,
                uw.count24h + 1,
                userAmount24h[user][token] + amount,
                lifetimeDeposits[user][token],
                "Too many withdrawals in 24h"
            );
            revert TooManyWithdrawals24h(uw.count24h, MAX_USER_WITHDRAWALS_24H);
        }

        uint256 newAmount24h = userAmount24h[user][token] + amount;
        uint256 lifetime = lifetimeDeposits[user][token];
        if (lifetime > 0) {
            uint256 threshold = (lifetime * SUSPICIOUS_WITHDRAWAL_RATIO_BPS) / 10000;
            if (newAmount24h > threshold) {
                // Alert only — monitoring signal, not a block
                emit SuspiciousWithdrawalPattern(
                    user,
                    uw.count24h + 1,
                    newAmount24h,
                    lifetime,
                    "Withdrawing >50% of deposits in 24h"
                );
            }
        }

        uw.count24h++;
        userAmount24h[user][token] = newAmount24h;
        tw.withdrawn24h += amount;
        return true;
    }

    // ============================================
    // EXCHANGE INTEGRATION
    // ============================================

    /**
     * @notice Credit a user's encrypted balance after swap settlement
     * @dev ERC-20 settlement convention (same as V1): the exchange transfers the
     *      tokens to this vault BEFORE calling credit. Native ETH is passed as value.
     */
    function creditBalance(address user, uint256 amount, address token)
        external
        payable
        onlyExchange
        nonReentrant
        whenNotPaused
    {
        if (user == address(0)) revert InvalidAddress();
        _creditBalanceInternal(user, amount, token);
    }

    /// @notice Credit by vaultId (privacy: no address in cross-contract calldata)
    function creditBalanceByVaultId(uint256 vaultId, uint256 amount, address token)
        external
        payable
        onlyExchange
        nonReentrant
        whenNotPaused
    {
        address user = vaultOwners[vaultId];
        if (user == address(0)) revert InvalidVaultId();
        _creditBalanceInternal(user, amount, token);
    }

    function _creditBalanceInternal(address user, uint256 amount, address token) internal {
        if (amount == 0) revert ZeroAmount();
        if (!tokenList.contains(token)) revert TokenNotSupported();
        if (token == NATIVE) {
            if (msg.value != amount) revert InvalidETHAmount();
        } else {
            if (msg.value != 0) revert InvalidETHAmount();
        }

        euint128 encryptedAmount = FHE.asEuint128(uint128(amount));
        euint128 newBalance;
        if (depositedFlag[token][user]) {
            newBalance = FHE.add(balances[token][user], encryptedAmount);
        } else {
            newBalance = encryptedAmount;
            depositedFlag[token][user] = true;
        }
        balances[token][user] = newBalance;

        FHE.allowThis(newBalance);
        FHE.allow(newBalance, user);

        emit BalanceCredited(token);
    }

    /**
     * @notice Lock an encrypted debit for a swap (encrypted amount path — SELL)
     * @dev Locks via FHE.select at prepare time; physical transfer only after proof.
     * @return sufficiencyHandle Publicly decryptable ebool handle
     */
    function prepareDeductAuthEncrypted(
        uint256 orderId,
        address user,
        euint128 encryptedAmount,
        address token
    ) external onlyExchange whenNotPaused returns (bytes32 sufficiencyHandle) {
        if (user == address(0)) revert InvalidAddress();
        if (!tokenList.contains(token)) revert TokenNotSupported();
        bytes32 key = _deductAuthKey(msg.sender, orderId);
        if (pendingDeductAuth[key].active) revert DeductAuthAlreadyExists();

        ebool hasSufficient = FHE.le(encryptedAmount, balances[token][user]);
        euint128 debit = FHE.select(hasSufficient, encryptedAmount, FHE.asEuint128(0));

        euint128 newBalance = FHE.sub(balances[token][user], debit);
        balances[token][user] = newBalance;
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, user);

        FHE.allowThis(hasSufficient);
        FHE.makePubliclyDecryptable(hasSufficient);
        FHE.allowThis(encryptedAmount);

        pendingDeductAuth[key] = PendingDeductAuth({
            user: user,
            token: token,
            amount: 0,
            active: true,
            amountKnown: false,
            hasSufficient: hasSufficient,
            encryptedAmount: encryptedAmount
        });

        sufficiencyHandle = FHE.toBytes32(hasSufficient);
        emit DeductAuthPrepared(orderId, token, sufficiencyHandle);
    }

    /// @notice Lock an encrypted debit for a swap (plaintext amount path — BUY quote)
    function prepareDeductAuth(
        uint256 orderId,
        address user,
        uint256 amount,
        address token
    ) external onlyExchange whenNotPaused returns (bytes32 sufficiencyHandle) {
        if (user == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint128).max) revert InvalidDecryptedValue();
        if (!tokenList.contains(token)) revert TokenNotSupported();

        bytes32 key = _deductAuthKey(msg.sender, orderId);
        if (pendingDeductAuth[key].active) revert DeductAuthAlreadyExists();

        euint128 encryptedAmount = FHE.asEuint128(uint128(amount));
        ebool hasSufficient = FHE.le(encryptedAmount, balances[token][user]);
        euint128 debit = FHE.select(hasSufficient, encryptedAmount, FHE.asEuint128(0));

        euint128 newBalance = FHE.sub(balances[token][user], debit);
        balances[token][user] = newBalance;
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, user);

        FHE.allowThis(hasSufficient);
        FHE.makePubliclyDecryptable(hasSufficient);

        pendingDeductAuth[key] = PendingDeductAuth({
            user: user,
            token: token,
            amount: amount,
            active: true,
            amountKnown: true,
            hasSufficient: hasSufficient,
            encryptedAmount: encryptedAmount
        });

        sufficiencyHandle = FHE.toBytes32(hasSufficient);
        emit DeductAuthPrepared(orderId, token, sufficiencyHandle);
    }

    /**
     * @notice Finalize a deduct: verify sufficiency proof, transfer funds to the exchange
     * @dev Reverts if the proven ebool is false (lock was a zero-debit; nothing moves)
     */
    function deductBalanceWithProof(
        uint256 orderId,
        address user,
        uint256 amount,
        address token,
        bytes calldata sufficiencyCleartexts,
        bytes calldata sufficiencyProof
    ) external onlyExchange nonReentrant whenNotPaused {
        _deductWithProof(orderId, user, amount, token, sufficiencyCleartexts, sufficiencyProof);
    }

    /// @notice Finalize a deduct by vaultId (privacy-preserving calldata)
    function deductBalanceWithProofByVaultId(
        uint256 orderId,
        uint256 vaultId,
        uint256 amount,
        address token,
        bytes calldata sufficiencyCleartexts,
        bytes calldata sufficiencyProof
    ) external onlyExchange nonReentrant whenNotPaused {
        address user = vaultOwners[vaultId];
        if (user == address(0)) revert InvalidVaultId();
        _deductWithProof(orderId, user, amount, token, sufficiencyCleartexts, sufficiencyProof);
    }

    function _deductWithProof(
        uint256 orderId,
        address user,
        uint256 amount,
        address token,
        bytes calldata sufficiencyCleartexts,
        bytes calldata sufficiencyProof
    ) internal {
        if (user == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();

        bytes32 key = _deductAuthKey(msg.sender, orderId);
        PendingDeductAuth memory auth = pendingDeductAuth[key];
        if (!auth.active) revert DeductAuthNotPrepared();
        if (auth.user != user || auth.token != token) revert InvalidSufficiencyProof();
        if (auth.amountKnown && auth.amount != amount) revert DeductAmountMismatch();

        bool hasSufficient;
        if (auth.amountKnown) {
            // BUY path: only the ebool was prepared (plaintext amount already known)
            bytes32[] memory handles = new bytes32[](1);
            handles[0] = FHE.toBytes32(auth.hasSufficient);
            FHE.checkSignatures(handles, sufficiencyCleartexts, sufficiencyProof);
            hasSufficient = abi.decode(sufficiencyCleartexts, (bool));
        } else {
            // SELL path: amount + sufficiency proven together
            bytes32[] memory handles = new bytes32[](2);
            handles[0] = FHE.toBytes32(auth.encryptedAmount);
            handles[1] = FHE.toBytes32(auth.hasSufficient);
            FHE.checkSignatures(handles, sufficiencyCleartexts, sufficiencyProof);
            (uint128 decodedAmount, bool ok) = abi.decode(sufficiencyCleartexts, (uint128, bool));
            hasSufficient = ok;
            if (uint256(decodedAmount) != amount) revert DeductAmountMismatch();
        }
        if (!hasSufficient) {
            delete pendingDeductAuth[key];
            revert InsufficientEncryptedBalance();
        }

        // Effects before interactions
        delete pendingDeductAuth[key];

        if (token == NATIVE) {
            if (address(this).balance < amount) revert InsufficientBalance();
            (bool success, ) = msg.sender.call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
        }

        emit BalanceDeducted(token);
    }

    /// @notice Cancel a prepared deduct auth; homomorphic restore of the locked debit
    function cancelDeductAuth(uint256 orderId) external onlyExchange nonReentrant whenNotPaused {
        bytes32 key = _deductAuthKey(msg.sender, orderId);
        PendingDeductAuth memory auth = pendingDeductAuth[key];
        if (!auth.active) revert DeductAuthNotPrepared();

        delete pendingDeductAuth[key];

        euint128 raw = auth.amountKnown
            ? FHE.asEuint128(uint128(auth.amount))
            : auth.encryptedAmount;
        euint128 credit = FHE.select(auth.hasSufficient, raw, FHE.asEuint128(0));

        address token = auth.token;
        euint128 newBalance = FHE.add(balances[token][auth.user], credit);
        balances[token][auth.user] = newBalance;
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, auth.user);

        emit DeductAuthCancelled(orderId);
    }

    function _deductAuthKey(address exchange, uint256 orderId) private pure returns (bytes32) {
        return keccak256(abi.encode(exchange, orderId));
    }

    /// @notice Resolve vaultId to address (exchange-only, never public)
    function getAddressByVaultId(uint256 vaultId) external view onlyExchange returns (address) {
        address user = vaultOwners[vaultId];
        if (user == address(0)) revert InvalidVaultId();
        return user;
    }

    /// @notice Caller's own vaultId (off-chain view call, no on-chain trace)
    function getMyVaultId() external view returns (uint256) {
        uint256 vid = userVaultId[msg.sender];
        if (vid == 0) revert NoVaultId();
        return vid;
    }

    // ============================================
    // USER GETTERS (privacy: caller-scoped)
    // ============================================

    function getMyPendingCount() external view returns (uint256) {
        return pendingWithdrawalCount[msg.sender];
    }

    function getMyClaimableETH() external view returns (uint256) {
        return claimableETH[msg.sender];
    }

    function getWithdrawalRequest(uint256 requestId) external view returns (WithdrawalRequest memory) {
        return withdrawalRequests[requestId];
    }

    // ============================================
    // ADMIN
    // ============================================

    /// @notice Authorize or revoke an exchange contract
    function setExchange(address _exchange, bool _status) external onlyOwner {
        if (_exchange == address(0)) revert InvalidAddress();
        authorizedExchanges[_exchange] = _status;
        emit ExchangeAuthorized(_exchange, _status);
    }

    /// @notice Propose a new guardian (7-day timelock; guardian can only pause)
    function proposeGuardian(address _guardian) external onlyOwner {
        if (_guardian == address(0)) revert InvalidAddress();
        pendingGuardian = _guardian;
        guardianChangeTimestamp = block.timestamp + GUARDIAN_CHANGE_DELAY;
        emit GuardianProposed(_guardian, guardianChangeTimestamp);
    }

    function executeGuardianChange() external onlyOwner {
        if (pendingGuardian == address(0)) revert NoGuardianProposal();
        if (block.timestamp < guardianChangeTimestamp) {
            revert GuardianChangeTooEarly(guardianChangeTimestamp - block.timestamp);
        }
        address oldGuardian = guardian;
        guardian = pendingGuardian;
        pendingGuardian = address(0);
        guardianChangeTimestamp = 0;
        emit GuardianChanged(oldGuardian, guardian);
    }

    /// @notice Guardian emergency pause (cannot unpause — owner only)
    function emergencyPause() external {
        if (msg.sender != guardian) revert OnlyGuardian();
        _pause();
        emit EmergencyPauseActivated(guardian);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
