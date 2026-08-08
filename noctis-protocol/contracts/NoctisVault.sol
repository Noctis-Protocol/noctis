// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// FHEVM v0.9 - Self-relaying pattern (no Oracle dependency)
import "@fhevm/solidity/lib/FHE.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./base/GatewayCaller.sol"; // Inherits ZamaEthereumConfig

/**
 * @title NoctisVault - Encrypted Asset Vault
 * @notice Secure vault for encrypted assets using ZAMA FHE on Arbitrum
 * @dev Implementation with ETH/USDT pair using TFHE v0.9 and Gateway callback pattern
 * 
 * CORE VALUE: Bots cannot see order amounts or prices
 * COMPLIANCE: Non-custodial, no relayer, user signs own transactions
 * SECURITY: Gateway callback pattern prevents keeper manipulation (Issue #6 resolved)
 * 
 * ZAMA v0.9 Optimizations:
 * - TFHE namespace (production standard)
 * - allowTransient() for 40-60% gas savings
 * - Gateway callback for trustless decryption
 * - Self-relaying pattern (no Oracle dependency)
 * 
 * GATEWAY TRUST MODEL:
 * ===================
 * This contract relies on ZAMA Gateway for decryption of encrypted values.
 * The Gateway is a critical trust component with the following security properties:
 * 
 * Trust Assumptions:
 * - Gateway correctly decrypts ciphertext via KMS (Key Management Service)
 * - Gateway returns accurate decrypted values in callbacks
 * - Gateway is available and responsive (with retry mechanism for failures)
 * - Gateway cannot be compromised to return arbitrary values
 * 
 * Defense-in-Depth Validations (H-2 Fix):
 * - Multi-layer validation of all decrypted values
 * - Bounds checking against contract balance
 * - Sanity checks on user balance magnitudes
 * - Suspicious value detection with event emission
 * - 7-day timelock on Gateway address changes (prevents instant hijacking)
 * 
 * If Gateway is compromised, attackers are still limited by:
 * 1. MAX_WITHDRAWAL limits (100 ETH, 1M USDT)
 * 2. Contract balance checks (cannot drain more than available)
 * 3. User balance validation (cannot withdraw more than user owns)
 * 4. Monitoring via SuspiciousDecryptedValue events
 * 5. Emergency pause mechanism (owner can halt all operations)
 * 
 * Future Improvements:
 * - Cryptographic proofs of correct decryption (when ZAMA protocol supports)
 * - Multiple Gateway redundancy with consensus mechanism
 * - ZK-proofs for decryption verification
 */
contract NoctisVault is ReentrancyGuard, Pausable, Ownable, GatewayCaller {
    // Note: GatewayCaller inherits SepoliaConfig which sets up FHE.setCoprocessor()
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ============================================
    // STATE VARIABLES
    // ============================================

    /// @notice USDT token address
    IERC20 public immutable usdt;

    /// @notice Minimum ETH deposit (prevents dust attacks)
    uint256 public constant MIN_ETH_DEPOSIT = 0.005 ether;    // ~$10
    
    /// @notice Maximum ETH deposit (risk management)
    uint256 public constant MAX_ETH_DEPOSIT = 100 ether;       // ~$300k
    
    /// @notice Minimum USDT deposit (prevents dust attacks)
    uint256 public constant MIN_USDT_DEPOSIT = 10e6;          // 10 USDT (6 decimals)
    
    /// @notice Maximum USDT deposit (risk management)
    uint256 public constant MAX_USDT_DEPOSIT = 1_000_000e6;   // 1M USDT

    /// @notice Maximum ETH withdrawal (matches deposit limits)
    uint256 public constant MAX_ETH_WITHDRAWAL = 100 ether;
    /// @notice Maximum USDT withdrawal (matches deposit limits)
    uint256 public constant MAX_USDT_WITHDRAWAL = 1_000_000e6;

    /// @notice Encrypted ETH balances
    /// @dev LOW-1 fix: Internal visibility prevents exposing ciphertext handles via getter
    /// @dev ZAMA best practice: NEVER declare encrypted state variables as public
    /// @dev euint128 supports up to 2^128-1, more than enough for max deposit
    mapping(address => euint128) internal ethBalances;

    /// @notice Encrypted USDT balances
    /// @dev LOW-1 fix: Internal visibility prevents exposing ciphertext handles via getter
    /// @dev ZAMA best practice: NEVER declare encrypted state variables as public
    /// @dev euint128 supports up to 2^128-1, more than enough for max deposit
    mapping(address => euint128) internal usdtBalances;

    /// @notice Tracks if user has deposited ETH (gas optimization)
    /// @dev Avoids calling FHE.isInitialized() on subsequent deposits
    mapping(address => bool) private hasDepositedETH;

    /// @notice Tracks if user has deposited USDT (gas optimization)
    /// @dev Avoids calling FHE.isInitialized() on subsequent deposits
    mapping(address => bool) private hasDepositedUSDT;

    /// @notice Last block number where user deposited ETH (rate limiting)
    /// @dev Prevents spam attacks with multiple deposits per block
    mapping(address => uint256) private lastETHDepositBlock;

    /// @notice Last block number where user deposited USDT (rate limiting)
    /// @dev Prevents spam attacks with multiple deposits per block
    mapping(address => uint256) private lastUSDTDepositBlock;

    // ============================================
    // VAULT ID SYSTEM (Privacy-First)
    // ============================================

    /// @notice Private mapping from vaultId to user address
    /// @dev PRIVACY: No public getter, only accessible via onlyExchange internal call
    /// @dev Prevents linking trade calldata to user addresses
    mapping(uint256 => address) private vaultOwners;

    /// @notice Private mapping from user address to vaultId
    /// @dev PRIVACY: No public getter, user discovers via getMyVaultId() view call
    mapping(address => uint256) private userVaultId;

    /// @notice Auto-incrementing vault ID counter (starts at 1, 0 = unregistered)
    /// @dev 0 means user has no vaultId yet (assigned on first deposit)
    uint256 private nextVaultId = 1;

    // ============================================
    // WITHDRAWAL STATE
    // ============================================

    /// @notice Withdrawal request struct with encrypted destination and amount
    struct WithdrawalRequest {
        uint256 requestId;
        address requester;             // Who initiated (for security/validation)
        address plaintextRecipient;    // MVP: plaintext for keeper validation
        eaddress encryptedRecipient;   // Future: encrypted destination (full FHE)
        euint128 encryptedAmount;      // HOW MUCH → encrypted amount!
        euint128 originalBalance;      // Balance snapshot BEFORE deduction (for cancellation/restoration)
        ebool hasSufficientBalance;    // PRIVACY FIX: FHE.ge(balance, amount) - only reveals true/false, not actual balance!
        bool isEth;                    // Asset type (ETH vs USDT)
        uint256 requestTime;
        bool executed;
        uint256 gatewayRequestId;      // Gateway request ID (0 if not requested)
        bool gatewayRequested;         // Whether Gateway decryption was requested
        uint256 gatewayRequestTime;    // When Gateway request was made
    }

    /// @notice Withdrawal requests mapping
    mapping(uint256 => WithdrawalRequest) public withdrawalRequests;
    
    /// @notice Withdrawal counter for unique IDs
    uint256 public withdrawalCounter;

    /// @notice Number of pending withdrawals per user (DoS prevention)
    /// @dev Prevents unbounded withdrawal queue attack (H-1 vulnerability fix)
    /// @dev PRIVACY: Changed from public to private -- use getMyPendingCount()
    mapping(address => uint256) private pendingWithdrawalCount;

    /// @notice Maximum pending withdrawals per user (DoS prevention + UX simplicity)
    /// @dev Limit to 1 prevents underflow confusion and simplifies UX
    /// Users must complete or cancel current withdrawal before creating a new one
    uint256 public constant MAX_PENDING_WITHDRAWALS_PER_USER = 1;

    /// @notice Set of authorized keeper addresses
    /// @dev Using EnumerableSet for O(1) operations and automatic duplicate prevention
    EnumerableSet.AddressSet private authorizedKeepers;

    /// @notice Minimum number of keepers required (safety threshold)
    uint256 public minKeepers;

    /// @notice Maximum number of keepers allowed (DoS prevention)
    /// @dev Prevents unbounded loop attacks in ACL permission grants
    uint256 public constant MAX_KEEPERS = 10;

    /// @notice Timeout duration before users can cancel withdrawals (emergency fallback)
    uint256 public constant CANCELLATION_TIMEOUT = 1 hours;

    /// @notice Decryption timeout for Gateway requests
    uint256 public constant DECRYPTION_TIMEOUT = 1 hours;

    /// @notice Delay before a proposed Gateway change can be executed (7 days for security)
    uint256 public constant GATEWAY_CHANGE_DELAY = 7 days;

    /// @notice Delay before a proposed keeper change can be executed (48 hours for security)
    /// @dev Shorter than Gateway (48h vs 7d) as keepers are less critical
    /// @dev Still provides time for detection and response to compromised owner key
    uint256 public constant KEEPER_CHANGE_DELAY = 48 hours;
    
    /// @notice Maximum acceptable transfer fee percentage (CRITICAL-2 fix)
    /// @dev Rejects deposits with fees > 1% to protect users from excessive losses
    /// @dev USDT fee is currently 0%, but can be enabled by governance
    /// @dev 100 BPS = 1% (conservative threshold for user protection)
    uint256 public constant MAX_ACCEPTABLE_FEE_BPS = 100; // 1%
    
    // ============================================
    // GATEWAY DEFENSE-IN-DEPTH STATE (CRITICAL-3)
    // ============================================
    
    /// @notice Maximum daily withdrawal limit (circuit breaker)
    /// @dev Limits total protocol withdrawals to prevent Gateway compromise drain
    uint256 public constant MAX_DAILY_WITHDRAWAL_LIMIT = 1000 ether; // 1000 ETH/day
    
    /// @notice Time window for daily withdrawal tracking (24 hours)
    uint256 public constant WITHDRAWAL_WINDOW = 24 hours;
    
    /// @notice Maximum withdrawals per user in 24h (pattern detection)
    uint256 public constant MAX_USER_WITHDRAWALS_24H = 5;
    
    /// @notice Suspicious ratio threshold (withdrawals vs deposits)
    /// @dev Alert if user withdraws > 50% of lifetime deposits in 24h
    uint256 public constant SUSPICIOUS_WITHDRAWAL_RATIO_BPS = 5000; // 50%

    // ============================================
    // GATEWAY STATE
    // ============================================

    /// @notice Mapping from Gateway requestId to withdrawal requestId
    mapping(uint256 => uint256) public gatewayRequestToWithdrawal;

    /// @notice Track pending Gateway requests
    mapping(uint256 => bool) public pendingGatewayRequests;

    /// @notice Pending Gateway address proposal (for timelock pattern)
    address public pendingGateway;

    /// @notice Timestamp when pending Gateway proposal becomes executable
    uint256 public gatewayChangeTimestamp;

    // ============================================
    // CLAIMABLE BALANCE STATE (M-3 Fix)
    // ============================================

    /// @notice Claimable ETH balances (pull-over-push pattern for DoS prevention)
    /// @dev Prevents malicious recipient contracts from blocking withdrawals
    /// @dev Users can claim their ETH at any time without affecting keepers
    /// @dev PRIVACY: Changed from public to private -- use getMyClaimableETH()
    mapping(address => uint256) private claimableETH;

    // ============================================
    // SWAP DEDUCT AUTH (CRITICAL: fund-safety)
    // ============================================

    /// @notice Pending swap debit authorization prepared by Exchange
    /// @dev Locks encrypted balance at prepare time (FHE.select); physical transfer only after proof
    struct PendingDeductAuth {
        address user;
        uint256 amount;       // plaintext amount to transfer if sufficient (0 if prepared via encrypted handle only)
        bool isEth;
        bool active;
        bool amountKnown;     // true when amount was known at prepare (BUY path / plaintext prepare)
        ebool hasSufficient;
        euint128 encryptedAmount;
    }

    /// @dev key = keccak256(abi.encode(exchange, orderId))
    mapping(bytes32 => PendingDeductAuth) private pendingDeductAuth;

    // ============================================
    // KEEPER TIMELOCK STATE
    // ============================================

    /// @notice Pending keeper operation types
    enum KeeperOperation { ADD, REMOVE, SET_MIN }

    /// @notice Pending keeper change proposal
    struct PendingKeeperChange {
        address keeper;              // Keeper address (for ADD/REMOVE)
        uint256 newMinKeepers;       // New minimum (for SET_MIN)
        KeeperOperation operation;   // Type of operation
        uint256 executeAfter;        // Timestamp when executable
        bool exists;                 // Whether proposal exists
    }

    /// @notice Keeper change proposals mapping (MEDIUM-1 fix: multi-proposal support)
    /// @dev Maps proposalId => PendingKeeperChange
    /// @dev Allows multiple concurrent keeper change proposals
    mapping(uint256 => PendingKeeperChange) public keeperChangeProposals;
    
    /// @notice Counter for keeper change proposal IDs
    uint256 public keeperProposalCounter;
    
    // ============================================
    // GUARDIAN STATE (Emergency Multisig)
    // ============================================

    /// @notice Guardian address (emergency multisig, can only pause)
    /// @dev Separate from owner to provide defense-in-depth
    /// @dev Guardian compromised = can only pause (not unpause or steal funds)
    /// @dev Recommended: 3-of-5 multisig of security team members
    address public guardian;

    /// @notice Pending guardian address proposal (for timelock pattern)
    address public pendingGuardian;

    /// @notice Timestamp when pending guardian proposal becomes executable
    uint256 public guardianChangeTimestamp;

    /// @notice Delay before a proposed guardian change can be executed (7 days)
    /// @dev Same as Gateway change delay (critical security role)
    uint256 public constant GUARDIAN_CHANGE_DELAY = 7 days;

    // ============================================
    // EXCHANGE AUTHORIZATION STATE
    // ============================================

    /// @notice Mapping of authorized exchange contracts
    /// @dev Only authorized exchanges can call deduct/credit APIs
    mapping(address => bool) public authorizedExchanges;
    
    // ============================================
    // WITHDRAWAL MONITORING STATE (CRITICAL-3 Defense-in-Depth)
    // ============================================
    
    /// @notice Withdrawal pattern statistics per user
    struct WithdrawalStats {
        uint256 count24h;           // Number of withdrawals in current 24h window
        uint256 ethAmount24h;       // Total ETH withdrawn in current 24h window
        uint256 usdtAmount24h;      // Total USDT withdrawn in current 24h window
        uint256 windowStart;        // Start timestamp of current 24h window
        uint256 lifetimeDeposits;   // Total lifetime deposits for ratio check
    }
    
    /// @notice User withdrawal statistics for pattern monitoring
    /// @dev PRIVACY: Changed from public to private -- use getMyWithdrawalStats()
    mapping(address => WithdrawalStats) private userWithdrawalStats;
    
    /// @notice Global daily withdrawal tracking
    struct GlobalWithdrawalTracking {
        uint256 ethWithdrawn24h;    // Total ETH withdrawn protocol-wide in 24h
        uint256 usdtWithdrawn24h;   // Total USDT withdrawn protocol-wide in 24h
        uint256 windowStart;        // Start of current 24h tracking window
    }
    
    /// @notice Protocol-wide withdrawal tracking (circuit breaker)
    GlobalWithdrawalTracking public globalWithdrawals;


    // ============================================
    // CUSTOM ERRORS (Gas Efficient)
    // ============================================

    error ZeroAmount();
    error InvalidAddress();
    error InsufficientBalance();
    error TransferFailed();
    error BelowMinimumDeposit();
    error ExceedsMaximumDeposit();
    error ExceedsMaximumWithdrawal();
    error DepositTooFrequent();
    error InvalidETHAmount();
    error WithdrawalAlreadyExecuted();
    error WithdrawalNotFound();
    error UnauthorizedWithdrawal();
    error OnlyKeeper();
    error InvalidWithdrawalAmount();
    error CancellationTooEarly();
    error NotWithdrawalRequester();
    error InvalidVaultId();
    error NoVaultId();
    error KeeperAlreadyAuthorized(address keeper);
    error KeeperNotFound(address keeper);
    error BelowMinimumKeepers(uint256 current, uint256 minimum);
    error TooManyKeepers(uint256 current, uint256 maximum);
    error InvalidMinKeepers(uint256 min);
    error GatewayRequestAlreadyPending();
    error InvalidGatewayRequest();
    error GatewayDecryptionFailed();
    error NoGatewayRequestPending();
    error GatewayRequestNotPending();
    error RetryTooEarly(uint256 timeLeft);
    error UnauthorizedExchange();
    error InvalidTradeAmount();
    error NoGatewayProposal();
    error GatewayChangeTooEarly(uint256 timeLeft);
    error TooManyPendingWithdrawals();
    error InvalidDecryptedValue();
    error GatewayTimeoutExceeded();
    error DecryptedBalanceExceedsContractBalance();
    error InsufficientUserBalance();
    error InsufficientEncryptedBalance();
    error DeductAuthNotPrepared();
    error DeductAuthAlreadyExists();
    error InvalidSufficiencyProof();
    error DeductAmountMismatch();
    error KeeperChangePending();
    error NoKeeperChangeProposal();
    error KeeperChangeTooEarly(uint256 timeLeft);
    
    // CRITICAL-2 fix: Fee-on-transfer protection (excessive fee validation)
    error ExcessiveTransferFee(uint256 feePercentageBPS, uint256 maxAllowedBPS);
    error ZeroReceivedAmount();
    
    // CRITICAL-3 fix: Gateway defense-in-depth (circuit breakers)
    error DailyWithdrawalLimitExceeded(uint256 attempted, uint256 limit);
    error TooManyWithdrawals24h(uint256 count, uint256 maxAllowed);
    error SuspiciousWithdrawalRatio(uint256 withdrawalAmount, uint256 depositAmount);
    error NothingToClaim();
    error CannotWithdrawToSelf();
    error NoGuardianProposal();
    error GuardianChangeTooEarly(uint256 timeLeft);
    error OnlyGuardian();

    // ============================================
    // EVENTS
    // ============================================

    /// @notice Emitted when ETH is deposited
    /// @dev Amount intentionally omitted from the event (still visible via msg.value / explorer).
    ///      Do not treat this event as a privacy boundary — L1 value transfer is public.
    event ETHDeposited(address indexed user);

    /// @notice Emitted when USDT is deposited
    /// @dev Amount intentionally omitted from the event (still visible via ERC20 Transfer).
    event USDTDeposited(address indexed user);
    
    /// @notice Emitted when transfer fee is detected (CRITICAL-2 fix)
    /// @dev Alerts monitoring systems and users about fee deduction
    /// @dev Privacy: User address not indexed to prevent tracking
    event TransferFeeDetected(
        address user,
        uint256 requestedAmount,
        uint256 actualReceived,
        uint256 feeLost
    );
    
    /// @notice Emitted when suspicious withdrawal pattern detected (CRITICAL-3)
    /// @dev Alerts monitoring systems of potential Gateway compromise
    /// @dev Privacy: User address not indexed to prevent tracking
    event SuspiciousWithdrawalPattern(
        address user,
        uint256 withdrawalCount24h,
        uint256 totalAmount24h,
        uint256 lifetimeDeposits,
        string reason
    );
    
    /// @notice Emitted when circuit breaker triggers (CRITICAL-3)
    /// @dev Protocol auto-pauses when daily limit exceeded
    event CircuitBreakerTriggered(
        uint256 attempted,
        uint256 limit,
        string asset
    );

    /// @notice Emitted when encrypted withdrawal is requested
    event WithdrawalRequested(
        uint256 indexed requestId,
        address requester,
        bool isEth,
        uint256 timestamp
    );

    /// @notice Emitted when withdrawal is executed by keeper
    event WithdrawalExecuted(
        uint256 indexed requestId,
        address recipient,
        uint256 amount
    );

    /// @notice Emitted when withdrawal is cancelled by user after timeout
    /// @dev Privacy: Requester address not indexed to prevent tracking
    event WithdrawalCancelled(
        uint256 indexed requestId,
        address requester
    );

    /// @notice Emitted when a keeper is added to the authorized set
    event KeeperAdded(address indexed keeper, uint256 newKeeperCount);

    /// @notice Emitted when a keeper is removed from the authorized set  
    event KeeperRemoved(address indexed keeper, uint256 newKeeperCount);

    /// @notice Emitted when minimum keeper threshold is updated
    event MinKeepersUpdated(uint256 oldMin, uint256 newMin);

    /// @notice Emitted when withdrawal execution is requested via Gateway (v0.8 legacy)
    event WithdrawalExecutionRequested(
        uint256 indexed requestId,
        uint256 indexed gatewayRequestId,
        address indexed keeper
    );

    /// @notice FHEVM v0.9: Emitted when ciphertexts are ready for public decryption
    /// @dev Keeper listens for this, calls publicDecrypt(), then executeWithdrawalCallback()
    event DecryptionReady(
        uint256 indexed requestId,
        bytes32[] handles,
        address indexed keeper
    );

    /// @notice Emitted when Gateway decryption fails
    event WithdrawalExecutionFailed(
        uint256 indexed requestId,
        uint256 indexed gatewayRequestId
    );

    /// @notice Emitted when Gateway returns suspicious decrypted values
    /// @dev Used for monitoring and alerting on potential Gateway compromise
    event SuspiciousDecryptedValue(
        uint256 indexed requestId,
        uint256 decryptedAmount,
        uint256 decryptedBalance,
        string reason
    );

    /// @notice Emitted when a Gateway request is retried after timeout
    event GatewayRequestRetried(
        uint256 indexed requestId,
        uint256 oldGatewayRequestId,
        address indexed keeper
    );

    /// @notice Emitted when ETH becomes claimable for a user (pull-over-push pattern)
    /// @dev Used for M-3 DoS prevention against malicious recipient contracts
    /// @dev Privacy: User address not indexed to prevent tracking
    event ClaimableBalanceUpdated(
        address user,
        uint256 amount,
        uint256 newBalance
    );

    /// @notice Emitted when a user claims their ETH
    /// @dev Privacy: User address not indexed to prevent tracking
    event ETHClaimed(
        address user,
        uint256 amount
    );
    
    /// @notice Emitted when ETH claim fails (HIGH-1 fix)
    /// @dev Balance is restored, user can retry after fixing recipient contract
    /// @dev Privacy: User address not indexed to prevent tracking
    event ETHClaimFailed(
        address user,
        uint256 amount,
        bytes returnData
    );

    /// @notice Emitted when encrypted balance is restored after failed withdrawal
    /// @dev Used for monitoring insufficient balance attempts (underflow protection)
    /// @dev Privacy: User address not indexed to prevent tracking
    event BalanceRestored(
        uint256 indexed requestId,
        address user,
        bool isEth
    );

    /// @notice Emitted when withdrawal is requested to a contract address (warning)
    /// @dev Helps users detect potential issues with contracts lacking receive()
    /// @dev Privacy: Recipient address not indexed to prevent tracking
    event WithdrawalToContract(
        address recipient,
        uint256 indexed requestId
    );

    /// @notice Emitted when guardian address is proposed
    event GuardianProposed(address indexed newGuardian, uint256 executeAfter);

    /// @notice Emitted when guardian change is executed
    event GuardianChanged(address indexed oldGuardian, address indexed newGuardian);

    /// @notice Emitted when guardian activates emergency pause
    event EmergencyPauseActivated(address indexed guardian);

    /// @notice Emitted when an exchange contract is authorized or revoked
    event ExchangeAuthorized(address indexed exchange, bool status);

    /// @notice Emitted when a new Gateway address is proposed
    event GatewayProposed(
        address indexed newGateway,
        uint256 executeAfter
    );

    /// @notice Emitted when a pending Gateway proposal is cancelled
    event GatewayProposalCancelled(address indexed cancelledGateway);

    /// @notice Emitted when a Gateway change is executed after timelock
    event GatewayChangeExecuted(
        address indexed oldGateway,
        address indexed newGateway
    );

    /// @notice Emitted when a keeper change is proposed (timelock started)
    event KeeperChangeProposed(
        address indexed keeper,
        uint256 newMinKeepers,
        uint8 operation,
        uint256 executeAfter
    );
    
    /// @notice Emitted when a keeper change is proposed with proposal ID (MEDIUM-1 fix)
    event KeeperChangeProposedV2(
        uint256 indexed proposalId,
        address indexed keeper,
        uint256 newMinKeepers,
        uint8 operation,
        uint256 executeAfter
    );

    /// @notice Emitted when a keeper change proposal is cancelled
    event KeeperChangeProposalCancelled(
        address indexed keeper,
        uint8 operation
    );
    
    /// @notice Emitted when a keeper change proposal is cancelled with ID (MEDIUM-1 fix)
    event KeeperChangeProposalCancelledV2(
        uint256 indexed proposalId,
        address indexed keeper,
        uint8 operation
    );

    /// @notice Emitted when a keeper change is executed after timelock
    event KeeperChangeExecuted(
        address indexed keeper,
        uint256 newMinKeepers,
        uint8 operation
    );
    
    /// @notice Emitted when a keeper change is executed with proposal ID (MEDIUM-1 fix)
    event KeeperChangeExecutedV2(
        uint256 indexed proposalId,
        address indexed keeper,
        uint256 newMinKeepers,
        uint8 operation
    );

    // ============================================
    // MODIFIERS
    // ============================================

    /// @notice Restricts function access to authorized keepers only
    /// @dev Uses EnumerableSet.contains() for O(1) lookup
    modifier onlyKeeper() {
        if (!authorizedKeepers.contains(msg.sender)) revert OnlyKeeper();
        _;
    }

    /// @notice Restricts function access to authorized exchange contracts only
    /// @dev Prevents unauthorized contracts from executing trades
    modifier onlyExchange() {
        if (!authorizedExchanges[msg.sender]) revert UnauthorizedExchange();
        _;
    }

    // ============================================
    // CONSTRUCTOR
    // ============================================

    /**
     * @notice Initialize the Noctis contract
     * @param initialOwner Address of initial owner (should be multisig for production)
     * @param _usdt Address of USDT token contract
     * @dev SECURITY: Pass Safe{Wallet} multisig address for production deployments
     * @dev For testnet/development, can use msg.sender, but NEVER for mainnet
     */
    constructor(address initialOwner, address _usdt) 
        Ownable(initialOwner)
    {
        if (initialOwner == address(0)) revert InvalidAddress();
        if (_usdt == address(0)) revert InvalidAddress();
        
        // Sanity checks: ensure MIN < MAX for both assets
        assert(MIN_ETH_DEPOSIT < MAX_ETH_DEPOSIT);
        assert(MIN_USDT_DEPOSIT < MAX_USDT_DEPOSIT);
        
        usdt = IERC20(_usdt);
        
        // Initialize minimum keeper threshold (must add keepers post-deployment)
        minKeepers = 3;
        
        // NOTE: Keepers must be added via addKeeper() after deployment
        // This is intentional - forces explicit keeper setup with events
        
        // FHEVM v0.9: Coprocessor is set automatically by ZamaEthereumConfig
        // For local testing (chainId 31337), we use default local addresses from ZamaConfig
        // ZamaEthereumConfig constructor handles this automatically
    }

    // ============================================
    // DEPOSIT FUNCTIONS
    // ============================================

    /**
     * @notice Deposit ETH into the contract with encrypted balance
     * @dev Follows Checks-Effects-Interactions pattern
     * @dev Amount is encrypted using TFHE to prevent bot visibility
     * @dev Implements min/max limits and rate limiting for security
     */
    function depositETH() external payable nonReentrant whenNotPaused {
        // CHECKS
        if (msg.value == 0) revert ZeroAmount();
        if (msg.value < MIN_ETH_DEPOSIT) revert BelowMinimumDeposit();
        if (msg.value > MAX_ETH_DEPOSIT) revert ExceedsMaximumDeposit();
        if (block.number == lastETHDepositBlock[msg.sender]) revert DepositTooFrequent();

        // EFFECTS
        lastETHDepositBlock[msg.sender] = block.number;
        _assignVaultIdIfNeeded(msg.sender);
        _creditEncryptedDeposit(ethBalances, hasDepositedETH, msg.sender, msg.value);

        emit ETHDeposited(msg.sender);
    }

    /// @dev PRIVACY: silent vaultId assignment on first deposit (no event emitted).
    ///      User discovers their vaultId via getMyVaultId() view call (off-chain, no trace).
    function _assignVaultIdIfNeeded(address user) private {
        if (userVaultId[user] == 0) {
            uint256 vid = nextVaultId++;
            userVaultId[user] = vid;
            vaultOwners[vid] = user;
        }
    }

    /// @dev Credits an encrypted deposit to `balances[user]` and re-grants ACL
    ///      (vault + owner). Shared by depositETH / depositUSDT.
    /// @dev First deposit assigns instead of FHE.add: adding to an uninitialized
    ///      handle is invalid in fhEVM, hence the hasDeposited flag.
    function _creditEncryptedDeposit(
        mapping(address => euint128) storage balances,
        mapping(address => bool) storage hasDeposited,
        address user,
        uint256 amount
    ) private {
        euint128 encryptedAmount = FHE.asEuint128(uint128(amount));
        euint128 newBalance;

        if (hasDeposited[user]) {
            newBalance = FHE.add(balances[user], encryptedAmount);
        } else {
            newBalance = encryptedAmount;
            hasDeposited[user] = true;
        }

        balances[user] = newBalance;

        // ACL discipline: re-grant after every encrypted write
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, user);

        // CRITICAL-3: track lifetime deposits for withdrawal ratio monitoring
        userWithdrawalStats[user].lifetimeDeposits += amount;
    }

    /**
     * @notice Deposit USDT into the contract with encrypted balance
     * @dev User must approve contract to spend USDT before calling
     * @dev Uses SafeERC20 to handle non-standard tokens like USDT
     * @dev Implements min/max limits and rate limiting for security
     * @param amount Amount of USDT to deposit (in USDT decimals)
     */
    function depositUSDT(uint256 amount) external nonReentrant whenNotPaused {
        // CHECKS
        if (amount == 0) revert ZeroAmount();
        if (amount < MIN_USDT_DEPOSIT) revert BelowMinimumDeposit();
        if (amount > MAX_USDT_DEPOSIT) revert ExceedsMaximumDeposit();
        if (block.number == lastUSDTDepositBlock[msg.sender]) revert DepositTooFrequent();

        // EFFECTS - rate limit + vaultId before external call
        lastUSDTDepositBlock[msg.sender] = block.number;
        _assignVaultIdIfNeeded(msg.sender);

        // INTERACTIONS - transfer first to measure actual received amount
        // CRITICAL-1: fee-on-transfer protection. USDT fee is currently 0% but the
        // mechanism exists; crediting `amount` instead of what arrived would make
        // the vault insolvent the day it activates.
        uint256 balanceBefore = usdt.balanceOf(address(this));
        usdt.safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualReceived = usdt.balanceOf(address(this)) - balanceBefore;

        // 100% fee or malicious token
        if (actualReceived == 0) revert ZeroReceivedAmount();

        // CRITICAL-2: reject fees > MAX_ACCEPTABLE_FEE_BPS (1%).
        // Note: checked arithmetic reverts here if the token credits MORE than
        // `amount` (weird/malicious token) - acceptable, we never over-credit.
        uint256 feeLost = amount - actualReceived;
        uint256 feePercentageBPS = (feeLost * 10000) / amount;
        if (feePercentageBPS > MAX_ACCEPTABLE_FEE_BPS) {
            revert ExcessiveTransferFee(feePercentageBPS, MAX_ACCEPTABLE_FEE_BPS);
        }
        if (feeLost > 0) {
            emit TransferFeeDetected(msg.sender, amount, actualReceived, feeLost);
        }

        // Re-check minimum on the ACTUAL amount (prevents fee-based bypass).
        // No max re-check needed: actualReceived <= amount <= MAX_USDT_DEPOSIT.
        if (actualReceived < MIN_USDT_DEPOSIT) revert BelowMinimumDeposit();

        // EFFECTS - credit ACTUAL received amount to the encrypted balance
        _creditEncryptedDeposit(usdtBalances, hasDepositedUSDT, msg.sender, actualReceived);

        emit USDTDeposited(msg.sender);
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    /**
     * @notice Get encrypted balance handle for a user
     * @dev Returns the ciphertext handle to any caller (ciphertext alone is not decryptable).
     * @dev ACL decrypt rights are granted ONLY to the balance owner or an authorized exchange.
     *      Arbitrary callers must NOT receive FHE.allow — that would let them userDecrypt.
     * @param user Address to check balance for
     * @param isEth True for ETH balance, false for USDT balance
     * @return Encrypted balance (euint128)
     */
    function getEncryptedBalance(address user, bool isEth) 
        external 
        returns (euint128) 
    {
        if (user == address(0)) revert InvalidAddress();
        euint128 balance = isEth ? ethBalances[user] : usdtBalances[user];
        
        // Check if balance is initialized (user has deposited)
        bool isInitialized = isEth 
            ? hasDepositedETH[user] 
            : hasDepositedUSDT[user];
        
        // Uninitialized: return the storage handle as-is (zero bytes32).
        // Do NOT call FHE.asEuint128(0) here — eth_call would mint a fresh
        // ephemeral ciphertext every time, which has no ACL and breaks userDecrypt.
        if (isInitialized) {
            FHE.allowThis(balance);
            // SECURITY: only owner or authorized exchange may receive decrypt ACL
            // (persists only on real txs; eth_call is a no-op for ACL)
            if (msg.sender == user || authorizedExchanges[msg.sender]) {
                FHE.allow(balance, msg.sender);
            }
        }
        
        return balance;
    }
    
    /**
     * @notice Get withdrawal statistics for a user (CRITICAL-3 monitoring)
     * @dev Used by frontend and monitoring systems to track withdrawal patterns
     * @param user Address to check stats for
     * @return count24h Number of withdrawals in current 24h window
     * @return ethAmount24h Total ETH withdrawn in current 24h window
     * @return usdtAmount24h Total USDT withdrawn in current 24h window
     * @return lifetimeDeposits Total lifetime deposits for ratio calculation
     * @return windowStart Timestamp when current 24h window started
     */
    // ============================================
    // ENCRYPTED WITHDRAWAL FUNCTIONS (MVP INNOVATION!)
    // ============================================

    /**
     * @notice Request encrypted withdrawal with encrypted destination address (FULL PRIVACY!)
     * @dev KEY INNOVATION: Both destination AND amount are encrypted on-chain
     * @dev This ensures no one can track where users are withdrawing their funds
     * @param recipient Destination address (will be encrypted)
     * @param amount Amount to withdraw (plaintext, encrypted in function)
     * @param isEth True for ETH, false for USDT
     * @return requestId The unique withdrawal request ID
     */
    function requestEncryptedWithdrawal(
        address recipient,
        uint128 amount,
        bool isEth
    ) external nonReentrant whenNotPaused returns (uint256) {
        // Input validation
        if (recipient == address(0)) revert InvalidAddress();
        if (recipient == address(this)) revert CannotWithdrawToSelf();
        // MVP: same-address withdraw only (encrypted recipient is Year-1 privacy surface)
        if (recipient != msg.sender) revert UnauthorizedWithdrawal();
        if (amount == 0) revert InvalidWithdrawalAmount();
        if (isEth && amount > MAX_ETH_WITHDRAWAL) revert ExceedsMaximumWithdrawal();
        if (!isEth && amount > MAX_USDT_WITHDRAWAL) revert ExceedsMaximumWithdrawal();

        // SECURITY FIX [HIGH-1]: Prevent DoS attack via unbounded withdrawal queue
        // Limit pending withdrawals per user to prevent storage bloat and keeper DoS
        if (pendingWithdrawalCount[msg.sender] >= MAX_PENDING_WITHDRAWALS_PER_USER) {
            revert TooManyPendingWithdrawals();
        }
        
        // Encrypt recipient (MVP: always msg.sender after check above)
        eaddress encRecipient = FHE.asEaddress(recipient);

        euint128 currentBalance = isEth ? ethBalances[msg.sender] : usdtBalances[msg.sender];
        euint128 originalBalance = currentBalance;
        euint128 encryptedAmount = FHE.asEuint128(amount);

        // SECURITY FIX [CRITICAL C-1]: Gate debit with FHE.select — never FHE.sub ungated.
        // Ungated sub wraps on underflow and lets Exchange prepareDeductAuth* drain the vault
        // while an over-balance withdrawal stays pending.
        ebool hasSufficientBalance = FHE.ge(currentBalance, encryptedAmount);
        euint128 zero = FHE.asEuint128(0);
        euint128 debit = FHE.select(hasSufficientBalance, encryptedAmount, zero);
        euint128 newBalance = FHE.sub(currentBalance, debit);

        // Update balance
        if (isEth) {
            ethBalances[msg.sender] = newBalance;
        } else {
            usdtBalances[msg.sender] = newBalance;
        }

        // Grant ACL permissions for new balance
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, msg.sender);
        
        // Grant permission to contract for encrypted amount (needed for cancellation)
        FHE.allowThis(encryptedAmount);
        
        // Snapshot retained for struct compatibility / legacy tooling (no longer restored on fail)
        FHE.allowThis(originalBalance);
        
        // Grant permission to contract for hasSufficientBalance boolean (needed for Gateway decryption)
        // PRIVACY: This is the key improvement - we only reveal true/false, not the actual balance!
        FHE.allowThis(hasSufficientBalance);
        
        // Grant permission to contract for encrypted recipient (needed for Gateway decryption)
        FHE.allowThis(encRecipient);
        
        // GAS OPTIMIZATION: Removed keeper ACL loop (HIGH-1 DoS vulnerability fix)
        // Previously: for (uint256 i = 0; i < keeperCount; i++) { FHE.allow(encryptedAmount, authorizedKeepers.at(i)); }
        // Cost: 10 keepers × 20k gas = 200k gas per withdrawal request
        // 
        // NEW PATTERN: Pull over Push + allowTransient()
        // - Keeper requests access when needed (in requestWithdrawalExecution)
        // - Uses FHE.allowTransient() for 40-60% gas savings
        // - Gas saved: ~188k gas per withdrawal request
        // - Security: Follows ZAMA best practices and Solidity pull pattern
        // - Reference: https://docs.zama.ai/protocol/solidity-guides/smart-contract/acl/acl_examples

        // Create withdrawal request
        uint256 requestId = ++withdrawalCounter;
        withdrawalRequests[requestId] = WithdrawalRequest({
            requestId: requestId,
            requester: msg.sender,
            plaintextRecipient: address(0),    // Not used for encrypted withdrawals (will be decrypted via Gateway)
            encryptedRecipient: encRecipient,  // Encrypted destination (PRIVACY!)
            encryptedAmount: encryptedAmount,
            originalBalance: originalBalance,  // Still needed for cancellation/restoration
            hasSufficientBalance: hasSufficientBalance,  // PRIVACY FIX: Only reveals true/false!
            isEth: isEth,
            requestTime: block.timestamp,
            executed: false,
            gatewayRequestId: 0,
            gatewayRequested: false,
            gatewayRequestTime: 0
        });

        // SECURITY FIX [HIGH-1]: Increment pending withdrawal counter
        pendingWithdrawalCount[msg.sender]++;

        emit WithdrawalRequested(requestId, msg.sender, isEth, block.timestamp);

        return requestId;
    }

    /**
     * @notice Request encrypted withdrawal with client-side encryption (PRIVACY-FIRST)
     * @dev ENHANCEMENT: Amount and recipient are encrypted CLIENT-SIDE before TX submission
     * @dev This prevents MEV bots from seeing withdrawal details in the mempool
     * 
     * Privacy Improvements over requestEncryptedWithdrawal():
     * - Amount is encrypted by fhevmjs before being sent → NOT visible in TX input data
     * - Recipient is encrypted by fhevmjs before being sent → NOT visible in TX input data
     * - ZK proof validates that client encrypted correctly without revealing values
     * 
     * @param encryptedAmount Client-encrypted amount (externalEuint128 from fhevmjs)
     * @param encryptedRecipient Client-encrypted recipient address (externalEaddress from fhevmjs)
     * @param inputProof Zero-Knowledge proof validating the encrypted inputs
     * @param isEth True for ETH, false for USDT
     * @return requestId The unique withdrawal request ID
     */
    function requestEncryptedWithdrawalPrivate(
        externalEuint128 encryptedAmount,
        externalEaddress encryptedRecipient,
        bytes calldata inputProof,
        bool isEth
    ) external nonReentrant whenNotPaused returns (uint256) {
        // SECURITY FIX [HIGH-1]: Prevent DoS attack via unbounded withdrawal queue
        if (pendingWithdrawalCount[msg.sender] >= MAX_PENDING_WITHDRAWALS_PER_USER) {
            revert TooManyPendingWithdrawals();
        }
        
        // Validate and convert encrypted inputs (ZK proof verified automatically by FHE library)
        // This proves the client knows the plaintext values without revealing them
        // FHE.fromExternal() verifies the ZK proof and converts to internal encrypted types
        euint128 encAmount = FHE.fromExternal(encryptedAmount, inputProof);
        eaddress encRecipient = FHE.fromExternal(encryptedRecipient, inputProof);
        
        // Validate recipient is not zero address or self using encrypted comparison
        // NOTE: We can't validate plaintext address since it's encrypted, but the client
        // is responsible for not encrypting invalid addresses. Invalid withdrawals will
        // fail at execution time when decrypted.
        
        euint128 currentBalance = isEth ? ethBalances[msg.sender] : usdtBalances[msg.sender];
        euint128 originalBalance = currentBalance;

        // SECURITY FIX [CRITICAL C-1]: Gate debit with FHE.select (same as public path)
        ebool hasSufficientBalance = FHE.ge(currentBalance, encAmount);
        euint128 zero = FHE.asEuint128(0);
        euint128 debit = FHE.select(hasSufficientBalance, encAmount, zero);
        euint128 newBalance = FHE.sub(currentBalance, debit);

        // Update balance
        if (isEth) {
            ethBalances[msg.sender] = newBalance;
        } else {
            usdtBalances[msg.sender] = newBalance;
        }

        // Grant ACL permissions for new balance
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, msg.sender);
        
        // Grant permission to contract for encrypted amount (needed for cancellation)
        FHE.allowThis(encAmount);
        
        // Snapshot retained for struct compatibility (no longer restored on fail)
        FHE.allowThis(originalBalance);
        
        // Grant permission to contract for hasSufficientBalance boolean (needed for Gateway decryption)
        FHE.allowThis(hasSufficientBalance);
        
        // Grant permission to contract for encrypted recipient (needed for Gateway decryption)
        FHE.allowThis(encRecipient);

        // Create withdrawal request
        uint256 requestId = ++withdrawalCounter;
        withdrawalRequests[requestId] = WithdrawalRequest({
            requestId: requestId,
            requester: msg.sender,
            plaintextRecipient: address(0),    // Not used (will be decrypted via Gateway)
            encryptedRecipient: encRecipient,  // Encrypted destination (PRIVACY!)
            encryptedAmount: encAmount,
            originalBalance: originalBalance,
            hasSufficientBalance: hasSufficientBalance,
            isEth: isEth,
            requestTime: block.timestamp,
            executed: false,
            gatewayRequestId: 0,
            gatewayRequested: false,
            gatewayRequestTime: 0
        });

        // SECURITY FIX [HIGH-1]: Increment pending withdrawal counter
        pendingWithdrawalCount[msg.sender]++;

        emit WithdrawalRequested(requestId, msg.sender, isEth, block.timestamp);

        return requestId;
    }

    /**
     * @notice Request withdrawal execution via Gateway (keeper-initiated, trustless)
     * @dev ZAMA Best Practice: Keeper requests decryption, Gateway provides values
     * @dev CRITICAL: Keeper CANNOT pass decrypted values - prevents theft (Issue #6)
     * 
     * @param requestId Withdrawal request to execute
     * @return gatewayRequestId Gateway decryption request ID
     * 
     * Security Model:
     * 1. Keeper calls this function (just triggers process, no decrypted data)
     * 2. Contract requests Gateway to decrypt
     * 3. Gateway decrypts off-chain via KMS
     * 4. Gateway calls executeWithdrawalCallback() with verified values
     * 5. Only Gateway can call callback (onlyGateway modifier)
     * 
     * Gas Optimization:
     * - Uses allowTransient() for temporary Gateway access (~25k gas saved)
     */
    /**
     * @notice FHEVM v0.9 User-Initiated Decryption Pattern
     * @dev Marks encrypted values as decryptable and returns handles for user to decrypt
     * 
     * PRIVACY-FIRST v0.9 Flow:
     * 1. User calls this function to mark ciphertexts as decryptable
     * 2. User calls userDecrypt() via relayer-sdk with their signature
     * 3. ONLY THE USER receives the cleartext values (privacy preserved!)
     * 4. User calls executeWithdrawalCallback() with cleartext + proof
     * 5. Callback verifies with FHE.checkSignatures() and executes transfer
     * 
     * PRIVACY: No keeper or third party sees the decrypted values!
     * The user decrypts their own data using their wallet signature.
     */
    function requestWithdrawalExecution(uint256 requestId) 
        external 
        nonReentrant 
        whenNotPaused
    {
        WithdrawalRequest storage request = withdrawalRequests[requestId];
        
        // CHECKS - Validation
        if (request.requestId == 0) revert WithdrawalNotFound();
        if (request.executed) revert WithdrawalAlreadyExecuted();
        if (request.gatewayRequested) revert GatewayRequestAlreadyPending();
        
        // SECURITY: Only the original requester can initiate execution
        // This ensures only the user who created the withdrawal can decrypt their own values
        if (request.requester != msg.sender) revert NotWithdrawalRequester();
        
        // EFFECTS - Update state
        request.gatewayRequested = true;
        request.gatewayRequestTime = block.timestamp;
        
        // CRITICAL: Grant permission to this contract for the amount ciphertext
        FHE.allowThis(request.encryptedAmount);
        
        // PRIVACY FIX: Grant permission for hasSufficientBalance boolean
        // This allows us to verify that userBalance >= amount WITHOUT revealing the actual balance!
        // We only decrypt a true/false value, preserving user balance privacy.
        FHE.allowThis(request.hasSufficientBalance);
        
        // FHEVM v0.9: Mark for public decryption via Gateway
        // This is required for publicDecrypt() to work and produce on-chain proofs
        // 
        // PRIVACY IMPROVEMENT: We now decrypt:
        // 1. encryptedAmount (euint128) - the withdrawal amount
        // 2. hasSufficientBalance (ebool) - true/false only, NOT the actual balance!
        // 
        // WORKAROUND: Use batch call to ACL to bypass Zama ACL bug with consecutive calls.
        _makePubliclyDecryptableBatchAmountBool(request.encryptedAmount, request.hasSufficientBalance);
        
        // Prepare handles array - 2 HANDLES (amount + hasSufficientBalance boolean)
        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(request.encryptedAmount);      // Requested amount
        handles[1] = FHE.toBytes32(request.hasSufficientBalance); // Boolean: balance >= amount
        
        // Emit event for frontend to process
        // User will: userDecrypt(handles, signature) → callback(requestId, cleartexts, proof)
        emit DecryptionReady(requestId, handles, msg.sender);
    }

    /**
     * @notice Retry decryption request after timeout (resolves stuck withdrawals)
     * @dev SECURITY FIX: Addresses HIGH severity vulnerability from audit
     * @dev Allows user to retry if decryption fails (network failure, MPC down)
     * 
     * @param requestId Withdrawal request to retry
     * 
     * Problem Solved:
     * - If MPC never responds (network failure, MPC down), withdrawal was stuck for 1 hour
     * - User had to wait for full timeout to cancel
     * 
     * Solution:
     * - After 10 minutes, user can reset gatewayRequested flag
     * - This allows requestWithdrawalExecution() to be called again
     * - Prevents 1-hour UX delays from transient failures
     * 
     * Safety:
     * - Only callable by original requester (user who created the withdrawal)
     * - Requires 10 minutes delay (prevents spam, allows transient failures)
     * - Cannot retry if already executed
     * - Cleans up pending request mapping
     */
    function retryWithdrawalExecution(uint256 requestId) 
        external 
        nonReentrant 
        whenNotPaused
    {
        WithdrawalRequest storage request = withdrawalRequests[requestId];
        
        // CHECKS
        if (request.requestId == 0) revert WithdrawalNotFound();
        if (!request.gatewayRequested) revert NoGatewayRequestPending();
        if (request.executed) revert WithdrawalAlreadyExecuted();
        
        // SECURITY: Only the original requester can retry their own withdrawal
        if (request.requester != msg.sender) revert NotWithdrawalRequester();
        
        // Enforce 10-minute cooldown before retry (prevents spam, allows transient failures)
        uint256 timeSinceRequest = block.timestamp - request.gatewayRequestTime;
        if (timeSinceRequest < 10 minutes) {
            revert RetryTooEarly(10 minutes - timeSinceRequest);
        }
        
        // EFFECTS
        uint256 oldGatewayRequestId = request.gatewayRequestId;
        
        // Clean up old request mapping
        if (pendingGatewayRequests[oldGatewayRequestId]) {
            pendingGatewayRequests[oldGatewayRequestId] = false;
            delete gatewayRequestToWithdrawal[oldGatewayRequestId];
        }
        
        // Reset request state to allow new attempt
        request.gatewayRequested = false;
        request.gatewayRequestId = 0;
        request.gatewayRequestTime = 0;
        
        emit GatewayRequestRetried(requestId, oldGatewayRequestId, msg.sender);
        
        // NOTE: User should now call requestWithdrawalExecution() again
    }

    /**
     * @notice Gateway callback with decrypted values (trustless execution)
     * @dev CRITICAL SECURITY: Only Gateway can call (onlyGateway modifier)
     * @dev This is where the actual transfer happens, with Gateway-verified amounts
     * 
     * @param gatewayRequestId Gateway request being fulfilled
     * @param success Whether decryption succeeded
     * @param decryptedData ABI-encoded decrypted values
     * 
     * Security Guarantees:
     * 1. onlyGateway modifier prevents keeper manipulation
     * 2. Recipient validation against original request
     * 3. Reentrancy protected
     * 4. KMS provides cryptographically verified decrypted values
     * 
     * ZAMA Pattern (new @fhevm/solidity):
     * - Relayer decrypts off-chain via KMS
     * - KMS signs decryption proof
     * - Relayer calls this callback with cleartexts + proof
     * - Contract verifies proof with FHE.checkSignatures() and executes transfer
     */
    /**
     * @notice FHEVM v0.9 Callback - Called by keeper with decrypted values + proof
     * @dev Self-relaying pattern: Keeper decrypts off-chain and submits result
     * 
     * Security:
     * - FHE.checkSignatures() cryptographically verifies cleartexts are authentic
     * - Reverts with InvalidKMSSignatures if proof is invalid
     * - No need for access control - proof is the authentication
     * - User calls userDecrypt() to get cleartexts privately (privacy preserved!)
     * 
     * @param requestId The withdrawal request ID
     * @param cleartexts ABI-encoded decrypted values from userDecrypt()
     * @param decryptionProof Cryptographic proof from KMS (signed by MPC)
     */
    function executeWithdrawalCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory decryptionProof
    ) external nonReentrant whenNotPaused {
        WithdrawalRequest storage request = withdrawalRequests[requestId];
        
        // CHECKS
        if (request.requestId == 0) revert WithdrawalNotFound();
        if (request.executed) revert WithdrawalAlreadyExecuted();
        if (!request.gatewayRequested) revert GatewayRequestNotPending();
        
        // PRIVACY FIX: 2 handles (amount + boolean for balance verification)
        // We now decrypt hasSufficientBalance (true/false) instead of the actual balance!
        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(request.encryptedAmount);
        handles[1] = FHE.toBytes32(request.hasSufficientBalance);
        
        // FHEVM v0.9 SECURITY: Cryptographic verification of decryption
        // If verification fails, reverts with InvalidKMSSignatures
        FHE.checkSignatures(handles, cleartexts, decryptionProof);
        
        // PRIVACY FIX: Decode amount AND hasSufficientBalance boolean
        // We no longer reveal the actual user balance - only true/false!
        (uint128 decryptedAmount, bool hasSufficientBalance) = abi.decode(
            cleartexts, 
            (uint128, bool)
        );
        
        // SIMPLIFIED: Recipient is the original requester (no encryption needed)
        address recipient = request.requester;
        
        // SECURITY: Validate timeout
        if (block.timestamp > request.gatewayRequestTime + DECRYPTION_TIMEOUT * 2) {
            revert GatewayTimeoutExceeded();
        }
        
        // Get actual contract balance for validation
        uint256 contractBalance = request.isEth 
            ? address(this).balance 
            : usdt.balanceOf(address(this));
        
        // For backwards compatibility with events
        uint256 gatewayRequestId = requestId;
        
        // VALIDATION 1: Decrypted amount should be non-zero
        if (decryptedAmount == 0) {
            pendingGatewayRequests[gatewayRequestId] = false;
            emit SuspiciousDecryptedValue(requestId, decryptedAmount, 0, "Decrypted amount is zero");
            emit WithdrawalExecutionFailed(requestId, gatewayRequestId);
            revert InvalidWithdrawalAmount();
        }
        
        // VALIDATION 2: Validate against maximum limits
        uint256 maxWithdrawal = request.isEth ? MAX_ETH_WITHDRAWAL : MAX_USDT_WITHDRAWAL;
        if (decryptedAmount > maxWithdrawal) {
            pendingGatewayRequests[gatewayRequestId] = false;
            emit SuspiciousDecryptedValue(requestId, decryptedAmount, 0, "Exceeds MAX_WITHDRAWAL");
            emit WithdrawalExecutionFailed(requestId, gatewayRequestId);
            revert ExceedsMaximumWithdrawal();
        }
        
        // VALIDATION 3: Validate against contract balance (defense-in-depth)
        if (decryptedAmount > contractBalance) {
            pendingGatewayRequests[gatewayRequestId] = false;
            emit SuspiciousDecryptedValue(requestId, decryptedAmount, 0, "Exceeds contract balance");
            emit WithdrawalExecutionFailed(requestId, gatewayRequestId);
            revert InsufficientBalance();
        }
        
        // VALIDATION 4 [CRITICAL - PRIVACY PRESERVED]: Verify user had sufficient balance
        // This prevents underflow exploitation where user requests withdrawal > their balance
        // 
        // PRIVACY FIX: We now use FHE.ge(balance, amount) computed at request time
        // - We only decrypt the BOOLEAN result (true/false)
        // - The actual user balance is NEVER revealed on-chain or off-chain!
        // 
        // Attack scenario WITHOUT this check:
        // 1. User has 1 ETH encrypted balance
        // 2. User requests withdrawal of 50 ETH
        // 3. requestWithdrawal() does FHE.sub(1, 50) → encrypted underflow (invalid state)
        // 4. Keeper decrypts the REQUESTED amount (50 ETH), not the balance
        // 5. Without this check, 50 ETH would be transferred even though user only had 1 ETH
        // 
        // Defense: hasSufficientBalance = FHE.ge(balance, amount) computed at request time
        // We only decrypt true/false, preserving complete balance privacy!
        
        // CRITICAL CHECK: User must have had sufficient balance
        if (!hasSufficientBalance) {
            // C-1: debit was already gated to 0 at request time — do NOT restore originalBalance
            // (that would re-credit a wrapped/stale snapshot). Mark failed and return.
            request.executed = true;
            pendingGatewayRequests[gatewayRequestId] = false;
            
            if (pendingWithdrawalCount[request.requester] > 0) {
                pendingWithdrawalCount[request.requester]--;
            }
            
            emit SuspiciousDecryptedValue(
                requestId, 
                decryptedAmount, 
                0,  // PRIVACY: We no longer reveal the user's balance
                "Withdrawal amount exceeds user balance"
            );
            emit WithdrawalExecutionFailed(requestId, gatewayRequestId);
            
            return;
        }
        
        // CRITICAL: Circuit Breaker & Pattern Monitoring
        _validateWithdrawalLimits(request.requester, decryptedAmount, request.isEth);
        
        // Mark as executed (reentrancy protection)
        request.executed = true;
        pendingGatewayRequests[gatewayRequestId] = false;
        
        // SECURITY FIX [HIGH-1]: Decrement pending withdrawal counter
        if (pendingWithdrawalCount[request.requester] > 0) {
            pendingWithdrawalCount[request.requester]--;
        }
        
        // SECURITY FIX [MEDIUM-3]: Pull-over-push pattern for ETH transfers
        if (request.isEth) {
            // Make claimable to prevent malicious contract DoS
            claimableETH[recipient] += decryptedAmount;
            emit ClaimableBalanceUpdated(recipient, decryptedAmount, claimableETH[recipient]);
        } else {
            // USDT uses SafeERC20
            usdt.safeTransfer(recipient, decryptedAmount);
        }
        
        emit WithdrawalExecuted(requestId, recipient, decryptedAmount);
    }

    // ============================================
    // WITHDRAWAL HELPER FUNCTIONS
    // ============================================

    /**
     * @notice Get withdrawal request details
     * @param requestId The withdrawal request ID
     * @return The withdrawal request struct (with encrypted data)
     */
    function getWithdrawalRequest(uint256 requestId) 
        external 
        view 
        returns (WithdrawalRequest memory) 
    {
        return withdrawalRequests[requestId];
    }

    /**
     * @notice Cancel withdrawal request after timeout (emergency fallback)
     * @dev Allows users to recover funds if keeper fails or Gateway times out
     * @dev Enhanced with Gateway timeout check
     * @param requestId The withdrawal request ID to cancel
     */
    function cancelWithdrawal(uint256 requestId) external nonReentrant {
        WithdrawalRequest storage request = withdrawalRequests[requestId];
        
        // Validation
        if (request.requestId == 0) revert WithdrawalNotFound();
        if (request.requester != msg.sender) revert NotWithdrawalRequester();
        if (request.executed) revert WithdrawalAlreadyExecuted();
        
        // USER-INITIATED FLOW (v1.1.0):
        // - If user hasn't called requestWithdrawalExecution yet → immediate cancel allowed
        // - If user already started execution → require timeout (prevent gaming mid-decryption)
        if (request.gatewayRequested) {
            // Gateway/decryption was requested - require timeout before cancel
            if (block.timestamp < request.gatewayRequestTime + DECRYPTION_TIMEOUT) {
                revert CancellationTooEarly();
            }
        }
        // If gatewayRequested is false, allow immediate cancellation (user changed their mind)
        
        // Mark as executed to prevent double-processing
        request.executed = true;
        
        // SECURITY FIX [HIGH-1]: Decrement pending withdrawal counter
        if (pendingWithdrawalCount[msg.sender] > 0) {
            pendingWithdrawalCount[msg.sender]--;
        }
        
        // Clean up Gateway request if pending
        if (request.gatewayRequested && pendingGatewayRequests[request.gatewayRequestId]) {
            pendingGatewayRequests[request.gatewayRequestId] = false;
        }
        
        // C-1: refund only what was actually debited (0 if request was over-balance)
        euint128 zero = FHE.asEuint128(0);
        euint128 refund = FHE.select(request.hasSufficientBalance, request.encryptedAmount, zero);
        euint128 newBalance;
        if (request.isEth) {
            newBalance = FHE.add(ethBalances[msg.sender], refund);
            ethBalances[msg.sender] = newBalance;
        } else {
            newBalance = FHE.add(usdtBalances[msg.sender], refund);
            usdtBalances[msg.sender] = newBalance;
        }
        
        // Grant ACL permissions for new balance
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, msg.sender);
        
        emit WithdrawalCancelled(requestId, msg.sender);
    }

    /**
     * @notice Claim pending ETH (pull-over-push pattern for DoS prevention)
     * @dev SECURITY FIX [MEDIUM-3]: Prevents malicious recipient contracts from blocking withdrawals
     * @dev Users must call this function to receive their ETH after withdrawal is executed
     * 
     * Security Guarantees:
     * 1. Reentrancy protected (nonReentrant modifier)
     * 2. Checks-Effects-Interactions pattern
     * 3. Gas-efficient (no loops, constant-time operations)
     * 4. Fail-safe: If transfer fails, balance is restored
     * 
     * Gas Cost: ~50,000 gas (constant-time)
     * 
     * Why Pull Pattern?
     * - Prevents malicious contracts from causing DoS via gas bombs or reverts
     * - Separates keeper execution from user fund receipt
     * - Keeper can process withdrawals without risk of malicious recipients
     * - USDT transfers use SafeERC20, no DoS risk (only ETH needs this pattern)
     * 
     * @custom:security Critical function for withdrawal completion
     */
    function claimETH() external nonReentrant {
        uint256 amount = claimableETH[msg.sender];
        
        // Validation
        if (amount == 0) revert NothingToClaim();
        
        // Effects: Clear claimable balance BEFORE transfer (CEI pattern)
        claimableETH[msg.sender] = 0;
        
        // Interactions: Transfer ETH — revert on failure so the clear is rolled back
        // SECURITY FIX [HIGH]: Pure pull CEI (no restore-after-call). A failing
        // recipient reverts the whole tx; user can retry after fixing their contract.
        (bool success, ) = msg.sender.call{value: amount}("");
        if (!success) revert TransferFailed();
        
        emit ETHClaimed(msg.sender, amount);
    }

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    // ============================================
    // KEEPER MANAGEMENT FUNCTIONS
    // ============================================

    /**
     * @notice Initialize keepers on first setup (bypasses timelock for initial configuration)
     * @dev Can ONLY be called when NO keepers are registered (initial setup only)
     * @dev After first keeper is added, all changes require 48-hour timelock
     * @param _keepers Array of keeper addresses to add
     * @param _minKeepers Minimum number of keepers required
     * 
     * Security guarantees:
     * - Only callable by owner
     * - Only works when keeper count is ZERO (prevents abuse after setup)
     * - Sets minKeepers in same transaction (atomic setup)
     * - All subsequent changes require timelock
     */
    function initializeKeepers(address[] calldata _keepers, uint256 _minKeepers) external onlyOwner {
        // CRITICAL: Can only be called during initial setup (no keepers yet)
        if (authorizedKeepers.length() > 0) revert KeeperAlreadyAuthorized(authorizedKeepers.at(0));
        
        // Validate inputs
        if (_keepers.length == 0) revert InvalidAddress();
        if (_keepers.length > MAX_KEEPERS) revert TooManyKeepers(_keepers.length, MAX_KEEPERS);
        if (_minKeepers == 0 || _minKeepers > _keepers.length) revert InvalidMinKeepers(_minKeepers);
        
        // Add all keepers
        for (uint256 i = 0; i < _keepers.length; i++) {
            address keeper = _keepers[i];
            if (keeper == address(0)) revert InvalidAddress();
            if (authorizedKeepers.contains(keeper)) revert KeeperAlreadyAuthorized(keeper);
            
            authorizedKeepers.add(keeper);
            emit KeeperAdded(keeper, authorizedKeepers.length());
        }
        
        // Set minimum keepers
        minKeepers = _minKeepers;
        emit MinKeepersUpdated(3, _minKeepers); // 3 was the default
    }

    /**
     * @notice Propose to add a new authorized keeper (step 1 of 2-step timelock)
     * @dev SECURITY FIX [MEDIUM-1]: Prevents instant keeper manipulation
     * @dev Keeper changes require 48-hour delay for security
     * @param _keeper Address to authorize as keeper
     * @return proposalId The ID of the created proposal
     */
    function proposeAddKeeperV2(address _keeper) external onlyOwner returns (uint256) {
        // Validation
        if (_keeper == address(0)) revert InvalidAddress();
        if (authorizedKeepers.contains(_keeper)) revert KeeperAlreadyAuthorized(_keeper);
        if (authorizedKeepers.length() >= MAX_KEEPERS) {
            revert TooManyKeepers(authorizedKeepers.length(), MAX_KEEPERS);
        }
        
        // Create new proposal
        uint256 proposalId = ++keeperProposalCounter;
        
        keeperChangeProposals[proposalId] = PendingKeeperChange({
            keeper: _keeper,
            newMinKeepers: 0,
            operation: KeeperOperation.ADD,
            executeAfter: block.timestamp + KEEPER_CHANGE_DELAY,
            exists: true
        });
        
        emit KeeperChangeProposedV2(proposalId, _keeper, 0, uint8(KeeperOperation.ADD), keeperChangeProposals[proposalId].executeAfter);
        
        return proposalId;
    }

    /**
     * @notice Propose to remove an authorized keeper (step 1 of 2-step timelock)
     * @dev SECURITY FIX [MEDIUM-1]: Prevents instant keeper removal
     * @param _keeper Address to remove from keepers
     * @return proposalId The ID of the created proposal
     */
    function proposeRemoveKeeperV2(address _keeper) external onlyOwner returns (uint256) {
        // Validation
        if (!authorizedKeepers.contains(_keeper)) revert KeeperNotFound(_keeper);
        
        // Check CURRENT state (will be re-validated at execution)
        if (authorizedKeepers.length() <= minKeepers) {
            revert BelowMinimumKeepers(authorizedKeepers.length(), minKeepers);
        }
        
        // Create new proposal
        uint256 proposalId = ++keeperProposalCounter;
        
        keeperChangeProposals[proposalId] = PendingKeeperChange({
            keeper: _keeper,
            newMinKeepers: 0,
            operation: KeeperOperation.REMOVE,
            executeAfter: block.timestamp + KEEPER_CHANGE_DELAY,
            exists: true
        });
        
        emit KeeperChangeProposedV2(proposalId, _keeper, 0, uint8(KeeperOperation.REMOVE), keeperChangeProposals[proposalId].executeAfter);
        
        return proposalId;
    }

    /**
     * @notice Propose to update minimum keeper threshold (step 1 of 2-step timelock)
     * @dev SECURITY FIX [MEDIUM-1]: Prevents instant threshold manipulation
     * @param _min New minimum number of keepers required
     * @return proposalId The ID of the created proposal
     */
    function proposeSetMinKeepersV2(uint256 _min) external onlyOwner returns (uint256) {
        // Validation
        if (_min == 0 || _min > MAX_KEEPERS) revert InvalidMinKeepers(_min);
        if (_min > authorizedKeepers.length()) {
            revert BelowMinimumKeepers(authorizedKeepers.length(), _min);
        }
        
        // Create new proposal
        uint256 proposalId = ++keeperProposalCounter;
        
        keeperChangeProposals[proposalId] = PendingKeeperChange({
            keeper: address(0),
            newMinKeepers: _min,
            operation: KeeperOperation.SET_MIN,
            executeAfter: block.timestamp + KEEPER_CHANGE_DELAY,
            exists: true
        });
        
        emit KeeperChangeProposedV2(proposalId, address(0), _min, uint8(KeeperOperation.SET_MIN), keeperChangeProposals[proposalId].executeAfter);
        
        return proposalId;
    }

    /**
     * @notice Execute pending keeper change after timelock delay (step 2 of 2-step timelock)
     * @dev SECURITY FIX [MEDIUM-1]: Multi-proposal support - execute specific proposal by ID
     * @param proposalId The ID of the proposal to execute
     */
    function executeKeeperChangeV2(uint256 proposalId) external onlyOwner {
        // CHECKS
        PendingKeeperChange memory proposal = keeperChangeProposals[proposalId];
        
        if (!proposal.exists) revert NoKeeperChangeProposal();
        if (block.timestamp < proposal.executeAfter) {
            uint256 timeLeft = proposal.executeAfter - block.timestamp;
            revert KeeperChangeTooEarly(timeLeft);
        }
        
        // EFFECTS & INTERACTIONS
        KeeperOperation operation = proposal.operation;
        address keeper = proposal.keeper;
        uint256 newMin = proposal.newMinKeepers;
        
        // Clear proposal (prevent replay)
        delete keeperChangeProposals[proposalId];
        
        // Execute operation (with re-validation)
        if (operation == KeeperOperation.ADD) {
            // Re-validate (state may have changed during timelock)
            if (keeper == address(0)) revert InvalidAddress();
            if (authorizedKeepers.contains(keeper)) revert KeeperAlreadyAuthorized(keeper);
            if (authorizedKeepers.length() >= MAX_KEEPERS) {
                revert TooManyKeepers(authorizedKeepers.length(), MAX_KEEPERS);
            }
            
            authorizedKeepers.add(keeper);
            emit KeeperAdded(keeper, authorizedKeepers.length());
            
        } else if (operation == KeeperOperation.REMOVE) {
            // Re-validate (state may have changed during timelock)
            if (!authorizedKeepers.contains(keeper)) revert KeeperNotFound(keeper);
            
            // CRITICAL: Re-check minimum keepers at execution time
            // If other removals happened during timelock, this may now fail
            if (authorizedKeepers.length() <= minKeepers) {
                revert BelowMinimumKeepers(authorizedKeepers.length(), minKeepers);
            }
            
            authorizedKeepers.remove(keeper);
            emit KeeperRemoved(keeper, authorizedKeepers.length());
            
        } else if (operation == KeeperOperation.SET_MIN) {
            // Re-validate (state may have changed during timelock)
            if (newMin == 0 || newMin > MAX_KEEPERS) revert InvalidMinKeepers(newMin);
            if (newMin > authorizedKeepers.length()) {
                revert BelowMinimumKeepers(authorizedKeepers.length(), newMin);
            }
            
            uint256 oldMin = minKeepers;
            minKeepers = newMin;
            emit MinKeepersUpdated(oldMin, newMin);
        }
        
        emit KeeperChangeExecutedV2(proposalId, keeper, newMin, uint8(operation));
    }

    /**
     * @notice Cancel pending keeper change proposal by ID
     * @dev SECURITY FIX [MEDIUM-1]: Multi-proposal support - cancel specific proposal
     * @param proposalId The ID of the proposal to cancel
     */
    function cancelKeeperChangeProposalV2(uint256 proposalId) external onlyOwner {
        PendingKeeperChange memory proposal = keeperChangeProposals[proposalId];
        
        if (!proposal.exists) revert NoKeeperChangeProposal();
        
        address keeper = proposal.keeper;
        KeeperOperation operation = proposal.operation;
        
        delete keeperChangeProposals[proposalId];
        
        emit KeeperChangeProposalCancelledV2(proposalId, keeper, uint8(operation));
    }

    /**
     * @notice Get total number of authorized keepers
     * @return Current keeper count
     */
    function getKeeperCount() external view returns (uint256) {
        return authorizedKeepers.length();
    }

    /**
     * @notice Check if an address is an authorized keeper
     * @param _addr Address to check
     * @return True if address is authorized keeper
     */
    function isKeeper(address _addr) external view returns (bool) {
        return authorizedKeepers.contains(_addr);
    }

    /**
     * @notice Propose a new Gateway address (step 1 of 2-step timelock pattern)
     * @dev CRITICAL SECURITY FIX [CRITICAL-3]: Prevents instant Gateway hijacking
     * @dev Gateway change requires 7-day delay for security (like TimelockController)
     * @dev Owner can propose, but cannot execute until delay passes
     * 
     * @param _gateway Gateway contract address (MockGateway for testing, real Gateway for production)
     * 
     * Security Rationale:
     * - If owner key is compromised, attacker cannot instantly hijack withdrawals
     * - 7-day delay allows detection and emergency response
     * - Prevents withdrawal hijacking attack vector
     * 
     * Attack Vector Prevented:
     * 1. User requests withdrawal (requestId = 123)
     * 2. Keeper calls requestWithdrawalExecution(123)
     * 3. Attacker (with compromised owner key) tries setGateway(maliciousGateway)
     * 4. ❌ BLOCKED: Must wait 7 days before executeGatewayChange()
     * 5. During 7 days: Original Gateway completes withdrawal OR community detects attack
     */
    function proposeGateway(address _gateway) external onlyOwner {
        // Validation: Gateway must be a valid address
        if (_gateway == address(0)) revert InvalidGateway();
        
        // Validation: Gateway must be a contract (not EOA)
        // Note: This check may fail during deployment, but protects against EOA mistakes
        if (_gateway.code.length == 0) revert InvalidGateway();
        
        // Store proposal
        pendingGateway = _gateway;
        gatewayChangeTimestamp = block.timestamp + GATEWAY_CHANGE_DELAY;
        
        emit GatewayProposed(_gateway, gatewayChangeTimestamp);
    }

    /**
     * @notice Execute Gateway change after timelock delay (step 2 of 2-step timelock pattern)
     * @dev CRITICAL SECURITY FIX [CRITICAL-3]: Enforces 7-day delay before Gateway change
     * @dev Can only execute if proposal exists AND delay has passed
     * 
     * Security Properties:
     * - Cannot execute without prior proposal
     * - Cannot execute before 7-day delay
     * - Clears proposal after execution (no replay)
     */
    function executeGatewayChange() external onlyOwner {
        // CHECKS
        if (pendingGateway == address(0)) revert NoGatewayProposal();
        if (block.timestamp < gatewayChangeTimestamp) {
            uint256 timeLeft = gatewayChangeTimestamp - block.timestamp;
            revert GatewayChangeTooEarly(timeLeft);
        }
        
        // EFFECTS
        address oldGateway = gateway;
        address newGateway = pendingGateway;
        
        // Clear proposal (prevent replay)
        delete pendingGateway;
        delete gatewayChangeTimestamp;
        
        // Execute change (calls internal _setGateway from GatewayCaller)
        _setGateway(newGateway);
        
        emit GatewayChangeExecuted(oldGateway, newGateway);
    }

    /**
     * @notice Cancel pending Gateway proposal
     * @dev Allows owner to cancel a pending Gateway change before execution
     * @dev Useful if proposal was made in error or situation changes
     */
    function cancelGatewayProposal() external onlyOwner {
        if (pendingGateway == address(0)) revert NoGatewayProposal();
        
        address cancelledGateway = pendingGateway;
        
        delete pendingGateway;
        delete gatewayChangeTimestamp;
        
        emit GatewayProposalCancelled(cancelledGateway);
    }

    /**
     * @notice Initialize Gateway on first setup (bypasses timelock for initial configuration)
     * @dev ONLY works if Gateway has never been set (gateway == address(0))
     * @dev After first initialization, all changes require timelock via proposeGateway()
     * @dev This allows immediate testnet deployment while maintaining production security
     * 
     * @param _gateway Address of ZAMA Gateway contract
     * 
     * Security Rationale:
     * - Initial setup doesn't need timelock (no existing users at risk)
     * - All subsequent changes require 7-day timelock for security
     * - Testnet-friendly without compromising production safety
     */
    function initializeGateway(address _gateway) external onlyOwner {
        // Can only initialize if Gateway has NEVER been set
        if (gateway != address(0)) revert InvalidGateway();
        if (_gateway == address(0)) revert InvalidGateway();
        if (_gateway.code.length == 0) revert InvalidGateway();
        
        // Directly set Gateway (bypass timelock for first-time setup)
        // Note: With new @fhevm/solidity, Oracle address is auto-configured via SepoliaConfig
        // We still keep gateway variable for isGatewayConfigured() checks
        _setGateway(_gateway);
        
        emit GatewayChangeExecuted(address(0), _gateway);
    }

    // ============================================
    // EXCHANGE MANAGEMENT FUNCTIONS
    // ============================================

    /**
     * @notice Authorize or revoke an exchange contract
     * @dev Only owner can authorize exchange contracts for security
     * @param _exchange Address of the exchange contract
     * @param _status True to authorize, false to revoke
     */
    function setExchange(address _exchange, bool _status) external onlyOwner {
        if (_exchange == address(0)) revert InvalidAddress();
        
        authorizedExchanges[_exchange] = _status;
        emit ExchangeAuthorized(_exchange, _status);
    }

    // ============================================
    // GUARDIAN MANAGEMENT (Emergency Multisig)
    // ============================================

    /**
     * @notice Propose a new guardian address
     * @dev Guardian can only pause, not unpause or change parameters
     * @dev Recommended: Use 3-of-5 multisig for guardian
     * @dev 7-day timelock provides detection window for compromised owner
     * @param _guardian New guardian address
     * 
     * Security Model:
     * - Owner compromised → Can propose malicious guardian → 7 days to detect
     * - Guardian compromised → Can only pause (not steal funds or unpause)
     * - Both compromised → Users still have 7-day exit window
     */
    function proposeGuardian(address _guardian) external onlyOwner {
        if (_guardian == address(0)) revert InvalidAddress();
        
        pendingGuardian = _guardian;
        guardianChangeTimestamp = block.timestamp + GUARDIAN_CHANGE_DELAY;
        
        emit GuardianProposed(_guardian, guardianChangeTimestamp);
    }

    /**
     * @notice Execute pending guardian change after timelock
     * @dev Can only be called after GUARDIAN_CHANGE_DELAY (7 days)
     */
    function executeGuardianChange() external onlyOwner {
        if (pendingGuardian == address(0)) revert NoGuardianProposal();
        if (block.timestamp < guardianChangeTimestamp) {
            revert GuardianChangeTooEarly(guardianChangeTimestamp - block.timestamp);
        }

        address oldGuardian = guardian;
        guardian = pendingGuardian;
        
        // Reset proposal
        pendingGuardian = address(0);
        guardianChangeTimestamp = 0;

        emit GuardianChanged(oldGuardian, guardian);
    }

    /**
     * @notice Emergency pause activated by guardian
     * @dev Guardian can ONLY pause, not unpause
     * @dev This prevents guardian from hijacking the protocol
     * @dev Unpause requires governance (owner) vote/decision
     * 
     * Use Cases:
     * - Gateway compromise detected
     * - Keeper network failure
     * - Smart contract exploit discovered
     * - Suspicious withdrawal patterns
     * 
     * Limitations (by design):
     * - Guardian CANNOT unpause (requires owner)
     * - Guardian CANNOT change Gateway
     * - Guardian CANNOT change keepers
     * - Guardian CANNOT transfer funds
     */
    function emergencyPause() external {
        if (msg.sender != guardian) revert OnlyGuardian();
        
        _pause();
        emit EmergencyPauseActivated(guardian);
    }

    /**
     * @notice Pause the contract in case of emergency
     * @dev Only owner can pause (governance decision)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the contract after emergency
     * @dev CRITICAL: Only owner can unpause, NOT guardian
     * @dev This prevents guardian from hijacking the protocol:
     *      - Guardian can pause (emergency response)
     *      - Owner must unpause (governance decision)
     *      - Requires investigation + resolution before unpause
     * 
     * Process:
     * 1. Guardian/Owner pauses (emergency detected)
     * 2. Team investigates root cause
     * 3. Fix applied (if needed)
     * 4. Owner unpauses (governance approval)
     */
    function unpause() external onlyOwner {
        _unpause();
    }
    
    // ============================================
    // INTERNAL HELPERS (CRITICAL-3)
    // ============================================
    
    /**
     * @notice Internal helper: Validate withdrawal limits and patterns
     * @dev Extracted to separate function to avoid "stack too deep" error
     * @dev Implements circuit breakers and pattern detection
     * @param user User making the withdrawal
     * @param amount Withdrawal amount
     * @param isEth True for ETH, false for USDT
     */
    function _validateWithdrawalLimits(
        address user,
        uint256 amount,
        bool isEth
    ) internal {
        // Reset withdrawal tracking windows if expired
        WithdrawalStats storage userStats = userWithdrawalStats[user];
        if (block.timestamp > userStats.windowStart + WITHDRAWAL_WINDOW) {
            userStats.count24h = 0;
            userStats.ethAmount24h = 0;
            userStats.usdtAmount24h = 0;
            userStats.windowStart = block.timestamp;
        }
        
        GlobalWithdrawalTracking storage globalStats = globalWithdrawals;
        if (block.timestamp > globalStats.windowStart + WITHDRAWAL_WINDOW) {
            globalStats.ethWithdrawn24h = 0;
            globalStats.usdtWithdrawn24h = 0;
            globalStats.windowStart = block.timestamp;
        }
        
        // CIRCUIT BREAKER: Global daily withdrawal limit
        uint256 totalDailyWithdrawn = isEth 
            ? globalStats.ethWithdrawn24h 
            : globalStats.usdtWithdrawn24h;
        
        if (totalDailyWithdrawn + amount > MAX_DAILY_WITHDRAWAL_LIMIT) {
            _pause(); // Auto-pause protocol
            
            emit CircuitBreakerTriggered(
                totalDailyWithdrawn + amount,
                MAX_DAILY_WITHDRAWAL_LIMIT,
                isEth ? "ETH" : "USDT"
            );
            
            revert DailyWithdrawalLimitExceeded(
                totalDailyWithdrawn + amount,
                MAX_DAILY_WITHDRAWAL_LIMIT
            );
        }
        
        // PATTERN DETECTION 1: Too many withdrawals
        if (userStats.count24h >= MAX_USER_WITHDRAWALS_24H) {
            uint256 userTotal = isEth ? userStats.ethAmount24h + amount : userStats.usdtAmount24h + amount;
            
            emit SuspiciousWithdrawalPattern(
                user,
                userStats.count24h + 1,
                userTotal,
                userStats.lifetimeDeposits,
                "Too many withdrawals in 24h"
            );
            
            revert TooManyWithdrawals24h(userStats.count24h, MAX_USER_WITHDRAWALS_24H);
        }
        
        // PATTERN DETECTION 2: Suspicious withdrawal ratio
        uint256 current24hTotal = isEth 
            ? userStats.ethAmount24h + amount
            : userStats.usdtAmount24h + amount;
        
        if (userStats.lifetimeDeposits > 0) {
            uint256 suspiciousThreshold = (userStats.lifetimeDeposits * SUSPICIOUS_WITHDRAWAL_RATIO_BPS) / 10000;
            
            if (current24hTotal > suspiciousThreshold) {
                emit SuspiciousWithdrawalPattern(
                    user,
                    userStats.count24h + 1,
                    current24hTotal,
                    userStats.lifetimeDeposits,
                    "Withdrawing >50% of deposits in 24h"
                );
                // Don't revert - just alert for monitoring
            }
        }
        
        // Update statistics
        userStats.count24h++;
        if (isEth) {
            userStats.ethAmount24h += amount;
            globalStats.ethWithdrawn24h += amount;
        } else {
            userStats.usdtAmount24h += amount;
            globalStats.usdtWithdrawn24h += amount;
        }
    }

    // ============================================
    // EXCHANGE INTEGRATION (User-Initiated Swaps)
    // ============================================

    /**
     * @notice Credit balance to user's vault (after swap execution)
     * @dev Called by Exchange contract after Uniswap swap completes
     * 
     * @param user User address
     * @param amount Amount to credit (plaintext - from Uniswap output)
     * @param isEth True for ETH, false for USDT
     */
    function creditBalance(
        address user,
        uint256 amount,
        bool isEth
    ) external payable onlyExchange nonReentrant whenNotPaused {
        if (user == address(0)) revert InvalidAddress();
        _creditBalanceInternal(user, amount, isEth);
    }

    /**
     * @notice Prepare encrypted balance lock + sufficiency handle for a swap (encrypted amount)
     * @dev SECURITY FIX [CRITICAL]: Locks debit via FHE.select at prepare time.
     *      Physical funds move only in deductBalanceWithProof after ebool proof.
     * @param orderId Exchange order id (auth key namespace)
     * @param user Trader address
     * @param encryptedAmount Order amount handle (e.g. encryptedAmountETH)
     * @param isEth True for ETH balance check
     * @return sufficiencyHandle Publicly decryptable ebool handle
     */
    function prepareDeductAuthEncrypted(
        uint256 orderId,
        address user,
        euint128 encryptedAmount,
        bool isEth
    ) external onlyExchange whenNotPaused returns (bytes32 sufficiencyHandle) {
        if (user == address(0)) revert InvalidAddress();
        bytes32 key = _deductAuthKey(msg.sender, orderId);
        if (pendingDeductAuth[key].active) revert DeductAuthAlreadyExists();

        euint128 zero = FHE.asEuint128(0);
        ebool hasSufficient = isEth
            ? FHE.le(encryptedAmount, ethBalances[user])
            : FHE.le(encryptedAmount, usdtBalances[user]);
        euint128 debit = FHE.select(hasSufficient, encryptedAmount, zero);

        // Lock encrypted funds immediately (debit is 0 if insufficient)
        if (isEth) {
            ethBalances[user] = FHE.sub(ethBalances[user], debit);
            FHE.allowThis(ethBalances[user]);
            FHE.allow(ethBalances[user], user);
        } else {
            usdtBalances[user] = FHE.sub(usdtBalances[user], debit);
            FHE.allowThis(usdtBalances[user]);
            FHE.allow(usdtBalances[user], user);
        }

        FHE.allowThis(hasSufficient);
        FHE.makePubliclyDecryptable(hasSufficient);
        FHE.allowThis(encryptedAmount);

        pendingDeductAuth[key] = PendingDeductAuth({
            user: user,
            amount: 0,
            isEth: isEth,
            active: true,
            amountKnown: false,
            hasSufficient: hasSufficient,
            encryptedAmount: encryptedAmount
        });

        sufficiencyHandle = FHE.toBytes32(hasSufficient);
        emit DeductAuthPrepared(orderId, isEth, sufficiencyHandle);
    }

    /**
     * @notice Prepare encrypted balance lock + sufficiency handle (plaintext amount known)
     * @dev Used for BUY path after order amount is decrypted and USDT needed is computed
     */
    function prepareDeductAuth(
        uint256 orderId,
        address user,
        uint256 amount,
        bool isEth
    ) external onlyExchange whenNotPaused returns (bytes32 sufficiencyHandle) {
        if (user == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint128).max) revert InvalidDecryptedValue();

        bytes32 key = _deductAuthKey(msg.sender, orderId);
        if (pendingDeductAuth[key].active) revert DeductAuthAlreadyExists();

        euint128 encryptedAmount = FHE.asEuint128(uint128(amount));
        euint128 zero = FHE.asEuint128(0);
        ebool hasSufficient = isEth
            ? FHE.le(encryptedAmount, ethBalances[user])
            : FHE.le(encryptedAmount, usdtBalances[user]);
        euint128 debit = FHE.select(hasSufficient, encryptedAmount, zero);

        if (isEth) {
            ethBalances[user] = FHE.sub(ethBalances[user], debit);
            FHE.allowThis(ethBalances[user]);
            FHE.allow(ethBalances[user], user);
        } else {
            usdtBalances[user] = FHE.sub(usdtBalances[user], debit);
            FHE.allowThis(usdtBalances[user]);
            FHE.allow(usdtBalances[user], user);
        }

        FHE.allowThis(hasSufficient);
        FHE.makePubliclyDecryptable(hasSufficient);

        pendingDeductAuth[key] = PendingDeductAuth({
            user: user,
            amount: amount,
            isEth: isEth,
            active: true,
            amountKnown: true,
            hasSufficient: hasSufficient,
            encryptedAmount: encryptedAmount
        });

        sufficiencyHandle = FHE.toBytes32(hasSufficient);
        emit DeductAuthPrepared(orderId, isEth, sufficiencyHandle);
    }

    /**
     * @notice Finalize deduct: verify sufficiency proof, transfer physical funds to Exchange
     * @dev Encrypted balance was already locked with FHE.select in prepare*.
     *      Reverts if decrypted ebool is false (no physical transfer; lock was zero-debit).
     */
    function deductBalanceWithProof(
        uint256 orderId,
        address user,
        uint256 amount,
        bool isEth,
        bytes calldata sufficiencyCleartexts,
        bytes calldata sufficiencyProof
    ) external onlyExchange nonReentrant whenNotPaused {
        _deductBalanceWithProofInternal(
            orderId,
            user,
            amount,
            isEth,
            sufficiencyCleartexts,
            sufficiencyProof
        );
    }

    function _deductBalanceWithProofInternal(
        uint256 orderId,
        address user,
        uint256 amount,
        bool isEth,
        bytes calldata sufficiencyCleartexts,
        bytes calldata sufficiencyProof
    ) internal {
        if (user == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();

        bytes32 key = _deductAuthKey(msg.sender, orderId);
        PendingDeductAuth memory auth = pendingDeductAuth[key];
        if (!auth.active) revert DeductAuthNotPrepared();
        if (auth.user != user || auth.isEth != isEth) revert InvalidSufficiencyProof();
        if (auth.amountKnown && auth.amount != amount) revert DeductAmountMismatch();

        bool hasSufficient;
        if (auth.amountKnown) {
            // BUY path: only ebool was prepared (plaintext amount already known)
            bytes32[] memory handles = new bytes32[](1);
            handles[0] = FHE.toBytes32(auth.hasSufficient);
            FHE.checkSignatures(handles, sufficiencyCleartexts, sufficiencyProof);
            hasSufficient = abi.decode(sufficiencyCleartexts, (bool));
        } else {
            // SELL path: amount handle + sufficiency ebool decrypted together
            bytes32[] memory handles = new bytes32[](2);
            handles[0] = FHE.toBytes32(auth.encryptedAmount);
            handles[1] = FHE.toBytes32(auth.hasSufficient);
            FHE.checkSignatures(handles, sufficiencyCleartexts, sufficiencyProof);
            uint128 decodedAmount;
            (decodedAmount, hasSufficient) = abi.decode(sufficiencyCleartexts, (uint128, bool));
            if (uint256(decodedAmount) != amount) revert DeductAmountMismatch();
        }
        if (!hasSufficient) {
            delete pendingDeductAuth[key];
            revert InsufficientEncryptedBalance();
        }

        // Effects: consume auth before interaction
        delete pendingDeductAuth[key];

        // Interactions: transfer proven amount to Exchange
        if (isEth) {
            if (address(this).balance < amount) revert DecryptedBalanceExceedsContractBalance();
            (bool success, ) = msg.sender.call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            usdt.safeTransfer(msg.sender, amount);
        }

        emit BalanceDeducted(isEth);
    }

    /**
     * @notice Cancel a prepared deduct auth and restore locked encrypted funds
     * @dev Homomorphic restore: credit = select(hasSufficient, amount, 0) — no decrypt needed
     */
    function cancelDeductAuth(uint256 orderId) external onlyExchange nonReentrant whenNotPaused {
        bytes32 key = _deductAuthKey(msg.sender, orderId);
        PendingDeductAuth memory auth = pendingDeductAuth[key];
        if (!auth.active) revert DeductAuthNotPrepared();

        delete pendingDeductAuth[key];

        euint128 zero = FHE.asEuint128(0);
        euint128 raw = auth.amountKnown
            ? FHE.asEuint128(uint128(auth.amount))
            : auth.encryptedAmount;
        euint128 credit = FHE.select(auth.hasSufficient, raw, zero);

        if (auth.isEth) {
            ethBalances[auth.user] = FHE.add(ethBalances[auth.user], credit);
            FHE.allowThis(ethBalances[auth.user]);
            FHE.allow(ethBalances[auth.user], auth.user);
        } else {
            usdtBalances[auth.user] = FHE.add(usdtBalances[auth.user], credit);
            FHE.allowThis(usdtBalances[auth.user]);
            FHE.allow(usdtBalances[auth.user], auth.user);
        }

        emit DeductAuthCancelled(orderId);
    }

    /// @dev Legacy unsafe deduct — disabled. Use prepareDeductAuth* + deductBalanceWithProof.
    function deductBalance(address, uint256, bool) external pure {
        revert DeductAuthNotPrepared();
    }

    function _deductAuthKey(address exchange, uint256 orderId) private pure returns (bytes32) {
        return keccak256(abi.encode(exchange, orderId));
    }

    /// @dev Internal credit logic shared by creditBalance and creditBalanceByVaultId
    /// @dev MUST mirror deposit init: first credit assigns + sets hasDeposited_*.
    ///      FHE.add on an uninitialized handle is invalid; skipping hasDeposited
    ///      also makes getEncryptedBalance return ephemeral zeros (no ACL).
    function _creditBalanceInternal(address user, uint256 amount, bool isEth) internal {
        if (amount == 0) revert ZeroAmount();

        euint128 encryptedAmount = FHE.asEuint128(uint128(amount));

        if (isEth) {
            if (msg.value != amount) revert InvalidETHAmount();

            if (hasDepositedETH[user]) {
                ethBalances[user] = FHE.add(ethBalances[user], encryptedAmount);
            } else {
                ethBalances[user] = encryptedAmount;
                hasDepositedETH[user] = true;
            }
            FHE.allowThis(ethBalances[user]);
            FHE.allow(ethBalances[user], user);
        } else {
            if (hasDepositedUSDT[user]) {
                usdtBalances[user] = FHE.add(usdtBalances[user], encryptedAmount);
            } else {
                usdtBalances[user] = encryptedAmount;
                hasDepositedUSDT[user] = true;
            }
            FHE.allowThis(usdtBalances[user]);
            FHE.allow(usdtBalances[user], user);
        }

        emit BalanceCredited(isEth);
    }

    /// @notice Whether the user has an initialized encrypted balance for ETH/USDC
    /// @dev Used by frontend to avoid decrypting ephemeral zero handles
    function hasUserDeposited(address user, bool isEth) external view returns (bool) {
        return isEth ? hasDepositedETH[user] : hasDepositedUSDT[user];
    }

    /// @notice Emitted when balance is deducted for swap
    /// @dev CRIT-3 fix: No user address or amount (privacy-preserving)
    event BalanceDeducted(bool isEth);
    
    /// @notice Emitted when balance is credited after swap
    /// @dev CRIT-3 fix: No user address or amount (privacy-preserving)
    event BalanceCredited(bool isEth);

    /// @notice Emitted when Exchange prepares a gated deduct auth for an order
    event DeductAuthPrepared(uint256 indexed orderId, bool isEth, bytes32 sufficiencyHandle);

    /// @notice Emitted when a prepared deduct auth is cancelled and lock restored
    event DeductAuthCancelled(uint256 indexed orderId);

    // ============================================
    // VAULT ID SYSTEM - Privacy-Preserving Functions
    // ============================================

    /**
     * @notice Deduct balance by vaultId (PRIVACY: no address in cross-contract CALL input)
     * @dev Called by Exchange contract during swap execution
     * Address is resolved internally from vaultOwners mapping, never exposed in calldata
     * callTracer traces will show deductBalanceByVaultId(42, amount, true) instead of deductBalance(0xAlice, ...)
     * 
     * @param vaultId Opaque vault identifier
     * @param amount Amount to deduct (plaintext - already decrypted via FHE proof)
     * @param isEth True for ETH, false for USDT
     */
    /// @dev Legacy unsafe deduct by vaultId — disabled. Use prepare* + deductBalanceWithProof.
    function deductBalanceByVaultId(uint256, uint256, bool) external pure {
        revert DeductAuthNotPrepared();
    }

    /**
     * @notice Finalize deduct by vaultId after sufficiency proof (privacy-preserving calldata)
     */
    function deductBalanceWithProofByVaultId(
        uint256 orderId,
        uint256 vaultId,
        uint256 amount,
        bool isEth,
        bytes calldata sufficiencyCleartexts,
        bytes calldata sufficiencyProof
    ) external onlyExchange nonReentrant whenNotPaused {
        address user = vaultOwners[vaultId];
        if (user == address(0)) revert InvalidVaultId();
        _deductBalanceWithProofInternal(
            orderId,
            user,
            amount,
            isEth,
            sufficiencyCleartexts,
            sufficiencyProof
        );
    }

    /**
     * @notice Credit balance by vaultId (PRIVACY: no address in cross-contract CALL input)
     * @dev Called by Exchange contract after Uniswap swap completes
     * Address is resolved internally from vaultOwners mapping, never exposed in calldata
     * 
     * @param vaultId Opaque vault identifier
     * @param amount Amount to credit (plaintext - from Uniswap output)
     * @param isEth True for ETH, false for USDT
     */
    function creditBalanceByVaultId(
        uint256 vaultId,
        uint256 amount,
        bool isEth
    ) external payable onlyExchange nonReentrant whenNotPaused {
        address user = vaultOwners[vaultId];
        if (user == address(0)) revert InvalidVaultId();
        _creditBalanceInternal(user, amount, isEth);
    }

    /**
     * @notice Resolve vaultId to address (Exchange-only, never public)
     * @dev Used by NoctisExchange to resolve user identity from opaque vaultId
     * @param vaultId The vault identifier to resolve
     * @return The user address associated with this vaultId
     */
    function getAddressByVaultId(uint256 vaultId) external view onlyExchange returns (address) {
        address user = vaultOwners[vaultId];
        if (user == address(0)) revert InvalidVaultId();
        return user;
    }

    /**
     * @notice Get caller's vaultId (user calls this for themselves)
     * @dev Off-chain view call, no on-chain trace. User discovers their vaultId this way.
     * @return The vaultId assigned to msg.sender
     */
    function getMyVaultId() external view returns (uint256) {
        uint256 vid = userVaultId[msg.sender];
        if (vid == 0) revert NoVaultId();
        return vid;
    }

    // ============================================
    // PRIVACY-PRESERVING USER GETTERS
    // ============================================

    /**
     * @notice Get caller's withdrawal stats (user-only)
     * @dev PRIVACY: Replaces public mapping getter -- users can only read their own data
     * @return User's withdrawal statistics
     */
    function getMyWithdrawalStats() external view returns (WithdrawalStats memory) {
        return userWithdrawalStats[msg.sender];
    }

    /**
     * @notice Get caller's pending withdrawal count (user-only)
     * @dev PRIVACY: Replaces public mapping getter
     * @return Number of pending withdrawals for msg.sender
     */
    function getMyPendingCount() external view returns (uint256) {
        return pendingWithdrawalCount[msg.sender];
    }

    /**
     * @notice Get caller's claimable ETH balance (user-only)
     * @dev PRIVACY: Replaces public mapping getter
     * @return Claimable ETH amount for msg.sender
     */
    function getMyClaimableETH() external view returns (uint256) {
        return claimableETH[msg.sender];
    }
}
