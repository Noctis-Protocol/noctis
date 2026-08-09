// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./NoctisVaultV2.sol";
import "../base/GatewayCaller.sol";
import "../interfaces/IUniswapV2Router.sol";
import "../interfaces/IWETH.sol";
import "../interfaces/AggregatorV3Interface.sol";

/**
 * @title NoctisExchangeV2 - Multi-Pair Privacy-First DEX
 * @notice Encrypted market orders on any registered token/USDC pair (ZAMA FHE + Uniswap V2)
 * @dev V2 generalizes NoctisExchange (hardcoded ETH/USDC) to a registry of tradable
 *      base tokens. Every pair is quoted against USDC. Native ETH = address(0)
 *      (wrapped/unwrapped via WETH around the router).
 *
 * Trading flow (identical to V1, per pair):
 * 1. createMarketOrder[ViaRelayer]   — encrypted base amount stored on-chain
 * 2. requestSwapExecution[ViaRelayer] — handles made publicly decryptable;
 *    SELL also locks the base debit in the vault (FHE.select gate)
 * 3. executeSwapCallback / executeSwapViaRelayer — proof-verified execution;
 *    BUY runs a second leg (finalizeBuySwap) after the USDC sufficiency proof
 *
 * Security invariants carried from V1:
 * - FHE.checkSignatures is the only trust root for cleartexts
 * - Oracle slippage floor (per-token Chainlink feed) bounds hostile minAmountOut
 * - Per-token price circuit breakers + staleness + L2 sequencer check
 * - CEI + nonReentrant everywhere; vault settlement before encrypted credit
 * - Roles + optional TimelockController for parameter changes
 */
contract NoctisExchangeV2 is ReentrancyGuard, Pausable, AccessControl, GatewayCaller {
    using EnumerableSet for EnumerableSet.UintSet;
    using EnumerableSet for EnumerableSet.AddressSet;
    using SafeERC20 for IERC20;

    // ============================================
    // ENUMS / STRUCTS
    // ============================================

    enum OrderStatus {
        Pending,
        PendingSwap,
        Filled,
        Cancelled
    }

    /// @notice Per-base-token trading configuration (quote is always USDC)
    struct TradeConfig {
        bool enabled;
        AggregatorV3Interface priceFeed; // base/USD, 8 decimals
        uint8 baseDecimals;
        bool routeViaWeth;               // path base->WETH->USDC when no direct pool
        uint128 minOrderSize;            // base units
        uint128 maxOrderSize;            // base units
        uint128 minPriceUsd;             // circuit breaker lower bound (8 decimals)
        uint128 maxPriceUsd;             // circuit breaker upper bound (8 decimals)
    }

    /// @dev PRIVACY: trader identity lives in private mappings, never in the struct
    struct Order {
        uint256 orderId;
        address baseToken;              // address(0) = native ETH
        eaddress encryptedTrader;
        euint128 encryptedAmountBase;   // hidden order size (base units)
        bool isBuy;                     // true = buy base with USDC
        uint256 timestamp;
        OrderStatus status;
        uint16 slippageToleranceBPS;
        uint256 referencePriceUSD;      // oracle price at creation (8 decimals)
        uint16 maxPriceDeviationBPS;    // 0 = no deviation protection
    }

    // ============================================
    // ROLES
    // ============================================

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant PARAMS_ROLE = keccak256("PARAMS_ROLE");
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    // ============================================
    // IMMUTABLES / CONSTANTS
    // ============================================

    /// @notice Native ETH sentinel (mirrors NoctisVaultV2.NATIVE)
    address public constant NATIVE = address(0);

    NoctisVaultV2 public immutable vault;
    IUniswapV2Router02 public immutable uniswapRouter;
    address public immutable WETH;
    IERC20 public immutable usdc;

    /// @notice ETH/USD feed — used for gas-in-kind refund conversion on every pair
    AggregatorV3Interface public immutable ethUsdPriceFeed;
    /// @notice L2 sequencer uptime feed (address(0) on L1)
    AggregatorV3Interface public immutable sequencerUptimeFeed;

    uint256 internal constant SEQUENCER_GRACE_PERIOD = 3600;
    uint256 internal constant MAX_MARKET_ORDER_SLIPPAGE_BPS = 300; // 3%
    uint256 internal constant MAX_ORACLE_PRICE_DEVIATION_BPS = 200; // 2%
    uint256 internal constant ORACLE_STALENESS_THRESHOLD = 1 hours;
    uint256 internal constant SWAP_DEADLINE = 300;
    uint256 public constant SWAP_EXECUTION_TIMEOUT = 30 minutes;
    uint8 internal constant USDC_DECIMALS = 6;

    uint16 public constant MAX_FEE_BPS = 30;

    // ============================================
    // STATE
    // ============================================

    /// @notice Tradable base tokens (quote fixed to USDC)
    mapping(address => TradeConfig) public tradeConfigs;
    EnumerableSet.AddressSet private tradableTokens;

    address public timelock;
    bool public timelockConfigured;

    uint256 public orderCounter;
    mapping(uint256 => Order) private orders;
    mapping(uint256 => address) private orderTraders;
    mapping(uint256 => uint256) private orderVaultIds;
    mapping(address => EnumerableSet.UintSet) private userOrders;

    uint16 public feeBps = 5;
    address public feeRecipient;
    /// @notice Receives gas-in-kind refunds at settlement (relayer float wallet).
    /// @dev Separate from feeRecipient so the relayer self-funds without a
    ///      treasury round-trip. No privacy impact: recipients and amounts are
    ///      already public via ProtocolFeeCollected/GasRefundCollected events.
    address public gasRecipient;

    uint128 public maxGasRefundWei = 0.01 ether;
    mapping(uint256 => uint128) private orderGasRefundWei;

    mapping(address => uint256) private lastOrderBlock;
    uint256 public maxOrdersPerBlock = 100;
    uint256 private ordersCreatedThisBlock;
    uint256 private lastBlockWithOrders;

    mapping(uint256 => bool) public swapExecutionRequested;
    mapping(uint256 => uint256) public swapExecutionRequestTime;
    mapping(uint256 => bytes32) private swapSufficiencyHandles;
    /// @notice BUY path: USDC amount locked pending sufficiency finalize
    mapping(uint256 => uint256) public pendingBuyUsdcAmount;
    mapping(uint256 => uint128) private pendingBuyAmountBase;

    // ============================================
    // ERRORS
    // ============================================

    error InvalidAddress();
    error InvalidFeeRecipient();
    error FeeTransferFailed();
    error ZeroAmount();
    error TokenNotTradable();
    error InvalidTradeConfig();
    error BelowMinimumOrderSize();
    error ExceedsMaximumOrderSize();
    error OrderTooFrequent();
    error OrderNotFound();
    error OrderNotPending();
    error UnauthorizedCancellation();
    error TimelockAlreadyConfigured();
    error OnlyTimelock();
    error GlobalOrderLimitReached(uint256 current, uint256 max);
    error InvalidMaxOrdersPerBlock(uint256 max);
    error InvalidSwapAmount();
    error SlippageToleranceTooHigh(uint256 requested, uint256 maximum);
    error ZeroSlippageTolerance();
    error OraclePriceDeviationTooHigh(uint256 requested, uint256 maximum);
    error PriceDeviationExceeded(uint256 deviationBPS, uint256 maxBPS);
    error OraclePriceStale(uint256 updatedAt, uint256 threshold);
    error OraclePriceInvalid();
    error SequencerDown();
    error SequencerGracePeriod(uint256 timeSinceUp, uint256 required);
    error PriceOutOfBounds(uint256 price, uint256 min, uint256 max);
    error NotOrderOwner();
    error SwapAlreadyRequested();
    error SwapNotRequested();
    error SwapDeadlinePassed();
    error OnlyRelayer();
    error InvalidOrderType();
    error BuySufficiencyNotPrepared();
    error BuySufficiencyAlreadyPrepared();
    error InsufficientEncryptedBalance();
    error GasRefundTooHigh(uint256 requested, uint256 maximum);
    error OutputTooSmallForFees();
    error FeeTooHigh(uint256 requested, uint256 maximum);

    // ============================================
    // EVENTS (privacy: no user addresses or plaintext sizes)
    // ============================================

    event TradableTokenConfigured(address indexed baseToken, bool enabled);
    event OrderCreated(uint256 indexed orderId, address indexed baseToken, bool isBuy, uint256 timestamp);
    event OrderFilledSimple(uint256 indexed orderId, uint256 timestamp);
    event OrderFilledPrivate(uint256 indexed orderId, bytes32 encryptedAmountIn, bytes32 encryptedAmountOut);
    event SwapDecryptionReady(uint256 indexed orderId, bytes32[] handles);
    event BuySufficiencyReady(uint256 indexed orderId, bytes32 sufficiencyHandle, uint256 usdcNeeded);
    event OrderCancelled(uint256 indexed orderId, uint256 timestamp);
    event TimelockSet(address indexed timelock);
    event MaxOrdersPerBlockUpdated(uint256 oldMax, uint256 newMax);
    event ProtocolFeeCollected(uint256 indexed orderId, address indexed token, uint256 feeAmount, address indexed recipient);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event GasRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event GasRefundCollected(uint256 indexed orderId, address indexed token, uint256 refundAmount);
    event MaxGasRefundUpdated(uint128 oldMax, uint128 newMax);
    event FeeBpsUpdated(uint16 oldFeeBps, uint16 newFeeBps);
    event TokensRescued(address indexed token, address indexed to, uint256 amount);
    event RateLimitTriggered(uint256 blockNumber);

    // ============================================
    // MODIFIERS
    // ============================================

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

    modifier onlyRelayer() {
        if (!hasRole(RELAYER_ROLE, msg.sender)) revert OnlyRelayer();
        _;
    }

    // ============================================
    // CONSTRUCTOR
    // ============================================

    constructor(
        address _vault,
        address _uniswapRouter,
        address _usdc,
        address _ethUsdPriceFeed,
        address _sequencerUptimeFeed
    ) {
        if (_vault == address(0)) revert InvalidAddress();
        if (_uniswapRouter == address(0)) revert InvalidAddress();
        if (_usdc == address(0)) revert InvalidAddress();
        if (_ethUsdPriceFeed == address(0)) revert InvalidAddress();
        // _sequencerUptimeFeed may be address(0) on L1

        vault = NoctisVaultV2(payable(_vault));
        uniswapRouter = IUniswapV2Router02(_uniswapRouter);
        WETH = uniswapRouter.WETH();
        usdc = IERC20(_usdc);
        ethUsdPriceFeed = AggregatorV3Interface(_ethUsdPriceFeed);
        sequencerUptimeFeed = AggregatorV3Interface(_sequencerUptimeFeed);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        feeRecipient = msg.sender;
        gasRecipient = msg.sender;
    }

    // ============================================
    // PAIR REGISTRY
    // ============================================

    /**
     * @notice Register or update a tradable base token (quote = USDC)
     * @dev PARAMS_ROLE pre-timelock, timelock after configuration
     */
    function configureTradableToken(
        address baseToken,
        address priceFeed,
        uint8 baseDecimals,
        bool routeViaWeth,
        uint128 minOrderSize,
        uint128 maxOrderSize,
        uint128 minPriceUsd,
        uint128 maxPriceUsd
    ) external onlyTimelockOrRole(PARAMS_ROLE) {
        if (baseToken == address(usdc)) revert InvalidTradeConfig();
        if (priceFeed == address(0)) revert InvalidAddress();
        if (minOrderSize == 0 || minOrderSize >= maxOrderSize) revert InvalidTradeConfig();
        if (minPriceUsd == 0 || minPriceUsd >= maxPriceUsd) revert InvalidTradeConfig();
        // Native ETH always routes through WETH directly (single-hop WETH/USDC)
        if (baseToken == NATIVE && routeViaWeth) revert InvalidTradeConfig();

        tradeConfigs[baseToken] = TradeConfig({
            enabled: true,
            priceFeed: AggregatorV3Interface(priceFeed),
            baseDecimals: baseDecimals,
            routeViaWeth: routeViaWeth,
            minOrderSize: minOrderSize,
            maxOrderSize: maxOrderSize,
            minPriceUsd: minPriceUsd,
            maxPriceUsd: maxPriceUsd
        });
        tradableTokens.add(baseToken);

        emit TradableTokenConfigured(baseToken, true);
    }

    /// @notice Enable/disable new orders for a pair (open orders stay cancellable)
    function setTokenTradingEnabled(address baseToken, bool enabled) external onlyTimelockOrRole(PARAMS_ROLE) {
        if (!tradableTokens.contains(baseToken)) revert TokenNotTradable();
        tradeConfigs[baseToken].enabled = enabled;
        emit TradableTokenConfigured(baseToken, enabled);
    }

    function getTradableTokens() external view returns (address[] memory) {
        return tradableTokens.values();
    }

    // ============================================
    // ORACLE
    // ============================================

    /**
     * @dev Multi-layer oracle read for a base token:
     *      sequencer status -> feed read -> validations -> staleness -> per-token bounds
     * @return price base/USD with 8 decimals
     */
    function _getTokenPrice(address baseToken) internal view returns (uint256 price) {
        if (address(sequencerUptimeFeed) != address(0)) {
            (, int256 sequencerAnswer, uint256 startedAt, , ) = sequencerUptimeFeed.latestRoundData();
            if (sequencerAnswer == 1) revert SequencerDown();
            uint256 timeSinceUp = block.timestamp - startedAt;
            if (timeSinceUp < SEQUENCER_GRACE_PERIOD) {
                revert SequencerGracePeriod(timeSinceUp, SEQUENCER_GRACE_PERIOD);
            }
        }

        TradeConfig storage cfg = tradeConfigs[baseToken];
        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) =
            cfg.priceFeed.latestRoundData();

        if (answer <= 0) revert OraclePriceInvalid();
        if (updatedAt == 0) revert OraclePriceInvalid();
        if (answeredInRound < roundId) revert OraclePriceInvalid();
        if (block.timestamp - updatedAt > ORACLE_STALENESS_THRESHOLD) {
            revert OraclePriceStale(updatedAt, ORACLE_STALENESS_THRESHOLD);
        }

        price = uint256(answer);
        if (price < cfg.minPriceUsd || price > cfg.maxPriceUsd) {
            revert PriceOutOfBounds(price, cfg.minPriceUsd, cfg.maxPriceUsd);
        }
    }

    /// @dev ETH/USD price for gas-refund conversion (bounds via NATIVE config when
    ///      registered; otherwise raw feed validations only)
    function _getEthPrice() internal view returns (uint256) {
        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) =
            ethUsdPriceFeed.latestRoundData();
        if (answer <= 0 || updatedAt == 0 || answeredInRound < roundId) revert OraclePriceInvalid();
        if (block.timestamp - updatedAt > ORACLE_STALENESS_THRESHOLD) {
            revert OraclePriceStale(updatedAt, ORACLE_STALENESS_THRESHOLD);
        }
        return uint256(answer);
    }

    // ============================================
    // ORDER CREATION
    // ============================================

    /**
     * @notice Create an encrypted market order on `baseToken`/USDC
     * @param amountBase Order size in base token units (encrypted on-chain)
     * @param isBuy true = buy base with USDC; false = sell base for USDC
     */
    function createMarketOrder(
        address baseToken,
        uint128 amountBase,
        bool isBuy,
        uint16 slippageToleranceBPS,
        uint16 maxPriceDeviationBPS
    ) external nonReentrant whenNotPaused returns (uint256) {
        return _createMarketOrder(
            msg.sender, 0, baseToken, amountBase, isBuy, slippageToleranceBPS, maxPriceDeviationBPS, 0
        );
    }

    /// @notice Relayer path: user identified by opaque vaultId, gas refund signed off-chain
    function createMarketOrderViaRelayer(
        uint256 vaultId,
        address baseToken,
        uint128 amountBase,
        bool isBuy,
        uint16 slippageToleranceBPS,
        uint16 maxPriceDeviationBPS,
        uint128 gasRefundWei
    ) external onlyRelayer nonReentrant whenNotPaused returns (uint256) {
        address user = vault.getAddressByVaultId(vaultId);
        return _createMarketOrder(
            user, vaultId, baseToken, amountBase, isBuy, slippageToleranceBPS, maxPriceDeviationBPS, gasRefundWei
        );
    }

    function _createMarketOrder(
        address user,
        uint256 vaultId,
        address baseToken,
        uint128 amountBase,
        bool isBuy,
        uint16 slippageToleranceBPS,
        uint16 maxPriceDeviationBPS,
        uint128 gasRefundWei
    ) internal returns (uint256 orderId) {
        TradeConfig storage cfg = tradeConfigs[baseToken];
        if (!cfg.enabled) revert TokenNotTradable();
        if (amountBase == 0) revert ZeroAmount();
        if (amountBase < cfg.minOrderSize) revert BelowMinimumOrderSize();
        if (amountBase > cfg.maxOrderSize) revert ExceedsMaximumOrderSize();

        if (gasRefundWei > maxGasRefundWei) {
            revert GasRefundTooHigh(gasRefundWei, maxGasRefundWei);
        }
        if (slippageToleranceBPS == 0) revert ZeroSlippageTolerance();
        if (slippageToleranceBPS > MAX_MARKET_ORDER_SLIPPAGE_BPS) {
            revert SlippageToleranceTooHigh(slippageToleranceBPS, MAX_MARKET_ORDER_SLIPPAGE_BPS);
        }
        if (maxPriceDeviationBPS > MAX_ORACLE_PRICE_DEVIATION_BPS) {
            revert OraclePriceDeviationTooHigh(maxPriceDeviationBPS, MAX_ORACLE_PRICE_DEVIATION_BPS);
        }

        uint256 currentOraclePrice = _getTokenPrice(baseToken);

        // Rate limiting (global per block + per user per block)
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

        ordersCreatedThisBlock++;
        lastOrderBlock[user] = block.number;

        euint128 encryptedAmountBase = FHE.asEuint128(amountBase);
        eaddress encTrader = FHE.asEaddress(user);

        orderId = ++orderCounter;
        orders[orderId] = Order({
            orderId: orderId,
            baseToken: baseToken,
            encryptedTrader: encTrader,
            encryptedAmountBase: encryptedAmountBase,
            isBuy: isBuy,
            timestamp: block.timestamp,
            status: OrderStatus.Pending,
            slippageToleranceBPS: slippageToleranceBPS,
            referencePriceUSD: currentOraclePrice,
            maxPriceDeviationBPS: maxPriceDeviationBPS
        });

        if (vaultId != 0) {
            orderVaultIds[orderId] = vaultId;
        }
        orderTraders[orderId] = user;
        userOrders[user].add(orderId);
        if (gasRefundWei > 0) {
            orderGasRefundWei[orderId] = gasRefundWei;
        }

        FHE.allowThis(encryptedAmountBase);
        FHE.allowThis(encTrader);
        FHE.allow(encryptedAmountBase, user);
        FHE.allow(encTrader, user);

        emit OrderCreated(orderId, baseToken, isBuy, block.timestamp);
    }

    // ============================================
    // ORDER CANCELLATION
    // ============================================

    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.orderId == 0) revert OrderNotFound();
        if (orderTraders[orderId] != msg.sender) revert UnauthorizedCancellation();
        if (order.status != OrderStatus.Pending) revert OrderNotPending();

        order.status = OrderStatus.Cancelled;
        userOrders[msg.sender].remove(orderId);

        emit OrderCancelled(orderId, block.timestamp);
    }

    function cancelOrderViaRelayer(uint256 orderId) external onlyRelayer nonReentrant whenNotPaused {
        Order storage order = orders[orderId];
        if (order.orderId == 0) revert OrderNotFound();
        if (order.status != OrderStatus.Pending) revert OrderNotPending();

        order.status = OrderStatus.Cancelled;
        userOrders[orderTraders[orderId]].remove(orderId);

        emit OrderCancelled(orderId, block.timestamp);
    }

    // ============================================
    // SWAP EXECUTION (v0.9 self-relay)
    // ============================================

    /// @notice Step 1: mark the order for decryption (SELL also locks the base debit)
    function requestSwapExecution(uint256 orderId) external nonReentrant whenNotPaused {
        _requestSwapExecution(orderId, true);
    }

    function requestSwapExecutionViaRelayer(uint256 orderId) external onlyRelayer nonReentrant whenNotPaused {
        _requestSwapExecution(orderId, false);
    }

    function _requestSwapExecution(uint256 orderId, bool checkOwner) internal {
        Order storage order = orders[orderId];

        if (order.orderId == 0) revert OrderNotFound();
        if (checkOwner && orderTraders[orderId] != msg.sender) revert NotOrderOwner();
        if (order.status != OrderStatus.Pending) revert OrderNotPending();
        if (swapExecutionRequested[orderId]) revert SwapAlreadyRequested();

        swapExecutionRequested[orderId] = true;
        swapExecutionRequestTime[orderId] = block.timestamp;
        order.status = OrderStatus.PendingSwap;

        FHE.allowThis(order.encryptedAmountBase);
        _makePubliclyDecryptableSingle(order.encryptedAmountBase);

        address trader = orderTraders[orderId];
        bytes32[] memory handles;

        if (!order.isBuy) {
            // SELL: vault needs same-tx ACL to compute FHE.le / select in prepare
            FHE.allowTransient(order.encryptedAmountBase, address(vault));
            bytes32 suffHandle = vault.prepareDeductAuthEncrypted(
                orderId,
                trader,
                order.encryptedAmountBase,
                order.baseToken
            );
            swapSufficiencyHandles[orderId] = suffHandle;
            handles = new bytes32[](2);
            handles[0] = FHE.toBytes32(order.encryptedAmountBase);
            handles[1] = suffHandle;
        } else {
            // BUY: amount first; USDC sufficiency prepared after the amount decrypt
            handles = new bytes32[](1);
            handles[0] = FHE.toBytes32(order.encryptedAmountBase);
        }

        emit SwapDecryptionReady(orderId, handles);
    }

    /**
     * @notice Step 2 (user path): execute with proven cleartexts
     * @dev SELL executes fully; BUY prepares the USDC sufficiency leg (finalizeBuySwap next)
     */
    function executeSwapCallback(
        uint256 orderId,
        bytes calldata cleartexts,
        bytes calldata decryptionProof,
        uint256 minAmountOut
    ) external nonReentrant whenNotPaused {
        Order storage order = orders[orderId];

        if (order.orderId == 0) revert OrderNotFound();
        if (orderTraders[orderId] != msg.sender) revert NotOrderOwner();
        if (order.status != OrderStatus.PendingSwap) revert SwapNotRequested();
        if (!swapExecutionRequested[orderId]) revert SwapNotRequested();
        if (block.timestamp > swapExecutionRequestTime[orderId] + SWAP_EXECUTION_TIMEOUT) {
            revert SwapDeadlinePassed();
        }

        if (order.isBuy) {
            bytes32[] memory amountHandles = new bytes32[](1);
            amountHandles[0] = FHE.toBytes32(order.encryptedAmountBase);
            FHE.checkSignatures(amountHandles, cleartexts, decryptionProof);
            uint128 amountBase = abi.decode(cleartexts, (uint128));
            _prepareBuySufficiency(orderId, msg.sender, amountBase);
            return;
        }

        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(order.encryptedAmountBase);
        handles[1] = swapSufficiencyHandles[orderId];
        FHE.checkSignatures(handles, cleartexts, decryptionProof);
        (uint128 sellAmount, bool hasSufficient) = abi.decode(cleartexts, (uint128, bool));
        if (!hasSufficient) revert InsufficientEncryptedBalance();

        order.status = OrderStatus.Filled;
        userOrders[msg.sender].remove(orderId);
        swapExecutionRequested[orderId] = false;
        delete swapSufficiencyHandles[orderId];

        uint256 amountOut = _executeUserSwap(order, sellAmount, 0, minAmountOut, cleartexts, decryptionProof);

        emit OrderFilledSimple(orderId, block.timestamp);
        _emitFilledPrivate(orderId, handles[0], amountOut, orderTraders[orderId]);
    }

    /// @notice Relayer path: proof-authorized execution, user never appears as tx.from
    function executeSwapViaRelayer(
        uint256 orderId,
        uint128 amount,
        uint256 minAmountOut,
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
            amountHandles[0] = FHE.toBytes32(order.encryptedAmountBase);
            FHE.checkSignatures(amountHandles, cleartexts, decryptionProof);
            uint128 buyAmount = abi.decode(cleartexts, (uint128));
            if (buyAmount != amount) revert InvalidSwapAmount();
            _prepareBuySufficiency(orderId, trader, amount);
            return;
        }

        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(order.encryptedAmountBase);
        handles[1] = swapSufficiencyHandles[orderId];
        FHE.checkSignatures(handles, cleartexts, decryptionProof);

        (uint128 sellAmountDecoded, bool hasSufficient) = abi.decode(cleartexts, (uint128, bool));
        if (sellAmountDecoded != amount) revert InvalidSwapAmount();
        if (!hasSufficient) revert InsufficientEncryptedBalance();

        order.status = OrderStatus.Filled;
        userOrders[trader].remove(orderId);
        swapExecutionRequested[orderId] = false;
        delete swapSufficiencyHandles[orderId];

        uint256 amountOut = _executeUserSwap(order, amount, 0, minAmountOut, cleartexts, decryptionProof);

        emit OrderFilledSimple(orderId, block.timestamp);
        _emitFilledPrivate(orderId, handles[0], amountOut, trader);
    }

    /// @notice BUY step 2: finalize after the USDC sufficiency ebool is proven
    function finalizeBuySwap(
        uint256 orderId,
        bytes calldata sufficiencyCleartexts,
        bytes calldata sufficiencyProof,
        uint256 minAmountOut
    ) external nonReentrant whenNotPaused {
        Order storage order = orders[orderId];
        if (order.orderId == 0) revert OrderNotFound();
        address trader = orderTraders[orderId];
        // Owner or relayer may submit the finalize leg (proof is the authorization)
        if (trader != msg.sender && !hasRole(RELAYER_ROLE, msg.sender)) revert NotOrderOwner();
        if (!order.isBuy) revert InvalidOrderType();
        if (order.status != OrderStatus.PendingSwap) revert SwapNotRequested();
        if (pendingBuyUsdcAmount[orderId] == 0) revert BuySufficiencyNotPrepared();
        if (block.timestamp > swapExecutionRequestTime[orderId] + SWAP_EXECUTION_TIMEOUT) {
            revert SwapDeadlinePassed();
        }

        uint128 amountBase = pendingBuyAmountBase[orderId];
        uint256 usdcNeeded = pendingBuyUsdcAmount[orderId];

        order.status = OrderStatus.Filled;
        userOrders[trader].remove(orderId);
        swapExecutionRequested[orderId] = false;
        delete pendingBuyUsdcAmount[orderId];
        delete pendingBuyAmountBase[orderId];
        delete swapSufficiencyHandles[orderId];

        uint256 amountOut = _executeUserSwap(
            order, amountBase, usdcNeeded, minAmountOut, sufficiencyCleartexts, sufficiencyProof
        );

        emit OrderFilledSimple(orderId, block.timestamp);
        _emitFilledPrivate(orderId, FHE.toBytes32(order.encryptedAmountBase), amountOut, trader);
    }

    /// @dev BUY step 1: quote USDC need from the oracle + lock it in the vault
    function _prepareBuySufficiency(uint256 orderId, address trader, uint128 amountBase) internal {
        if (pendingBuyUsdcAmount[orderId] != 0) revert BuySufficiencyAlreadyPrepared();

        Order storage order = orders[orderId];
        TradeConfig storage cfg = tradeConfigs[order.baseToken];

        // base units * price(8 dec) -> USDC units (6 dec):
        // usdc = amount / 10^baseDec * price / 1e8 * 1e6 = amount * price / 10^(baseDec + 2)
        uint256 price = _getTokenPrice(order.baseToken);
        uint256 usdcNeeded = (uint256(amountBase) * price) / (10 ** (uint256(cfg.baseDecimals) + 2));
        usdcNeeded = (usdcNeeded * (10000 + order.slippageToleranceBPS)) / 10000;
        if (usdcNeeded == 0) revert ZeroAmount();

        bytes32 suffHandle = vault.prepareDeductAuth(orderId, trader, usdcNeeded, address(usdc));
        swapSufficiencyHandles[orderId] = suffHandle;
        pendingBuyUsdcAmount[orderId] = usdcNeeded;
        pendingBuyAmountBase[orderId] = amountBase;

        emit BuySufficiencyReady(orderId, suffHandle, usdcNeeded);
    }

    /// @dev ACL the encrypted output to the order owner + emit the private fill event
    function _emitFilledPrivate(uint256 orderId, bytes32 inHandle, uint256 amountOut, address trader) internal {
        euint128 encryptedAmountOut = FHE.asEuint128(uint128(amountOut));
        FHE.allowThis(encryptedAmountOut);
        FHE.allow(encryptedAmountOut, trader);
        emit OrderFilledPrivate(orderId, inHandle, FHE.toBytes32(encryptedAmountOut));
    }

    // ============================================
    // SWAP INTERNALS
    // ============================================

    /**
     * @dev Execute the Uniswap leg as a proxy and settle to the vault.
     *      BUY: USDC -> base (usdcNeeded deducted, output credited in base)
     *      SELL: base -> USDC (amountBase deducted, output credited in USDC)
     */
    function _executeUserSwap(
        Order storage order,
        uint128 amountBase,
        uint256 usdcNeeded,
        uint256 minAmountOut,
        bytes calldata sufficiencyCleartexts,
        bytes calldata sufficiencyProof
    ) internal returns (uint256 amountOut) {
        uint256 orderId = order.orderId;
        address baseToken = order.baseToken;

        _checkPriceDeviation(order);

        if (order.isBuy) {
            if (usdcNeeded == 0) revert BuySufficiencyNotPrepared();
            _vaultDeduct(orderId, usdcNeeded, address(usdc), sufficiencyCleartexts, sufficiencyProof);

            address[] memory path = _swapPath(baseToken, false);
            usdc.forceApprove(address(uniswapRouter), usdcNeeded);

            uint256 floorBuy = _slippageFloor(baseToken, usdcNeeded, order.slippageToleranceBPS, true);
            uint256[] memory amounts = uniswapRouter.swapExactTokensForTokens(
                usdcNeeded,
                minAmountOut < floorBuy ? floorBuy : minAmountOut,
                path,
                address(this),
                block.timestamp + SWAP_DEADLINE
            );
            amountOut = amounts[amounts.length - 1];

            if (baseToken == NATIVE) {
                IWETH(WETH).withdraw(amountOut);
            }

            // Fee + gas-in-kind refund, both denominated in the output (base) token
            uint256 fee = (amountOut * feeBps) / 10_000;
            uint256 gasRefund = _consumeGasRefundInBase(orderId, baseToken);
            if (fee + gasRefund >= amountOut) revert OutputTooSmallForFees();
            uint256 netOut = amountOut - fee - gasRefund;

            if (fee + gasRefund > 0) {
                _payFees(orderId, baseToken, fee, gasRefund);
            }

            _vaultCredit(orderId, netOut, baseToken);
            amountOut = netOut;
        } else {
            _vaultDeduct(orderId, amountBase, baseToken, sufficiencyCleartexts, sufficiencyProof);

            address tokenIn = baseToken;
            if (baseToken == NATIVE) {
                IWETH(WETH).deposit{value: amountBase}();
                tokenIn = WETH;
            }

            address[] memory path = _swapPath(baseToken, true);
            IERC20(tokenIn).forceApprove(address(uniswapRouter), amountBase);

            uint256 floorSell = _slippageFloor(baseToken, amountBase, order.slippageToleranceBPS, false);
            uint256[] memory amounts = uniswapRouter.swapExactTokensForTokens(
                amountBase,
                minAmountOut < floorSell ? floorSell : minAmountOut,
                path,
                address(this),
                block.timestamp + SWAP_DEADLINE
            );
            amountOut = amounts[amounts.length - 1];

            // Fee + gas refund in USDC (refund converted via ETH/USD oracle)
            uint256 fee = (amountOut * feeBps) / 10_000;
            uint256 gasRefund = orderGasRefundWei[orderId];
            if (gasRefund > 0) {
                delete orderGasRefundWei[orderId];
                // wei(1e18) * price(1e8) / 1e20 -> USDC units (1e6)
                gasRefund = (gasRefund * _getEthPrice()) / 1e20;
            }
            if (fee + gasRefund >= amountOut) revert OutputTooSmallForFees();
            uint256 netOut = amountOut - fee - gasRefund;

            if (fee + gasRefund > 0) {
                _payFees(orderId, address(usdc), fee, gasRefund);
            }

            // Settlement: move USDC into the vault BEFORE crediting the encrypted balance
            if (netOut > 0) {
                usdc.safeTransfer(address(vault), netOut);
            }
            _vaultCreditNoValue(orderId, netOut, address(usdc));
            amountOut = netOut;
        }
    }

    /// @dev Oracle-price deviation guard vs order creation (0 = disabled)
    function _checkPriceDeviation(Order storage order) internal view {
        uint16 maxDev = order.maxPriceDeviationBPS;
        if (maxDev == 0) return;
        uint256 current = _getTokenPrice(order.baseToken);
        uint256 refPrice = order.referencePriceUSD;
        uint256 diff = current > refPrice ? current - refPrice : refPrice - current;
        uint256 deviationBPS = (diff * 10_000) / refPrice;
        if (deviationBPS > maxDev) revert PriceDeviationExceeded(deviationBPS, maxDev);
    }

    /// @dev Router path for a pair. baseToUsdc=true -> selling base.
    function _swapPath(address baseToken, bool baseToUsdc) internal view returns (address[] memory path) {
        address baseLeg = baseToken == NATIVE ? WETH : baseToken;
        if (tradeConfigs[baseToken].routeViaWeth) {
            path = new address[](3);
            if (baseToUsdc) {
                path[0] = baseLeg;
                path[1] = WETH;
                path[2] = address(usdc);
            } else {
                path[0] = address(usdc);
                path[1] = WETH;
                path[2] = baseLeg;
            }
        } else {
            path = new address[](2);
            if (baseToUsdc) {
                path[0] = baseLeg;
                path[1] = address(usdc);
            } else {
                path[0] = address(usdc);
                path[1] = baseLeg;
            }
        }
    }

    /**
     * @notice Minimum acceptable swap output (slippage floor)
     * @dev SELL: floor = oracle fair-out x (1 - slip) — the pool spot is manipulable
     *      within a block, so the oracle stays authoritative on the sell side.
     *      BUY: floor = min(oracle, pool spot) x (1 - slip) — thin testnet pools can
     *      sit far below Chainlink; oracle-only floors made every BUY revert (V1 note).
     */
    function _slippageFloor(
        address baseToken,
        uint256 amountIn,
        uint16 slippageBPS,
        bool isBuy
    ) internal view returns (uint256) {
        TradeConfig storage cfg = tradeConfigs[baseToken];
        uint256 price = _getTokenPrice(baseToken);
        uint256 scale = 10 ** (uint256(cfg.baseDecimals) + 2);

        uint256 fairOut = isBuy
            ? (amountIn * scale) / price   // USDC(1e6) -> base units
            : (amountIn * price) / scale;  // base units -> USDC(1e6)
        uint256 oracleFloor = (fairOut * (10_000 - slippageBPS)) / 10_000;

        if (!isBuy) {
            return oracleFloor;
        }

        address[] memory path = _swapPath(baseToken, false);
        try uniswapRouter.getAmountsOut(amountIn, path) returns (uint256[] memory amounts) {
            uint256 quoted = amounts[amounts.length - 1];
            if (quoted > 0) {
                uint256 poolFloor = (quoted * (10_000 - slippageBPS)) / 10_000;
                if (poolFloor < oracleFloor) {
                    return poolFloor;
                }
            }
        } catch {}

        return oracleFloor;
    }

    /// @dev Convert the wei-denominated gas refund into base-token units and consume it
    function _consumeGasRefundInBase(uint256 orderId, address baseToken) internal returns (uint256) {
        uint256 gasRefundWei = orderGasRefundWei[orderId];
        if (gasRefundWei == 0) return 0;
        delete orderGasRefundWei[orderId];

        if (baseToken == NATIVE) {
            return gasRefundWei; // output is ETH; refund already in wei
        }
        TradeConfig storage cfg = tradeConfigs[baseToken];
        uint256 ethPrice = _getEthPrice();
        uint256 basePrice = _getTokenPrice(baseToken);
        // wei * ethUsd / 1e18 = USD(8 dec); USD * 10^baseDec / baseUsd = base units
        return (gasRefundWei * ethPrice * (10 ** uint256(cfg.baseDecimals))) / (basePrice * 1e18);
    }

    /// @dev Split payout at settlement: protocol fee to the treasury (feeRecipient),
    ///      gas-in-kind refund to the relayer float (gasRecipient) — no round-trip.
    function _payFees(uint256 orderId, address token, uint256 fee, uint256 gasRefund) internal {
        if (fee > 0) {
            _payOut(token, feeRecipient, fee);
            emit ProtocolFeeCollected(orderId, token, fee, feeRecipient);
        }
        if (gasRefund > 0) {
            _payOut(token, gasRecipient, gasRefund);
            emit GasRefundCollected(orderId, token, gasRefund);
        }
    }

    function _payOut(address token, address to, uint256 amount) private {
        if (token == NATIVE) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert FeeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /// @dev Deduct from the vault via the sufficiency-proof path (vaultId if available)
    function _vaultDeduct(
        uint256 orderId,
        uint256 amount,
        address token,
        bytes calldata sufficiencyCleartexts,
        bytes calldata sufficiencyProof
    ) internal {
        uint256 traderVaultId = orderVaultIds[orderId];
        if (traderVaultId != 0) {
            vault.deductBalanceWithProofByVaultId(
                orderId, traderVaultId, amount, token, sufficiencyCleartexts, sufficiencyProof
            );
        } else {
            vault.deductBalanceWithProof(
                orderId, orderTraders[orderId], amount, token, sufficiencyCleartexts, sufficiencyProof
            );
        }
    }

    /// @dev Credit the vault; native ETH goes as msg.value, ERC-20 is transferred first
    function _vaultCredit(uint256 orderId, uint256 amount, address token) internal {
        uint256 traderVaultId = orderVaultIds[orderId];
        if (token == NATIVE) {
            if (traderVaultId != 0) {
                vault.creditBalanceByVaultId{value: amount}(traderVaultId, amount, NATIVE);
            } else {
                vault.creditBalance{value: amount}(orderTraders[orderId], amount, NATIVE);
            }
        } else {
            if (amount > 0) {
                IERC20(token).safeTransfer(address(vault), amount);
            }
            _vaultCreditNoValue(orderId, amount, token);
        }
    }

    function _vaultCreditNoValue(uint256 orderId, uint256 amount, address token) internal {
        uint256 traderVaultId = orderVaultIds[orderId];
        if (traderVaultId != 0) {
            vault.creditBalanceByVaultId(traderVaultId, amount, token);
        } else {
            vault.creditBalance(orderTraders[orderId], amount, token);
        }
    }

    // ============================================
    // SWAP CANCELLATION
    // ============================================

    function cancelSwapExecution(uint256 orderId) external nonReentrant whenNotPaused {
        _cancelSwapExecution(orderId, true);
    }

    function cancelSwapExecutionViaRelayer(uint256 orderId) external onlyRelayer nonReentrant whenNotPaused {
        _cancelSwapExecution(orderId, false);
    }

    /// @dev Restores any FHE lock from prepareDeductAuth* and resets to Pending
    function _cancelSwapExecution(uint256 orderId, bool checkOwner) internal {
        Order storage order = orders[orderId];

        if (order.orderId == 0) revert OrderNotFound();
        if (checkOwner && orderTraders[orderId] != msg.sender) revert NotOrderOwner();
        if (!swapExecutionRequested[orderId]) revert SwapNotRequested();

        if (swapSufficiencyHandles[orderId] != bytes32(0) || pendingBuyUsdcAmount[orderId] != 0) {
            vault.cancelDeductAuth(orderId);
            delete swapSufficiencyHandles[orderId];
            delete pendingBuyUsdcAmount[orderId];
            delete pendingBuyAmountBase[orderId];
        }

        swapExecutionRequested[orderId] = false;
        swapExecutionRequestTime[orderId] = 0;
        order.status = OrderStatus.Pending;
    }

    // ============================================
    // VIEWS
    // ============================================

    /// @notice Public order info — never reveals the trader
    function getOrderPublic(uint256 orderId)
        external
        view
        returns (bool exists, address baseToken, bool isBuy, OrderStatus status, uint256 timestamp)
    {
        Order storage order = orders[orderId];
        exists = order.orderId != 0;
        baseToken = order.baseToken;
        isBuy = order.isBuy;
        status = order.status;
        timestamp = order.timestamp;
    }

    /// @notice Full order struct — owner or relayer only
    function getMyOrder(uint256 orderId) external view returns (Order memory) {
        Order storage order = orders[orderId];
        if (order.orderId == 0) revert OrderNotFound();
        if (orderTraders[orderId] != msg.sender && !hasRole(RELAYER_ROLE, msg.sender)) {
            revert NotOrderOwner();
        }
        return order;
    }

    // ============================================
    // ADMIN
    // ============================================

    /// @notice One-time TimelockController wiring
    function setTimelock(address _timelock) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_timelock == address(0)) revert InvalidAddress();
        if (timelockConfigured) revert TimelockAlreadyConfigured();
        timelock = _timelock;
        timelockConfigured = true;
        emit TimelockSet(_timelock);
    }

    function setMaxOrdersPerBlock(uint256 _max) external onlyTimelockOrRole(PARAMS_ROLE) {
        if (_max < 10 || _max > 1000) revert InvalidMaxOrdersPerBlock(_max);
        emit MaxOrdersPerBlockUpdated(maxOrdersPerBlock, _max);
        maxOrdersPerBlock = _max;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function setFeeRecipient(address newRecipient) external onlyTimelockOrRole(PARAMS_ROLE) {
        if (newRecipient == address(0)) revert InvalidFeeRecipient();
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    function setGasRecipient(address newRecipient) external onlyTimelockOrRole(PARAMS_ROLE) {
        if (newRecipient == address(0)) revert InvalidFeeRecipient();
        emit GasRecipientUpdated(gasRecipient, newRecipient);
        gasRecipient = newRecipient;
    }

    function setMaxGasRefundWei(uint128 newMax) external onlyTimelockOrRole(PARAMS_ROLE) {
        emit MaxGasRefundUpdated(maxGasRefundWei, newMax);
        maxGasRefundWei = newMax;
    }

    function setFeeBps(uint16 newFeeBps) external onlyTimelockOrRole(PARAMS_ROLE) {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps, MAX_FEE_BPS);
        emit FeeBpsUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    /// @notice Rescue stuck ERC-20 (incident response — not a fee path)
    function rescueERC20(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0) || to == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit TokensRescued(token, to, amount);
    }

    /// @notice Receive ETH (WETH unwrapping + vault deducts)
    receive() external payable {}
}
