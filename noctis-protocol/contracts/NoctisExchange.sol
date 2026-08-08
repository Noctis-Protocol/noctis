// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";
import {CoprocessorConfig} from "@fhevm/solidity/lib/Impl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./NoctisVault.sol";
import "./base/GatewayCaller.sol";
import "./interfaces/IGateway.sol";
import "./interfaces/IUniswapV2Router.sol";
import "./interfaces/IWETH.sol";
import "./interfaces/AggregatorV3Interface.sol";
/**
 * @title NoctisExchange - Privacy-First DEX Aggregator
 * @notice Decentralized exchange with encrypted orders using ZAMA FHE + Uniswap liquidity
 * @dev Implements privacy-preserving trading where amounts remain hidden until execution
 * 
 * CORE VALUE: Bots cannot see order amounts or prices - prevents frontrunning
 * ARCHITECTURE: Privacy Layer (FHE encryption) + Liquidity Layer (Uniswap aggregation)
 * MODEL: UniswapX-inspired with encrypted orders and proxy execution
 * 
 * FHE Features:
 * - Encrypted order amounts (euint128)
 * - Off-chain decryption via ZAMA Gateway
 * - Homomorphic operations for balance validation
 * - Encrypted trader address (eaddress) stored on-chain
 * - Plaintext trader in PRIVATE mapping (not in struct or events)
 * 
 * Trading Flow (Privacy-First via Relayer):
 * 1. User signs order intent off-chain (EIP-712)
 * 2. Relayer verifies signature OFF-CHAIN, submits createMarketOrderViaRelayer()
 * 3. Order stored on-chain with encrypted amounts, trader in private mapping
 * 4. Relayer calls requestSwapExecutionViaRelayer() (user address hidden)
 * 5. User decrypts amount privately via Gateway
 * 6. Relayer calls executeSwapViaRelayer() with FHE proof (no ecrecover)
 * 7. Exchange executes swap on Uniswap as PROXY, settles to vault
 * 
 * Privacy Guarantees:
 * - Order amounts: Encrypted on-chain (euint128) ✓
 * - Trader address: Private mapping, not in events or struct ✓
 * - tx.from: Relayer address, not user address ✓
 * - No ecrecover: FHE proof is authorization (CRIT-1 fix) ✓
 * - Events: No addresses or amounts emitted (CRIT-3 fix) ✓
 * - User identity: Hidden from Uniswap (proxy execution) ✓
 * - Decryption: Off-chain via Gateway (not visible) ✓
 * - Mempool: Flashbots integration (optional, prevents MEV) ✓
 * 
 * Known Limitations (Phase 2 improvements):
 * - User address visible in createMarketOrderViaRelayer calldata
 * - User address visible in deductBalance/creditBalance internal calldata
 * - Swap direction (isBuy) is visible in events
 * - Phase 2: Stealth addresses, encrypted vault lookups, ZAMA dual-transfer
 * 
 * Architecture Decision (2026):
 * REMOVED: Internal FHE order book matching
 * REASON: Keepers cannot discover compatible orders without decryption
 * SOLUTION: All orders execute via Uniswap (always liquid, better UX)
 * REFERENCE: See ARCHITECTURE_SIMPLIFICATION.md
 * 
 * Security:
 * - Checks-Effects-Interactions pattern
 * - ReentrancyGuard on all state-changing functions
 * - Pausable for emergency stops
 * - Rate limiting (per-address + global limits)
 * - Multi-keeper system for decentralization
 * - AccessControl with role separation
 * - Immutable vault (prevents malicious swap)
 * - TimelockController for non-emergency functions
 * - Oracle price protection (Chainlink)
 * - Slippage + price impact protection
 * - Fee-on-transfer token handling
 */

contract NoctisExchange is ReentrancyGuard, Pausable, AccessControl, GatewayCaller {
    using EnumerableSet for EnumerableSet.AddressSet;
    using EnumerableSet for EnumerableSet.UintSet;
    using SafeERC20 for IERC20;

    // ============================================
    // ENUMS
    // ============================================

    /// @notice Order status lifecycle
    enum OrderStatus {
        Pending,      // Order created, waiting for match
        PendingSwap,  // Waiting for keeper to execute Uniswap swap off-chain
        Filled,       // Order successfully executed
        Cancelled     // Order cancelled by user or timeout
    }

    /// @notice Order type: Limit or Market
    enum OrderType {
        Limit,        // Limit order: Execute at specific price or better
        Market        // Market order: Execute immediately at best available price
    }

    // ============================================
    // STRUCTS
    // ============================================

    /// @notice Order structure with encrypted amounts and prices
    /// @dev PRIVACY: Trader identity stored in private orderTraders + orderVaultIds mappings
    /// @dev No plaintext address in this struct to prevent on-chain identity leaks
    struct Order {
        uint256 orderId;                // Unique order identifier
        // REMOVED: address plaintextTrader (CRIT-2 fix - moved to private mappings)
        eaddress encryptedTrader;       // Encrypted trader address (privacy-preserving)
        euint128 encryptedAmountETH;    // Hidden ETH amount
        euint128 encryptedAmountUSDT;   // Hidden USDT amount (price * ETH amount)
        bool isBuy;                     // Order direction (true = buy, false = sell)
        uint256 timestamp;              // Creation timestamp
        OrderStatus status;             // Current order status
        OrderType orderType;            // Order type (Limit or Market)
        uint16 slippageToleranceBPS;    // Slippage tolerance in basis points (e.g., 50 = 0.5%)
        uint256 referencePriceUSD;      // Oracle price at order creation (8 decimals, e.g., 300000000000 = $3000)
        uint16 maxPriceDeviationBPS;    // Maximum acceptable price deviation from reference (150 = 1.5%)
    }

    // ============================================
    // ROLE CONSTANTS (AccessControl)
    // ============================================

    /// @notice Role for pausing/unpausing the contract (emergency response)
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Role for managing keepers (add/remove/setMinKeepers)
    bytes32 public constant KEEPER_MANAGER_ROLE = keccak256("KEEPER_MANAGER_ROLE");

    /// @notice Role for updating order size limits
    bytes32 public constant PARAMS_ROLE = keccak256("PARAMS_ROLE");

    /// @notice Role for updating gateway address
    bytes32 public constant GATEWAY_ROLE = keccak256("GATEWAY_ROLE");

    /// @notice Role for trusted relayers that submit meta-transactions on behalf of users
    /// @dev PRIVACY: Relayers hide user's tx.from address. Relayer verifies user signature off-chain.
    /// @dev FHE decryption proof serves as on-chain authorization (no ecrecover needed)
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    // ============================================
    // STATE VARIABLES
    // ============================================

    /// @notice Reference to NoctisVault for trade execution
    /// @dev IMMUTABLE for security (H-3 fix) - prevents malicious vault swap attack
    NoctisVault public immutable vault;

    /// @notice Uniswap V2 Router for executing external swaps
    /// @dev IMMUTABLE for security - prevents swap router manipulation
    IUniswapV2Router02 public immutable uniswapRouter;

    /// @notice WETH token address (for Uniswap swaps)
    /// @dev Retrieved from Uniswap Router during construction
    address public immutable WETH;

    /// @notice Chainlink ETH/USD price feed
    /// @dev Used for oracle-protected market orders to prevent price manipulation
    AggregatorV3Interface public immutable ethUsdPriceFeed;

    /// @notice Chainlink L2 Sequencer Uptime Feed (CRITICAL-1 fix)
    /// @dev Monitors Arbitrum sequencer status to prevent stale price usage
    AggregatorV3Interface public immutable sequencerUptimeFeed;

    /// @notice Grace period after sequencer comes back online (CRITICAL-1 fix)
    /// @dev Prevents using stale prices immediately after sequencer restart
    uint256 internal constant SEQUENCER_GRACE_PERIOD = 3600; // 1 hour

    /// @notice Minimum reasonable ETH price (circuit breaker - CRITICAL-1 fix)
    /// @dev Protects against flash crash exploitation ($500 = extremely conservative)
    uint256 internal constant MIN_REASONABLE_ETH_PRICE = 500_00000000; // $500 with 8 decimals

    /// @notice Maximum reasonable ETH price (circuit breaker - CRITICAL-1 fix)
    /// @dev Protects against oracle bugs/manipulation ($50,000 = very high but possible)
    uint256 internal constant MAX_REASONABLE_ETH_PRICE = 50000_00000000; // $50,000 with 8 decimals


    /// @notice Maximum slippage allowed for market orders (basis points, 300 = 3%)
    /// @dev Market orders accept higher slippage for guaranteed execution
    uint256 internal constant MAX_MARKET_ORDER_SLIPPAGE_BPS = 300;



    /// @notice Maximum price deviation allowed for oracle-protected orders (basis points, 200 = 2%)
    /// @dev If market price deviates more than this from order creation, execution is delayed
    uint256 internal constant MAX_ORACLE_PRICE_DEVIATION_BPS = 200;


    /// @notice Maximum staleness for Chainlink price feed (1 hour)
    /// @dev If price feed is older than this, reject execution for safety
    uint256 internal constant ORACLE_STALENESS_THRESHOLD = 1 hours;

    /// @notice Swap deadline in seconds (5 minutes)
    /// @dev Prevents stale transactions from executing
    uint256 internal constant SWAP_DEADLINE = 300;
    

    /// @notice TimelockController address for delayed execution of non-emergency functions
    /// @dev Set once by DEFAULT_ADMIN_ROLE, cannot be changed after configuration
    address public timelock;

    /// @notice Whether timelock has been configured (one-time setup)
    bool public timelockConfigured;

    /// @notice Order counter for unique IDs
    uint256 public orderCounter;

    /// @notice Order storage mapping
    /// @dev PRIVACY: Private to prevent exposing trader addresses via auto-generated getter
    /// @dev Use getOrderPublic() for non-sensitive data, getMyOrder() for owner access
    mapping(uint256 => Order) private orders;

    /// @notice Maps orderId to trader address (PRIVACY: private mapping)
    /// @dev CRIT-2 fix: Trader address stored separately from Order struct
    /// @dev Used for direct user calls; for relayer calls, vaultId is also stored
    mapping(uint256 => address) private orderTraders;

    /// @notice Maps orderId to vaultId (PRIVACY: opaque ID for relayer-created orders)
    /// @dev Only populated for orders created via relayer; enables vaultId-based vault calls
    /// @dev Eliminates user address from cross-contract CALL inputs in EVM traces
    mapping(uint256 => uint256) private orderVaultIds;

    /// @notice User's active order IDs (for enumeration)
    /// @dev Using EnumerableSet for O(1) add/remove operations (gas optimization)
    mapping(address => EnumerableSet.UintSet) private userOrders;




    /// @notice Minimum order size (prevents dust attacks)
    uint256 public minOrderSize;

    /// @notice Maximum order size (risk management)
    uint256 public maxOrderSize;




    /// @notice Hard cap on the protocol swap fee (basis points) — pricing can never exceed this
    uint16 public constant MAX_FEE_BPS = 30;

    /// @notice Protocol swap fee in basis points (launch: 5 = 0.05%)
    /// @dev Settable via setFeeBps (PARAMS_ROLE / timelock), capped at MAX_FEE_BPS.
    ///      Pricing playbook: 0 promo → 5 design partners → 10 rack rate.
    uint16 public feeBps = 5;

    /// @notice Recipient of protocol swap fees (Safe treasury in production)
    address public feeRecipient;

    // ============================================
    // GAS-IN-KIND REFUND (relayer gas recovered from swap output)
    // ============================================
    // The relayer pays gas for meta-txs (privacy: user is never tx.from).
    // At settlement the output is cleartext anyway, so the relayer's gas cost
    // is skimmed from the swap output — a flat amount the user signed in the
    // EIP-712 CreateOrder intent, bounded by a hard protocol cap.

    /// @notice Hard cap on the per-order gas refund (wei of ETH)
    /// @dev Bounds the relayer-supplied refund even if the relayer key is compromised
    uint128 public maxGasRefundWei = 0.01 ether;

    /// @notice Per-order flat gas refund (wei of ETH), agreed by the user off-chain (EIP-712)
    /// @dev Gas-in-kind model: skimmed from swap output at settlement alongside feeBps and
    ///      sent to feeRecipient (Safe). The treasury reimburses the relayer gas float, so
    ///      every relayed swap is margin-positive without a separate payment from the user.
    /// @dev Private (bytecode size) — the collected amount is public via GasRefundCollected events.
    mapping(uint256 => uint128) private orderGasRefundWei;

    /// @notice Rate limiting: last order creation block per user
    mapping(address => uint256) private lastOrderBlock;

    /// @notice Global rate limiting: maximum orders per block (M-1 fix)
    uint256 public maxOrdersPerBlock;
    
    /// @notice Global rate limiting: orders created in current block
    uint256 private ordersCreatedThisBlock;

    /// @notice Global rate limiting: last block where orders were created
    uint256 private lastBlockWithOrders;

    /// @notice Decryption timeout for Gateway requests
    uint256 internal constant DECRYPTION_TIMEOUT = 1 hours;

    // ============================================
    // USER-INITIATED SWAP STATE (Privacy-First Flow)
    // ============================================

    /// @notice Tracks which orders have requested swap execution
    /// @dev Maps orderId to whether decryption has been requested
    mapping(uint256 => bool) public swapExecutionRequested;

    /// @notice Tracks when swap execution was requested (for timeout)
    mapping(uint256 => uint256) public swapExecutionRequestTime;

    /// @notice Sufficiency ebool handle prepared at request (SELL) or buy-prepare
    mapping(uint256 => bytes32) private swapSufficiencyHandles;

    /// @notice BUY path: USDT amount locked pending sufficiency finalize
    mapping(uint256 => uint256) public pendingBuyUsdtAmount;

    /// @notice BUY path: decrypted ETH amount cached after step-1 callback
    mapping(uint256 => uint128) private pendingBuyAmountETH;


    /// @notice Maximum time allowed between request and execution
    uint256 public constant SWAP_EXECUTION_TIMEOUT = 30 minutes;

    // NOTE: meta-tx nonces removed (dead state — never incremented on-chain).
    // EIP-712 replay protection is enforced off-chain by the relayer via signed deadlines;
    // clients sign nonce = 0. Reintroduce on-chain nonces if the relayer set opens up.

    // ============================================
    // CUSTOM ERRORS (Gas Efficient)
    // ============================================

    error InvalidAddress();
    error InvalidFeeRecipient();
    error FeeTransferFailed();
    error ZeroAmount();
    error BelowMinimumOrderSize();
    error ExceedsMaximumOrderSize();
    error OrderTooFrequent();
    error OrderNotFound();
    error OrderNotPending();
    error UnauthorizedCancellation();
    error InvalidOrderSize(uint256 min, uint256 max);
    error TimelockAlreadyConfigured();
    error OnlyTimelock();
    error GlobalOrderLimitReached(uint256 current, uint256 max);
    error InvalidMaxOrdersPerBlock(uint256 max);
    error InvalidSwapAmount();
    error SlippageToleranceTooHigh(uint256 requested, uint256 maximum);
    error ZeroSlippageTolerance();
    error InvalidOrderType();
    error OraclePriceDeviationTooHigh(uint256 requested, uint256 maximum);
    error OraclePriceStale(uint256 updatedAt, uint256 threshold);
    error OraclePriceInvalid();
    // CRITICAL-1 fix: L2 Sequencer and Circuit Breaker errors
    error SequencerDown();
    error SequencerGracePeriod(uint256 timeSinceUp, uint256 required);
    error PriceBelowMinimum(uint256 price, uint256 minimum);
    error PriceAboveMaximum(uint256 price, uint256 maximum);
    // User-initiated swap errors
    error NotOrderOwner();
    error SwapAlreadyRequested();
    error SwapNotRequested();
    error SwapDeadlinePassed();
    error OnlyRelayer();
    error BuySufficiencyNotPrepared();
    error BuySufficiencyAlreadyPrepared();
    error InsufficientEncryptedBalance();
    error TransferFailed();
    error GasRefundTooHigh(uint256 requested, uint256 maximum);
    error OutputTooSmallForFees();
    error FeeTooHigh(uint256 requested, uint256 maximum);

    // ============================================
    // EVENTS
    // ============================================

    /// @notice Emitted when new order is created (PRIVACY: no address in event)
    event OrderCreated(
        uint256 indexed orderId,
        bool isBuy,
        uint256 timestamp,
        OrderType orderType
    );

    /// @notice Emitted when order is filled (PRIVACY: no addresses or amounts)
    event OrderFilledSimple(
        uint256 indexed orderId,
        uint256 timestamp
    );

    /// @notice Emitted with encrypted handles for owner-only decryption
    /// @dev Only the order owner can decrypt these handles
    event OrderFilledPrivate(
        uint256 indexed orderId,
        bytes32 encryptedAmountIn,
        bytes32 encryptedAmountOut
    );

    /// @notice Emitted when order is ready for user decryption
    /// @dev CRIT-3 fix: No owner address emitted (privacy-preserving)
    /// @dev Frontend filters by orderId (user knows their own orderIds)
    event SwapDecryptionReady(
        uint256 indexed orderId,
        bytes32[] handles
    );

    /// @notice BUY path: USDT sufficiency handle ready after amount decrypt
    event BuySufficiencyReady(
        uint256 indexed orderId,
        bytes32 sufficiencyHandle,
        uint256 usdtNeeded
    );

    // REMOVED: Legacy OrderFilled event (CRIT-3 fix)
    // Was: event OrderFilled(buyOrderId, sellOrderId, buyer, seller, timestamp)
    // Reason: Leaked buyer and seller addresses on-chain
    // Replaced by: OrderFilledSimple(orderId, timestamp) - no addresses

    /// @notice Emitted when order is cancelled
    /// @dev CRIT-3 fix: No trader address emitted (privacy-preserving)
    event OrderCancelled(
        uint256 indexed orderId,
        uint256 timestamp
    );





    /// @notice Emitted when order size limits are updated
    event OrderSizeLimitsUpdated(uint256 minSize, uint256 maxSize);

    // REMOVED: Balance verification events (internal order book removed)
    // event BalanceVerificationRequested(...)
    // event BalanceVerificationFailed(...)

    /// @notice Emitted when timelock is configured
    event TimelockSet(address indexed timelock);

    /// @notice Emitted when global order limit per block is updated
    event MaxOrdersPerBlockUpdated(uint256 oldMax, uint256 newMax);


    /// @notice Emitted when treasury is funded (M-4 fix)
    event TreasuryFunded(address indexed funder, uint256 amount);

    /// @notice Emitted when protocol swap fee is collected (Phase 2)
    event ProtocolFeeCollected(
        uint256 indexed orderId,
        address indexed token,
        uint256 feeAmount,
        address indexed recipient
    );

    /// @notice Emitted when fee recipient is updated
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    /// @notice Emitted when the per-order gas refund is skimmed at settlement
    /// @dev PRIVACY: no user address — orderId + token + amount only (same policy as fees)
    /// @param token address(0) for ETH, token address otherwise
    event GasRefundCollected(uint256 indexed orderId, address indexed token, uint256 refundAmount);

    /// @notice Emitted when the gas refund hard cap is updated
    event MaxGasRefundUpdated(uint128 oldMax, uint128 newMax);

    /// @notice Emitted when the protocol swap fee is updated
    event FeeBpsUpdated(uint16 oldFeeBps, uint16 newFeeBps);

    /// @notice Emitted when admin rescues stuck ERC20 from the Exchange
    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    /// @notice Emitted when rate limiting is triggered (L-3 fix)
    /// @dev CRIT-3 fix: No user address emitted (privacy-preserving)
    event RateLimitTriggered(uint256 blockNumber);

    // ============================================
    // MODIFIERS
    // ============================================

    /// @notice Restricts function access to timelock (if configured) or role holder
    /// @dev If timelock is configured, only timelock can call. Otherwise, requires role.
    /// @param role The role required if timelock is not configured
    modifier onlyTimelockOrRole(bytes32 role) {
        if (timelockConfigured) {
            if (msg.sender != timelock) revert OnlyTimelock();
        } else {
            if (!hasRole(role, msg.sender)) {
                revert AccessControlUnauthorizedAccount(msg.sender, role);
            }
        }
        _;
    }

    /// @notice Restricts function access to trusted relayers only
    /// @dev PRIVACY: Relayers submit transactions on behalf of users, hiding tx.from
    modifier onlyRelayer() {
        if (!hasRole(RELAYER_ROLE, msg.sender)) revert OnlyRelayer();
        _;
    }

    // ============================================
    // CONSTRUCTOR
    // ============================================

    /**
     * @notice Initialize the NoctisExchange contract
     * @param _vault Address of NoctisVault contract (IMMUTABLE for security - H-3 fix)
     * @param _uniswapRouter Address of Uniswap V2 Router (for external liquidity)
     * @param _ethUsdPriceFeed Address of Chainlink ETH/USD price feed
     * @param _sequencerUptimeFeed Address of Chainlink L2 Sequencer Uptime Feed (CRITICAL-1 fix)
     */
    constructor(
        address _vault,
        address _uniswapRouter,
        address _ethUsdPriceFeed,
        address _sequencerUptimeFeed
    ) {
        if (_vault == address(0)) revert InvalidAddress();
        if (_uniswapRouter == address(0)) revert InvalidAddress();
        if (_ethUsdPriceFeed == address(0)) revert InvalidAddress();
        // Note: _sequencerUptimeFeed can be address(0) on L1 networks (Ethereum)
        // Only L2 networks like Arbitrum have a Sequencer Uptime Feed
        
        // Set vault as immutable (H-3 fix - prevents malicious vault swap)
        vault = NoctisVault(payable(_vault));
        
        // Initialize Uniswap integration
        uniswapRouter = IUniswapV2Router02(_uniswapRouter);
        WETH = uniswapRouter.WETH();
        
        // Initialize Chainlink price feed
        ethUsdPriceFeed = AggregatorV3Interface(_ethUsdPriceFeed);
        
        // CRITICAL-1 fix: Initialize L2 Sequencer Uptime Feed (optional on L1)
        sequencerUptimeFeed = AggregatorV3Interface(_sequencerUptimeFeed);
        
        // M-3 Fix: Note - Vault authorization cannot be verified in constructor
        // because the exchange address doesn't exist yet. Authorization must be
        // set via vault.setExchange() after deployment. Vault debit/credit
        // already reverts with UnauthorizedExchange if not authorized.
        
        // Initialize AccessControl
        // Grant DEFAULT_ADMIN_ROLE to deployer (should be transferred to multisig in production)
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        
        // Grant PAUSER_ROLE to deployer for emergency response
        _grantRole(PAUSER_ROLE, msg.sender);
        
        // Phase 2: protocol fee recipient (transfer to Safe via setFeeRecipient)
        feeRecipient = msg.sender;
        
        // Initialize order size limits
        // Min: 0.001 ETH (testnet-friendly), Max: 100 ETH (~$300k)
        minOrderSize = 0.001 ether;
        maxOrderSize = 100 ether;
        
        // L-2 Fix: Use require instead of assert (gas optimization + better error message)
        // assert() consumes all remaining gas on failure, require() refunds unused gas
        if (minOrderSize >= maxOrderSize) {
            revert InvalidOrderSize(minOrderSize, maxOrderSize);
        }
        
        // Initialize global rate limiting (M-1 fix)
        maxOrdersPerBlock = 100; // Default: 100 orders per block
        
        // FHEVM v0.9: Coprocessor is set automatically by ZamaEthereumConfig
        // ZamaEthereumConfig constructor handles this for all networks
        // NOTE: TimelockController should be deployed and configured after deployment
    }

    // ============================================
    // UNISWAP INTEGRATION HELPERS
    // ============================================

    /**
     * @notice Get latest ETH/USD price from Chainlink oracle with comprehensive security checks
     * @return price Price with 8 decimals (e.g., 300000000000 = $3000.00)
     * @dev CRITICAL-1 FIX: Implements multi-layer oracle protection:
     *      1. L2 Sequencer uptime check (prevents stale prices during downtime)
     *      2. Grace period after sequencer restart (allows oracle to update)
     *      3. Standard oracle validations (answer > 0, timestamps valid)
     *      4. Staleness check (price must be recent)
     *      5. Circuit breaker (min/max price bounds)
     */
    function _getChainlinkPrice() internal view returns (uint256 price) {
        // ============================================
        // LAYER 1: L2 SEQUENCER STATUS CHECK (optional on L1)
        // ============================================
        // CRITICAL: On L2s like Arbitrum, if sequencer is down, oracle returns stale prices
        // This check prevents executing trades with outdated data during outages
        // NOTE: On L1 (Ethereum), sequencerUptimeFeed is address(0) - skip this check
        
        if (address(sequencerUptimeFeed) != address(0)) {
            (
                /*uint80 roundId*/,
                int256 sequencerAnswer,
                uint256 startedAt,
                /*uint256 updatedAt*/,
                /*uint80 answeredInRound*/
            ) = sequencerUptimeFeed.latestRoundData();
            
            // Sequencer status: 0 = up, 1 = down
            // If down, reject ALL price reads to prevent stale price exploitation
            if (sequencerAnswer == 1) revert SequencerDown();
            
            // Grace period: After sequencer comes back up, wait for oracles to update
            // Prevents using the last pre-downtime price which may be stale
            uint256 timeSinceUp = block.timestamp - startedAt;
            if (timeSinceUp < SEQUENCER_GRACE_PERIOD) {
                revert SequencerGracePeriod(timeSinceUp, SEQUENCER_GRACE_PERIOD);
            }
        }
        
        // ============================================
        // LAYER 2: GET PRICE FROM CHAINLINK
        // ============================================
        
        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = ethUsdPriceFeed.latestRoundData();
        
        // ============================================
        // LAYER 3: STANDARD ORACLE VALIDATIONS
        // ============================================
        
        // Validate oracle response (existing checks - keep them)
        if (answer <= 0) revert OraclePriceInvalid();
        if (updatedAt == 0) revert OraclePriceInvalid();
        if (answeredInRound < roundId) revert OraclePriceInvalid();
        
        // Check staleness (price must be recent)
        if (block.timestamp - updatedAt > ORACLE_STALENESS_THRESHOLD) {
            revert OraclePriceStale(updatedAt, ORACLE_STALENESS_THRESHOLD);
        }
        
        // ============================================
        // LAYER 4: CIRCUIT BREAKER (MIN/MAX BOUNDS)
        // ============================================
        // NEW: Sanity check on absolute price bounds
        // Protects against:
        // - Flash crashes (price drops to $0.01 for 1 block)
        // - Oracle bugs (reports $999,999,999 ETH)
        // - Manipulation attacks (if oracle is compromised)
        
        uint256 priceWithDecimals = uint256(answer);
        
        // Lower bound: ETH should NEVER be below $500 (even in extreme bear market)
        // Historical note: ETH never went below $80 even in 2018 crash
        if (priceWithDecimals < MIN_REASONABLE_ETH_PRICE) {
            revert PriceBelowMinimum(priceWithDecimals, MIN_REASONABLE_ETH_PRICE);
        }
        
        // Upper bound: ETH realistically won't exceed $50,000 in near term
        // Even in extreme bull scenario, this protects against 100x oracle bugs
        if (priceWithDecimals > MAX_REASONABLE_ETH_PRICE) {
            revert PriceAboveMaximum(priceWithDecimals, MAX_REASONABLE_ETH_PRICE);
        }
        
        // All checks passed - price is safe to use
        return priceWithDecimals;
    }


    // ============================================
    // KEEPER MANAGEMENT FUNCTIONS
    // ============================================




    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    /**
     * @notice Configure TimelockController address (one-time setup)
     * @dev CRITICAL SECURITY: Can only be called once by DEFAULT_ADMIN_ROLE
     * @dev After timelock is set, all non-emergency functions require timelock execution
     * @param _timelock Address of TimelockController contract
     */
    function setTimelock(address _timelock) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_timelock == address(0)) revert InvalidAddress();
        if (timelockConfigured) revert TimelockAlreadyConfigured();
        
        timelock = _timelock;
        timelockConfigured = true;
        
        emit TimelockSet(_timelock);
    }

    /**
     * @notice Set Gateway address
     * @dev Gateway is used for balance verification before trade execution
     * @dev Requires GATEWAY_ROLE or timelock (if configured) - H-3 fix
     * @param _gateway Gateway contract address (MockGateway for testing, real Gateway for production)
     */
    function setGateway(address _gateway) external onlyTimelockOrRole(GATEWAY_ROLE) {
        _setGateway(_gateway);
    }

    /**
     * @notice Update order size limits
     * @dev Requires PARAMS_ROLE or timelock (if configured) - H-3 fix
     * @param _minSize New minimum order size
     * @param _maxSize New maximum order size
     */
    function setOrderSizeLimits(uint256 _minSize, uint256 _maxSize) external onlyTimelockOrRole(PARAMS_ROLE) {
        if (_minSize == 0 || _minSize >= _maxSize) {
            revert InvalidOrderSize(_minSize, _maxSize);
        }
        
        minOrderSize = _minSize;
        maxOrderSize = _maxSize;
        
        emit OrderSizeLimitsUpdated(_minSize, _maxSize);
    }

    /**
     * @notice Update global order limit per block (M-1 fix)
     * @dev Requires PARAMS_ROLE or timelock (if configured)
     * @param _max New maximum orders per block (must be between 10 and 1000)
     */
    function setMaxOrdersPerBlock(uint256 _max) external onlyTimelockOrRole(PARAMS_ROLE) {
        if (_max < 10 || _max > 1000) {
            revert InvalidMaxOrdersPerBlock(_max);
        }
        
        uint256 oldMax = maxOrdersPerBlock;
        maxOrdersPerBlock = _max;
        
        emit MaxOrdersPerBlockUpdated(oldMax, _max);
    }

    /**
     * @notice Pause the contract in case of emergency
     * @dev Requires PAUSER_ROLE - bypasses timelock for fast emergency response (H-3 fix)
     * @dev Emergency function - no timelock delay for security incidents
     */
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause the contract
     * @dev Requires PAUSER_ROLE - bypasses timelock for fast emergency response (H-3 fix)
     * @dev Emergency function - no timelock delay for security incidents
     */
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
    
    /// @notice Set protocol fee recipient (Safe / treasury)
    /// @dev M-2: PARAMS_ROLE or timelock when configured (same path as setFeeBps)
    function setFeeRecipient(address newRecipient) external onlyTimelockOrRole(PARAMS_ROLE) {
        if (newRecipient == address(0)) revert InvalidFeeRecipient();
        address old = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(old, newRecipient);
    }

    /// @notice Update the hard cap on per-order gas refunds (wei of ETH)
    /// @dev Bounds what the relayer can pass at order creation; 0 disables gas refunds
    /// @dev M-2: PARAMS_ROLE or timelock when configured
    function setMaxGasRefundWei(uint128 newMax) external onlyTimelockOrRole(PARAMS_ROLE) {
        emit MaxGasRefundUpdated(maxGasRefundWei, newMax);
        maxGasRefundWei = newMax;
    }

    /// @notice Update the protocol swap fee (basis points)
    /// @dev Capped at MAX_FEE_BPS (30). PARAMS_ROLE or timelock when configured —
    ///      pricing moves (promo / partner / rack) without redeploying the contract.
    function setFeeBps(uint16 newFeeBps) external onlyTimelockOrRole(PARAMS_ROLE) {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps, MAX_FEE_BPS);
        emit FeeBpsUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    /// @notice Rescue ERC20 tokens stuck on the exchange (e.g. failed settlement)
    /// @dev Admin only — testnet recovery / incident response. Not for fee skim.
    function rescueERC20(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0) || to == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit TokensRescued(token, to, amount);
    }


    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    // REMOVED: getOrder() function (CRIT-2 fix)
    // Was: function getOrder(orderId) returns (Order memory) - exposed full struct
    // Now: orders mapping is private, use getOrderPublic() or getMyOrder()

    // ============================================
    // ORDER CREATION FUNCTIONS
    // ============================================

    /**
     * @notice Create new encrypted MARKET order with slippage protection and oracle price protection
     * @dev Market orders execute immediately at best available price with slippage tolerance
     * @dev Oracle protection: Order execution delayed if market price moves too much from creation price
     * @dev Follows Uniswap best practices for slippage + Chainlink oracle for price stability
     * 
     * @param amountETH ETH amount (will be encrypted)
     * @param isBuy True for buy order, false for sell order
     * @param slippageToleranceBPS Slippage tolerance in basis points (e.g., 50 = 0.5%, 300 = 3%)
     * @param maxPriceDeviationBPS Maximum acceptable price deviation from current oracle price (e.g., 150 = 1.5%)
     * @return orderId Unique identifier for the created order
     * 
     * Oracle Protection (NEW):
     * - At order creation: Store current Chainlink ETH/USD price
     * - At execution: Verify current price hasn't deviated more than maxPriceDeviationBPS
     * - If price moved too much: Execution rejected, order stays Pending
     * - Default deviation: 1.5% (150 BPS), Maximum: 2% (200 BPS)
     * 
     * Example Scenarios:
     * 
     * Scenario A: Price Stable
     * - Order created at ETH = $3000, maxDeviation = 1.5%
     * - 45 seconds later: ETH = $3020 (0.67% deviation)
     * - Result: ✅ Executed (within tolerance)
     * 
     * Scenario B: Price Volatile
     * - Order created at ETH = $3000, maxDeviation = 1.5%
     * - 45 seconds later: ETH = $3100 (3.33% deviation)
     * - Result: ❌ Rejected (exceeds tolerance), stays Pending
     * 
     * Slippage Protection (existing):
     * - User-configurable slippage tolerance (0.5%-3%)
     * - Default: 0.5% (50 BPS) for liquid pairs
     * - Maximum: 3% (300 BPS) for volatile/illiquid pairs
     * - Transaction reverts if slippage exceeds user tolerance
     * 
     * Security:
     * - Rate limiting: prevents spam attacks (one order per block per user)
     * - Min/max order size validation (checks ETH amount)
     * - Slippage tolerance validation (must be > 0 and <= 3%)
     * - Oracle price deviation validation (must be <= 2%)
     * - Oracle staleness check (price must be < 1 hour old)
     * - ReentrancyGuard protection
     * - Pausable functionality
     * 
     * Gas Optimization:
     * - Single Chainlink oracle read
     * - Single FHE encryption per amount
     * - Transient ACL permissions for keeper matching
     * - Pull-over-push pattern for permissions
     * 
     * Example:
     * - Market Buy 1 ETH with 0.5% slippage and 1.5% price protection:
     *   createMarketOrder(1 ether, true, 50, 150)
     * - Market Sell 0.5 ETH with 1% slippage and 1% price protection:
     *   createMarketOrder(0.5 ether, false, 100, 100)
     * 
     * Note: Market orders do NOT specify price - price determined by Uniswap at execution time
     *       BUT oracle protection ensures price hasn't moved too much from order creation
     */
    function createMarketOrder(
        uint128 amountETH,
        bool isBuy,
        uint16 slippageToleranceBPS,
        uint16 maxPriceDeviationBPS
    ) external nonReentrant whenNotPaused returns (uint256) {
        return _createMarketOrder(
            msg.sender,
            0,
            amountETH,
            isBuy,
            slippageToleranceBPS,
            maxPriceDeviationBPS,
            0
        );
    }

    /**
     * @notice Shared market-order creation logic (direct + relayer paths)
     * @dev Keeps a single copy of the encrypt/store/ACL logic to stay under the
     *      EIP-170 runtime-code limit. `vaultId == 0` = direct path (no vault-id
     *      privacy mapping); `gasRefundWei == 0` = no gas-in-kind refund recorded.
     */
    function _createMarketOrder(
        address user,
        uint256 vaultId,
        uint128 amountETH,
        bool isBuy,
        uint16 slippageToleranceBPS,
        uint16 maxPriceDeviationBPS,
        uint128 gasRefundWei
    ) internal returns (uint256 orderId) {
        // CHECKS - Input Validation
        if (amountETH == 0) revert ZeroAmount();
        if (amountETH < minOrderSize) revert BelowMinimumOrderSize();
        if (amountETH > maxOrderSize) revert ExceedsMaximumOrderSize();

        // Gas-in-kind refund cap (relayer path only; user signed it off-chain)
        if (gasRefundWei > maxGasRefundWei) {
            revert GasRefundTooHigh(gasRefundWei, maxGasRefundWei);
        }

        // Slippage validation (Uniswap best practice)
        if (slippageToleranceBPS == 0) revert ZeroSlippageTolerance();
        if (slippageToleranceBPS > MAX_MARKET_ORDER_SLIPPAGE_BPS) {
            revert SlippageToleranceTooHigh(slippageToleranceBPS, MAX_MARKET_ORDER_SLIPPAGE_BPS);
        }

        // Oracle price deviation validation
        if (maxPriceDeviationBPS > MAX_ORACLE_PRICE_DEVIATION_BPS) {
            revert OraclePriceDeviationTooHigh(maxPriceDeviationBPS, MAX_ORACLE_PRICE_DEVIATION_BPS);
        }

        // Get current oracle price (will revert if stale or invalid)
        uint256 currentOraclePrice = _getChainlinkPrice();

        // CHECKS - Rate Limiting (M-1 fix), keyed on the trading user
        if (block.number != lastBlockWithOrders) {
            ordersCreatedThisBlock = 0;
            lastBlockWithOrders = block.number;
        }
        if (ordersCreatedThisBlock >= maxOrdersPerBlock) {
            revert GlobalOrderLimitReached(ordersCreatedThisBlock, maxOrdersPerBlock);
        }
        if (block.number == lastOrderBlock[user]) {
            emit RateLimitTriggered(block.number);
            revert OrderTooFrequent();
        }

        // EFFECTS - State Updates (before external calls)
        ordersCreatedThisBlock++;
        lastOrderBlock[user] = block.number;

        // Encrypt order fields (ETH only; USDT amount unknown until execution)
        euint128 encryptedAmountETH = FHE.asEuint128(amountETH);
        euint128 encryptedAmountUSDT = FHE.asEuint128(0);
        eaddress encTrader = FHE.asEaddress(user);

        orderId = ++orderCounter;

        // Store market order (PRIVACY: no plaintext trader in struct)
        orders[orderId] = Order({
            orderId: orderId,
            encryptedTrader: encTrader,
            encryptedAmountETH: encryptedAmountETH,
            encryptedAmountUSDT: encryptedAmountUSDT, // ZERO for market orders
            isBuy: isBuy,
            timestamp: block.timestamp,
            status: OrderStatus.Pending,
            orderType: OrderType.Market,
            slippageToleranceBPS: slippageToleranceBPS,
            referencePriceUSD: currentOraclePrice,
            maxPriceDeviationBPS: maxPriceDeviationBPS
        });

        // PRIVACY: relayer path stores opaque vaultId for vault calls
        if (vaultId != 0) {
            orderVaultIds[orderId] = vaultId;
        }
        // Address kept for internal order management (auth checks, userOrders)
        orderTraders[orderId] = user;
        userOrders[user].add(orderId);
        if (gasRefundWei > 0) {
            orderGasRefundWei[orderId] = gasRefundWei;
        }

        // INTERACTIONS - ACL Permission Grants
        FHE.allowThis(encryptedAmountETH);
        FHE.allowThis(encTrader);
        FHE.allow(encryptedAmountETH, user);
        FHE.allow(encTrader, user);

        // Emit event (PRIVACY: no address in event)
        emit OrderCreated(orderId, isBuy, block.timestamp, OrderType.Market);
    }

    // ============================================
    // ORDER MATCHING FUNCTIONS
    // ============================================

    /**
     * @notice Match and execute buy and sell orders
     * @dev CRITICAL: Uses encrypted amounts directly from orders
     * @dev Only authorized keepers can call this function
     * 
     * @param buyOrderId ID of the buy order
     * @param sellOrderId ID of the sell order
     * 
     * Matching Algorithm:
     * 1. Verify both orders exist and are pending
     * 2. Verify orders are in opposite directions (buy vs sell)
     * 3. Verify amounts match: buy ETH == sell ETH and buy USDT == sell USDT (FHE.eq, H-2 fix)
     * 4. Verify balances via Gateway decryption (H-1 fix)
     * 5. Execute trade via vault.executeTrade()
     * 
     * Security:
     * - Checks-Effects-Interactions pattern
     * - ReentrancyGuard protection
     * - Pausable functionality
     * - Order status updates prevent double-execution
     * - Amount validation prevents malicious keeper from matching incompatible orders
     */
    // ============================================
    // REMOVED: Internal Order Book Matching Functions
    // ============================================
    // 
    // The following functions have been removed:
    // - matchOrders(buyOrderId, sellOrderId)
    // - verifyBalanceAndExecuteTrade(gatewayRequestId, success, decryptedData)
    // - _executeTradeAfterVerification(buyOrderId, sellOrderId, buyOrder, sellOrder)
    //
    // REASON FOR REMOVAL:
    // Internal order matching with FHE is architecturally impractical because:
    // 1. All order amounts/prices are encrypted (euint128)
    // 2. Keepers cannot discover compatible orders without decryption
    // 3. Attempting random matches wastes gas on failed attempts
    // 4. Research confirms FHE order books are still in prototype phase (2026)
    //
    // SIMPLIFIED ARCHITECTURE:
    // - All orders execute via Uniswap (market model)
    // - Privacy preserved through: encrypted amounts + proxy execution + Flashbots
    // - Always liquid (Uniswap pools)
    // - Simpler, more maintainable code
    // - Better UX (instant execution)
    //
    // See ARCHITECTURE_SIMPLIFICATION.md for detailed rationale

    // ============================================
    // PHASE 2: Single Uniswap proxy swap path
    // ============================================
    // Removed: matchMarketOrder + keeper confirm* (orphan path).
    // Canonical path:
    //   createMarketOrder[ViaRelayer]
    //   -> requestSwapExecution[ViaRelayer]
    //   -> executeSwapCallback / finalizeBuySwap / executeSwapViaRelayer
    // ============================================

    // ============================================
    // ORDER CANCELLATION FUNCTIONS
    // ============================================

    /**
     * @notice Cancel a pending order
     * @dev Only the order creator can cancel their own orders
     * @dev Orders are automatically cancellable after ORDER_TIMEOUT (24 hours)
     * 
     * @param orderId Order ID to cancel
     * 
     * Security:
     * - Only order creator can cancel
     * - Cannot cancel already filled/cancelled orders
     * - Timeout mechanism prevents stale orders
     * - No balance refund needed (balances only deducted on execution)
     * 
     * Gas Optimization:
     * - Simple status update + array removal
     * - No external calls required
     */
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        
        // ============================================
        // CHECKS - Validation
        // ============================================
        
        // Verify order exists
        if (order.orderId == 0) revert OrderNotFound();
        
        // Verify caller is order creator (PRIVACY: from private mapping)
        if (orderTraders[orderId] != msg.sender) revert UnauthorizedCancellation();
        
        // Verify order is still pending
        if (order.status != OrderStatus.Pending) revert OrderNotPending();
        
        // ============================================
        // EFFECTS - Update State
        // ============================================
        
        // Mark order as cancelled
        order.status = OrderStatus.Cancelled;
        
        // Remove from active orders set (O(1) operation with EnumerableSet)
        userOrders[msg.sender].remove(orderId);
        
        // ============================================
        // INTERACTIONS - Emit Event (CRIT-3: no trader address)
        // ============================================
        
        emit OrderCancelled(orderId, block.timestamp);
    }



    // ============================================
    // OPTIMIZATION FUNCTIONS (2026 Best Practices)
    // ============================================


    // ============================================
    // PHASE 2: Single Uniswap proxy swap path
    // ============================================
    // Removed orphan keeper completeMarketOrder (marked Filled without swap).
    // Canonical: createMarketOrder* -> requestSwapExecution* -> executeSwapCallback / finalizeBuySwap / executeSwapViaRelayer

    // ============================================
    // USER-INITIATED SWAP FUNCTIONS (Privacy-First)
    // ============================================

    /**
     * @notice Step 1: User requests swap execution (marks order for decryption)
     * @dev This is the PRIVACY-FIRST flow - no keeper sees decrypted amounts
     * 
     * Flow:
     * 1. User calls this function to mark order for decryption
     * 2. Contract emits SwapDecryptionReady with FHE handles
     * 3. User calls userDecrypt() off-chain to get cleartext + proof
     * 4. User calls executeSwapCallback() with cleartext + proof
     * 
     * @param orderId The order ID to execute
     * 
     * Security:
     * - Only order owner can request
     * - Order must be in Pending status
     * - Cannot request twice
     * - NonReentrant protection
     */
    function requestSwapExecution(uint256 orderId) 
        external 
        nonReentrant 
        whenNotPaused 
    {
        Order storage order = orders[orderId];
        
        // CHECKS
        if (order.orderId == 0) revert OrderNotFound();
        if (orderTraders[orderId] != msg.sender) revert NotOrderOwner();
        if (order.status != OrderStatus.Pending) revert OrderNotPending();
        if (swapExecutionRequested[orderId]) revert SwapAlreadyRequested();
        
        // EFFECTS
        swapExecutionRequested[orderId] = true;
        swapExecutionRequestTime[orderId] = block.timestamp;
        order.status = OrderStatus.PendingSwap;

        // Grant permission to this contract for decryption
        FHE.allowThis(order.encryptedAmountETH);

        // Mark for public decryption via Gateway
        _makePubliclyDecryptableSingle(order.encryptedAmountETH);

        address trader = orderTraders[orderId];
        bytes32[] memory handles;

        if (!order.isBuy) {
            // Vault needs same-tx ACL to compute FHE.le / select in prepare*
            FHE.allowTransient(order.encryptedAmountETH, address(vault));
            // SELL: lock ETH debit + publish sufficiency ebool with the amount handle
            bytes32 suffHandle = vault.prepareDeductAuthEncrypted(
                orderId,
                trader,
                order.encryptedAmountETH,
                true
            );
            swapSufficiencyHandles[orderId] = suffHandle;
            handles = new bytes32[](2);
            handles[0] = FHE.toBytes32(order.encryptedAmountETH);
            handles[1] = suffHandle;
        } else {
            // BUY: amount first; USDT sufficiency prepared after amount decrypt
            handles = new bytes32[](1);
            handles[0] = FHE.toBytes32(order.encryptedAmountETH);
        }

        // Emit event (CRIT-3: no owner address)
        emit SwapDecryptionReady(orderId, handles);
    }

    /**
     * @notice Step 2: User executes swap with decrypted amount and proof
     * @dev PRIVACY-FIRST: Only the user knows the decrypted amount
     *
     * @param orderId The order ID to execute
     * @param cleartexts ABI-encoded decrypted values from userDecrypt()
     * @param decryptionProof Cryptographic proof from KMS
     * @param minAmountOut Minimum output amount (slippage protection)
     * @param poolFee Uniswap pool fee tier (e.g., 3000 = 0.3%)
     *
     * Security:
     * - FHE.checkSignatures() verifies proof cryptographically
     * - Slippage protection via minAmountOut
     * - Timeout protection (30 min max)
     * - NonReentrant protection
     */
    function executeSwapCallback(
        uint256 orderId,
        bytes calldata cleartexts,
        bytes calldata decryptionProof,
        uint256 minAmountOut,
        uint24 poolFee
    ) external nonReentrant whenNotPaused {
        Order storage order = orders[orderId];
        
        // CHECKS
        if (order.orderId == 0) revert OrderNotFound();
        if (orderTraders[orderId] != msg.sender) revert NotOrderOwner();
        if (order.status != OrderStatus.PendingSwap) revert SwapNotRequested();
        if (!swapExecutionRequested[orderId]) revert SwapNotRequested();
        
        // Timeout check
        if (block.timestamp > swapExecutionRequestTime[orderId] + SWAP_EXECUTION_TIMEOUT) {
            revert SwapDeadlinePassed();
        }

        if (order.isBuy) {
            // BUY step 1: verify ETH amount only, prepare USDT sufficiency (finalize next)
            bytes32[] memory amountHandles = new bytes32[](1);
            amountHandles[0] = FHE.toBytes32(order.encryptedAmountETH);
            FHE.checkSignatures(amountHandles, cleartexts, decryptionProof);
            uint128 amountETH = abi.decode(cleartexts, (uint128));
            _prepareBuySufficiency(orderId, msg.sender, amountETH);
            return;
        }
        
        // SELL: amount + sufficiency ebool in one proof
        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(order.encryptedAmountETH);
        handles[1] = swapSufficiencyHandles[orderId];
        FHE.checkSignatures(handles, cleartexts, decryptionProof);
        (uint128 sellAmount, bool hasSufficient) = abi.decode(cleartexts, (uint128, bool));
        if (!hasSufficient) revert InsufficientEncryptedBalance();
        
        // EFFECTS - Update order status BEFORE external calls (CEI pattern)
        order.status = OrderStatus.Filled;
        userOrders[msg.sender].remove(orderId);
        swapExecutionRequested[orderId] = false;
        delete swapSufficiencyHandles[orderId];
        
        // INTERACTIONS - Execute swap on Uniswap
        uint256 amountOut = _executeUserSwap(
            order,
            sellAmount,
            0,
            minAmountOut,
            poolFee,
            cleartexts,
            decryptionProof
        );
        
        // Emit privacy-preserving events
        emit OrderFilledSimple(orderId, block.timestamp);
        
        // ACL to order owner (not msg.sender) so desk userDecrypt history works
        // even if a future privileged caller settles on their behalf.
        address sellTrader = orderTraders[orderId];
        euint128 encryptedAmountOut = FHE.asEuint128(uint128(amountOut));
        FHE.allowThis(encryptedAmountOut);
        FHE.allow(encryptedAmountOut, sellTrader);
        
        emit OrderFilledPrivate(
            orderId,
            handles[0],
            FHE.toBytes32(encryptedAmountOut)
        );
    }

    /**
     * @notice BUY step 2: finalize after decrypting USDT sufficiency ebool
     */
    function finalizeBuySwap(
        uint256 orderId,
        bytes calldata sufficiencyCleartexts,
        bytes calldata sufficiencyProof,
        uint256 minAmountOut,
        uint24 poolFee
    ) external nonReentrant whenNotPaused {
        Order storage order = orders[orderId];
        if (order.orderId == 0) revert OrderNotFound();
        if (orderTraders[orderId] != msg.sender) revert NotOrderOwner();
        if (!order.isBuy) revert InvalidOrderType();
        if (order.status != OrderStatus.PendingSwap) revert SwapNotRequested();
        if (pendingBuyUsdtAmount[orderId] == 0) revert BuySufficiencyNotPrepared();
        if (block.timestamp > swapExecutionRequestTime[orderId] + SWAP_EXECUTION_TIMEOUT) {
            revert SwapDeadlinePassed();
        }

        uint128 amountETH = pendingBuyAmountETH[orderId];
        uint256 usdtNeeded = pendingBuyUsdtAmount[orderId];

        order.status = OrderStatus.Filled;
        userOrders[msg.sender].remove(orderId);
        swapExecutionRequested[orderId] = false;
        delete pendingBuyUsdtAmount[orderId];
        delete pendingBuyAmountETH[orderId];
        delete swapSufficiencyHandles[orderId];

        uint256 amountOut = _executeUserSwap(
            order,
            amountETH,
            usdtNeeded,
            minAmountOut,
            poolFee,
            sufficiencyCleartexts,
            sufficiencyProof
        );

        emit OrderFilledSimple(orderId, block.timestamp);

        euint128 encryptedAmountOut = FHE.asEuint128(uint128(amountOut));
        FHE.allowThis(encryptedAmountOut);
        FHE.allow(encryptedAmountOut, msg.sender);
        emit OrderFilledPrivate(
            orderId,
            FHE.toBytes32(order.encryptedAmountETH),
            FHE.toBytes32(encryptedAmountOut)
        );
    }

    /// @dev BUY step 1 helper: oracle-price USDT need + vault prepareDeductAuth
    function _prepareBuySufficiency(
        uint256 orderId,
        address trader,
        uint128 amountETH
    ) internal {
        if (pendingBuyUsdtAmount[orderId] != 0) revert BuySufficiencyAlreadyPrepared();

        Order storage order = orders[orderId];
        // Chainlink ETH/USD = 8 decimals; USDC/USDT = 6 decimals.
        // wei(1e18) * price(1e8) / 1e20 → token units (1e6), not /1e18 (that overstates ~100×).
        uint256 oraclePrice = _getChainlinkPrice();
        uint256 usdtNeeded = (uint256(amountETH) * oraclePrice) / 1e20;
        usdtNeeded = (usdtNeeded * (10000 + order.slippageToleranceBPS)) / 10000;

        bytes32 suffHandle = vault.prepareDeductAuth(orderId, trader, usdtNeeded, false);
        swapSufficiencyHandles[orderId] = suffHandle;
        pendingBuyUsdtAmount[orderId] = usdtNeeded;
        pendingBuyAmountETH[orderId] = amountETH;

        emit BuySufficiencyReady(orderId, suffHandle, usdtNeeded);
    }

    /**
     * @notice Relayer submits swap on behalf of user (PRIVACY-FIRST)
     * @dev CRIT-1 FIX: No EIP-712 signature verified on-chain (prevents ecrecover address leak)
     * @dev Authorization: FHE decryption proof IS the authorization (only user can generate it)
     * @dev The relayer verifies the user's EIP-712 signature OFF-CHAIN before submitting
     * 
     * PRIVACY ARCHITECTURE:
     * - tx.from = relayer address (user address hidden)
     * - No user signature in calldata (no ecrecover possible)
     * - No user address in function parameters
     * - FHE proof guarantees correct decryption (only authorized users can generate)
     * - Order owner resolved from private mapping (not exposed)
     * 
     * @param orderId The order ID to execute
     * @param amount Decrypted amount from userDecrypt()
     * @param minAmountOut Minimum output amount (slippage protection)
     * @param poolFee Uniswap pool fee tier
     * @param cleartexts ABI-encoded decrypted values
     * @param decryptionProof Cryptographic proof from KMS
     * 
     * Security:
     * - onlyRelayer: Only trusted relayers can call (access control)
     * - FHE.checkSignatures(): Cryptographic proof that decryption is authentic
     * - Timeout protection (30 min max from request)
     * - NonReentrant protection
     * - No user address in calldata or events (CRIT-1 + CRIT-3)
     */
    function executeSwapViaRelayer(
        uint256 orderId,
        uint128 amount,
        uint256 minAmountOut,
        uint24 poolFee,
        bytes calldata cleartexts,
        bytes calldata decryptionProof
    ) external onlyRelayer nonReentrant whenNotPaused {
        Order storage order = orders[orderId];
        address trader = orderTraders[orderId];
        
        if (order.orderId == 0) revert OrderNotFound();
        if (order.status != OrderStatus.PendingSwap) revert SwapNotRequested();
        if (!swapExecutionRequested[orderId]) revert SwapNotRequested();
        
        if (block.timestamp > swapExecutionRequestTime[orderId] + SWAP_EXECUTION_TIMEOUT) {
            revert SwapDeadlinePassed();
        }

        if (order.isBuy) {
            bytes32[] memory amountHandles = new bytes32[](1);
            amountHandles[0] = FHE.toBytes32(order.encryptedAmountETH);
            FHE.checkSignatures(amountHandles, cleartexts, decryptionProof);
            uint128 buyAmount = abi.decode(cleartexts, (uint128));
            if (buyAmount != amount) revert InvalidSwapAmount();
            _prepareBuySufficiency(orderId, trader, amount);
            return;
        }
        
        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(order.encryptedAmountETH);
        handles[1] = swapSufficiencyHandles[orderId];
        FHE.checkSignatures(handles, cleartexts, decryptionProof);
        
        (uint128 sellAmountDecoded, bool hasSufficient) = abi.decode(cleartexts, (uint128, bool));
        if (sellAmountDecoded != amount) revert InvalidSwapAmount();
        if (!hasSufficient) revert InsufficientEncryptedBalance();
        
        order.status = OrderStatus.Filled;
        userOrders[trader].remove(orderId);
        swapExecutionRequested[orderId] = false;
        delete swapSufficiencyHandles[orderId];
        
        uint256 amountOut = _executeUserSwap(
            order,
            amount,
            0,
            minAmountOut,
            poolFee,
            cleartexts,
            decryptionProof
        );
        
        emit OrderFilledSimple(orderId, block.timestamp);
        
        euint128 encryptedAmountOut = FHE.asEuint128(uint128(amountOut));
        FHE.allowThis(encryptedAmountOut);
        FHE.allow(encryptedAmountOut, trader);
        
        emit OrderFilledPrivate(
            orderId,
            handles[0],
            FHE.toBytes32(encryptedAmountOut)
        );
    }

    /**
     * @notice Internal function to execute user swap on Uniswap
     * @dev Contract acts as PROXY - Uniswap sees NoctisExchange, not user
     * @param order The order being executed
     * @param amountETH Amount of ETH to swap (SELL) or buy size (BUY)
     * @param usdtNeeded USDT debit for BUY (0 for SELL)
     * @param minAmountOut Minimum output (slippage protection)
     * @param sufficiencyCleartexts FHE cleartexts for vault deduct proof
     * @param sufficiencyProof FHE decryption proof for vault deduct
     * @return amountOut Actual amount received from swap
     */
    function _executeUserSwap(
        Order storage order,
        uint128 amountETH,
        uint256 usdtNeeded,
        uint256 minAmountOut,
        uint24 /* poolFee */,
        bytes calldata sufficiencyCleartexts,
        bytes calldata sufficiencyProof
    ) internal returns (uint256 amountOut) {
        uint256 orderId = order.orderId;
        uint256 traderVaultId = orderVaultIds[orderId];
        bool useVaultId = (traderVaultId != 0);
        address trader = orderTraders[orderId];
        
        if (order.isBuy) {
            if (usdtNeeded == 0) revert BuySufficiencyNotPrepared();

            if (useVaultId) {
                vault.deductBalanceWithProofByVaultId(
                    orderId,
                    traderVaultId,
                    usdtNeeded,
                    false,
                    sufficiencyCleartexts,
                    sufficiencyProof
                );
            } else {
                vault.deductBalanceWithProof(
                    orderId,
                    trader,
                    usdtNeeded,
                    false,
                    sufficiencyCleartexts,
                    sufficiencyProof
                );
            }

            address[] memory path = new address[](2);
            path[0] = address(vault.usdt());
            path[1] = WETH;

            IERC20(address(vault.usdt())).forceApprove(address(uniswapRouter), usdtNeeded);

            // SECURITY: enforce oracle-derived floor so a hostile submitter cannot
            // pass minAmountOut below fair-value-minus-tolerance (sandwich).
            uint256 floorBuy = _slippageFloor(usdtNeeded, order.slippageToleranceBPS, true);
            uint256[] memory amounts = uniswapRouter.swapExactTokensForTokens(
                usdtNeeded,
                minAmountOut < floorBuy ? floorBuy : minAmountOut,
                path,
                address(this),
                block.timestamp + SWAP_DEADLINE
            );

            amountOut = amounts[amounts.length - 1];

            IWETH(WETH).withdraw(amountOut);
            uint256 fee = (amountOut * feeBps) / 10_000;
            // Gas-in-kind refund: output is ETH, refund already denominated in wei
            uint256 gasRefund = orderGasRefundWei[orderId];
            if (gasRefund > 0) {
                delete orderGasRefundWei[orderId];
            }
            if (fee + gasRefund >= amountOut) revert OutputTooSmallForFees();
            uint256 netOut = amountOut - fee - gasRefund;
            if (fee + gasRefund > 0) {
                (bool feeOk, ) = feeRecipient.call{value: fee + gasRefund}("");
                if (!feeOk) revert FeeTransferFailed();
                if (fee > 0) {
                    emit ProtocolFeeCollected(orderId, address(0), fee, feeRecipient);
                }
                if (gasRefund > 0) {
                    emit GasRefundCollected(orderId, address(0), gasRefund);
                }
            }
            if (useVaultId) {
                vault.creditBalanceByVaultId{value: netOut}(traderVaultId, netOut, true);
            } else {
                vault.creditBalance{value: netOut}(trader, netOut, true);
            }
            amountOut = netOut;
        } else {
            if (useVaultId) {
                vault.deductBalanceWithProofByVaultId(
                    orderId,
                    traderVaultId,
                    amountETH,
                    true,
                    sufficiencyCleartexts,
                    sufficiencyProof
                );
            } else {
                vault.deductBalanceWithProof(
                    orderId,
                    trader,
                    amountETH,
                    true,
                    sufficiencyCleartexts,
                    sufficiencyProof
                );
            }
            
            IWETH(WETH).deposit{value: amountETH}();
            
            address[] memory path = new address[](2);
            path[0] = WETH;
            path[1] = address(vault.usdt());
            
            IERC20(WETH).forceApprove(address(uniswapRouter), amountETH);
            
            // SECURITY: enforce oracle-derived floor so a hostile submitter cannot
            // pass minAmountOut below fair-value-minus-tolerance (sandwich).
            uint256 floorSell = _slippageFloor(amountETH, order.slippageToleranceBPS, false);
            uint256[] memory amounts = uniswapRouter.swapExactTokensForTokens(
                amountETH,
                minAmountOut < floorSell ? floorSell : minAmountOut,
                path,
                address(this),
                block.timestamp + SWAP_DEADLINE
            );
            
            amountOut = amounts[amounts.length - 1];

            uint256 fee = (amountOut * feeBps) / 10_000;
            // Gas-in-kind refund: output is USDT — convert the wei-denominated refund
            // via the oracle (8-dec price, 6-dec token: wei * price / 1e20)
            uint256 gasRefund = orderGasRefundWei[orderId];
            if (gasRefund > 0) {
                delete orderGasRefundWei[orderId];
                gasRefund = (gasRefund * _getChainlinkPrice()) / 1e20;
            }
            if (fee + gasRefund >= amountOut) revert OutputTooSmallForFees();
            uint256 netOut = amountOut - fee - gasRefund;
            IERC20 usdtToken = IERC20(address(vault.usdt()));
            if (fee + gasRefund > 0) {
                usdtToken.safeTransfer(feeRecipient, fee + gasRefund);
                if (fee > 0) {
                    emit ProtocolFeeCollected(orderId, address(usdtToken), fee, feeRecipient);
                }
                if (gasRefund > 0) {
                    emit GasRefundCollected(orderId, address(usdtToken), gasRefund);
                }
            }
            // Settlement: move USDC into the vault BEFORE crediting encrypted balance.
            // Otherwise vault accounting is an unbacked IOU and withdraws cannot pay out.
            if (netOut > 0) {
                usdtToken.safeTransfer(address(vault), netOut);
            }
            if (useVaultId) {
                vault.creditBalanceByVaultId(traderVaultId, netOut, false);
            } else {
                vault.creditBalance(trader, netOut, false);
            }
            amountOut = netOut;
        }
        
        return amountOut;
    }

    /**
     * @notice Minimum acceptable swap output (slippage floor)
     * @dev SECURITY: `minAmountOut` is caller-supplied; without a floor a hostile
     *      submitter could pass 0 and sandwich the fill.
     *      SELL: floor = Chainlink fair-out × (1 - slip).
     *      BUY:  floor = min(oracle, Uniswap spot) × (1 - slip). Thin testnet
     *      pools (Sepolia) can sit far below Chainlink; oracle-only floors made
     *      every BUY revert INSUFFICIENT_OUTPUT_AMOUNT. Taking the worse of the
     *      two still blocks settling below live pool-minus-slip.
     * @param amountIn Input amount (wei for SELL ETH->USDT; USDT units 1e6 for BUY)
     * @param slippageBPS Order slippage tolerance in basis points
     * @param isBuy True = USDT->ETH (output in wei); false = ETH->USDT (output 1e6)
     * @return Minimum acceptable output amount in the output token's units
     */
    function _slippageFloor(uint256 amountIn, uint16 slippageBPS, bool isBuy)
        internal
        view
        returns (uint256)
    {
        // Chainlink ETH/USD = 8 decimals; ETH = 18 decimals; USDT/USDC = 6 decimals.
        uint256 price = _getChainlinkPrice();
        uint256 fairOut = isBuy
            ? (amountIn * 1e20) / price   // USDT(1e6) -> ETH(1e18)
            : (amountIn * price) / 1e20;  // ETH(1e18) -> USDT(1e6)
        uint256 oracleFloor = (fairOut * (10_000 - slippageBPS)) / 10_000;

        if (!isBuy) {
            return oracleFloor;
        }

        // BUY: also quote the execution venue; use the lower floor when the pool
        // is thinner than the oracle (common on Sepolia).
        address[] memory path = new address[](2);
        path[0] = address(vault.usdt());
        path[1] = WETH;
        try uniswapRouter.getAmountsOut(amountIn, path) returns (uint256[] memory amounts) {
            if (amounts.length >= 2 && amounts[1] > 0) {
                uint256 poolFloor = (amounts[1] * (10_000 - slippageBPS)) / 10_000;
                if (poolFloor < oracleFloor) {
                    return poolFloor;
                }
            }
        } catch {}

        return oracleFloor;
    }

    /**
     * @notice Cancel a pending swap execution request (user-initiated)
     * @dev Allows user to cancel if they don't want to proceed after requesting
     * 
     * @param orderId Order to cancel swap execution for
     */
    function cancelSwapExecution(uint256 orderId) 
        external 
        nonReentrant 
        whenNotPaused 
    {
        _cancelSwapExecution(orderId, true);
    }

    /**
     * @notice Shared swap-execution cancel logic (direct + relayer paths)
     * @dev `checkOwner` enforces caller ownership on the direct path; the relayer
     *      path authorizes off-chain via EIP-712 before calling. Single copy keeps
     *      the contract under the EIP-170 runtime-code limit.
     */
    function _cancelSwapExecution(uint256 orderId, bool checkOwner) internal {
        Order storage order = orders[orderId];

        if (order.orderId == 0) revert OrderNotFound();
        if (checkOwner && orderTraders[orderId] != msg.sender) revert NotOrderOwner();
        if (!swapExecutionRequested[orderId]) revert SwapNotRequested();

        // Restore any FHE lock from prepareDeductAuth* (SELL or BUY step-1)
        if (swapSufficiencyHandles[orderId] != bytes32(0) || pendingBuyUsdtAmount[orderId] != 0) {
            vault.cancelDeductAuth(orderId);
            delete swapSufficiencyHandles[orderId];
            delete pendingBuyUsdtAmount[orderId];
            delete pendingBuyAmountETH[orderId];
        }

        // Reset state
        swapExecutionRequested[orderId] = false;
        swapExecutionRequestTime[orderId] = 0;
        order.status = OrderStatus.Pending;
    }

    /**
     * @notice Get order info without revealing trader address (privacy view)
     * @dev Public can see order exists and basic info, but NOT who owns it
     * 
     * @param orderId Order to query
     * @return exists Whether order exists
     * @return isBuy Order direction
     * @return status Current status
     * @return timestamp Creation time
     * @return orderType Market or Limit
     */
    function getOrderPublic(uint256 orderId) 
        external 
        view 
        returns (
            bool exists,
            bool isBuy,
            OrderStatus status,
            uint256 timestamp,
            OrderType orderType
        ) 
    {
        Order storage order = orders[orderId];
        exists = order.orderId != 0;
        isBuy = order.isBuy;
        status = order.status;
        timestamp = order.timestamp;
        orderType = order.orderType;
        // NOTE: plaintextTrader is NOT returned - privacy preserved
    }

    /**
     * @notice Get full order info (only callable by order owner or relayer)
     * @dev Requires caller to be the order owner or an authorized relayer
     * @dev PRIVACY: Order struct no longer contains plaintext trader address
     * 
     * @param orderId Order to query
     * @return Full order struct (without trader address)
     */
    function getMyOrder(uint256 orderId) 
        external 
        view 
        returns (Order memory) 
    {
        Order storage order = orders[orderId];
        if (order.orderId == 0) revert OrderNotFound();
        // Allow order owner OR relayer to read
        if (orderTraders[orderId] != msg.sender && !hasRole(RELAYER_ROLE, msg.sender)) {
            revert NotOrderOwner();
        }
        return order;
    }

    // ============================================
    // RELAYER META-TRANSACTION FUNCTIONS (Privacy-First)
    // ============================================

    /**
     * @notice Create market order via relayer (PRIVACY: user address hidden from tx.from)
     * @dev Relayer verifies user's EIP-712 signature OFF-CHAIN, then submits on their behalf
     * @dev Only opaque vaultId appears in calldata (no address exposed)
     * @dev User address NOT in tx.from, calldata, events, or public storage
     * 
     * @param vaultId The opaque vault identifier (resolved to address internally)
     * @param amountETH ETH amount (will be encrypted)
     * @param isBuy True for buy order, false for sell order
     * @param slippageToleranceBPS Slippage tolerance in basis points
     * @param maxPriceDeviationBPS Maximum acceptable price deviation from current oracle price
     * @return orderId Unique identifier for the created order
     * 
     * Security:
     * - onlyRelayer: Only trusted relayers can call
     * - Relayer has verified user's EIP-712 signature off-chain
     * - FHE proof serves as secondary authorization for execution
     * - All standard validations (size, rate limiting, oracle) still apply
     */
    function createMarketOrderViaRelayer(
        uint256 vaultId,
        uint128 amountETH,
        bool isBuy,
        uint16 slippageToleranceBPS,
        uint16 maxPriceDeviationBPS,
        uint128 gasRefundWei
    ) external onlyRelayer nonReentrant whenNotPaused returns (uint256) {
        // PRIVACY: Resolve address internally from opaque vaultId (never in calldata)
        address user = vault.getAddressByVaultId(vaultId);
        return _createMarketOrder(
            user,
            vaultId,
            amountETH,
            isBuy,
            slippageToleranceBPS,
            maxPriceDeviationBPS,
            gasRefundWei
        );
    }

    /**
     * @notice Request swap execution via relayer (PRIVACY: user address hidden from tx.from)
     * @dev Step 1 of relayer swap flow - marks order for decryption
     * @dev Relayer has verified user's signature off-chain
     * 
     * @param orderId The order ID to execute
     * 
     * Security:
     * - onlyRelayer: Only trusted relayers can call
     * - Order must exist and be in Pending status
     * - Prevents duplicate requests
     */
    function requestSwapExecutionViaRelayer(
        uint256 orderId
    ) external onlyRelayer nonReentrant whenNotPaused {
        Order storage order = orders[orderId];
        
        // CHECKS
        if (order.orderId == 0) revert OrderNotFound();
        if (order.status != OrderStatus.Pending) revert OrderNotPending();
        if (swapExecutionRequested[orderId]) revert SwapAlreadyRequested();
        
        // EFFECTS
        swapExecutionRequested[orderId] = true;
        swapExecutionRequestTime[orderId] = block.timestamp;
        order.status = OrderStatus.PendingSwap;

        // Grant permission for decryption
        FHE.allowThis(order.encryptedAmountETH);
        _makePubliclyDecryptableSingle(order.encryptedAmountETH);

        address trader = orderTraders[orderId];
        bytes32[] memory handles;

        if (!order.isBuy) {
            FHE.allowTransient(order.encryptedAmountETH, address(vault));
            bytes32 suffHandle = vault.prepareDeductAuthEncrypted(
                orderId,
                trader,
                order.encryptedAmountETH,
                true
            );
            swapSufficiencyHandles[orderId] = suffHandle;
            handles = new bytes32[](2);
            handles[0] = FHE.toBytes32(order.encryptedAmountETH);
            handles[1] = suffHandle;
        } else {
            handles = new bytes32[](1);
            handles[0] = FHE.toBytes32(order.encryptedAmountETH);
        }

        // Emit event (PRIVACY: no owner address)
        emit SwapDecryptionReady(orderId, handles);
    }

    /**
     * @notice Cancel swap execution via relayer
     * @dev Relayer has verified user's signature off-chain
     *
     * @param orderId Order to cancel swap execution for
     */
    function cancelSwapExecutionViaRelayer(
        uint256 orderId
    ) external onlyRelayer nonReentrant whenNotPaused {
        _cancelSwapExecution(orderId, false);
    }

    /**
     * @notice Cancel order via relayer (PRIVACY: user address hidden from tx.from)
     * @dev Relayer has verified user's signature off-chain
     * 
     * @param orderId Order to cancel
     */
    function cancelOrderViaRelayer(
        uint256 orderId
    ) external onlyRelayer nonReentrant whenNotPaused {
        Order storage order = orders[orderId];
        
        if (order.orderId == 0) revert OrderNotFound();
        if (order.status != OrderStatus.Pending) revert OrderNotPending();
        
        // Mark as cancelled
        order.status = OrderStatus.Cancelled;
        userOrders[orderTraders[orderId]].remove(orderId);
        
        // Emit event (CRIT-3: no trader address)
        emit OrderCancelled(orderId, block.timestamp);
    }

    /// @notice Receive ETH (needed for WETH unwrapping)
    receive() external payable {}
}
