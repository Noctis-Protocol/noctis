/**
 * Contract ABIs for Noctis Protocol V2 (multi-token).
 *
 * Trimmed from noctis-protocol/artifacts/contracts/v2/ — only the functions
 * and events actually used by the frontend.
 *
 * Conventions:
 * - Native ETH is represented as address(0) in both contracts.
 * - Every pair is quoted against USDC (6 decimals).
 * - Encrypted handles (euint128 / ebool / eaddress) surface as bytes32.
 */

/** Native ETH sentinel used by NoctisVaultV2 / NoctisExchangeV2. */
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as const;

// NoctisVaultV2 ABI (essential functions only)
export const NoctisVaultABI = [
  // Custom errors (needed so wagmi/viem decode reverts instead of "RPC 0x")
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "InvalidAddress", inputs: [] },
  { type: "error", name: "InsufficientBalance", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
  { type: "error", name: "TokenNotSupported", inputs: [] },
  { type: "error", name: "BelowMinimumDeposit", inputs: [] },
  { type: "error", name: "ExceedsMaximumDeposit", inputs: [] },
  { type: "error", name: "ExceedsMaximumWithdrawal", inputs: [] },
  { type: "error", name: "DepositTooFrequent", inputs: [] },
  { type: "error", name: "WithdrawalAlreadyExecuted", inputs: [] },
  { type: "error", name: "WithdrawalNotFound", inputs: [] },
  { type: "error", name: "InvalidWithdrawalAmount", inputs: [] },
  { type: "error", name: "CancellationTooEarly", inputs: [] },
  { type: "error", name: "NotWithdrawalRequester", inputs: [] },
  { type: "error", name: "NoVaultId", inputs: [] },
  { type: "error", name: "DecryptionAlreadyRequested", inputs: [] },
  { type: "error", name: "DecryptionNotRequested", inputs: [] },
  { type: "error", name: "DecryptionTimeoutExceeded", inputs: [] },
  { type: "error", name: "TooManyPendingWithdrawals", inputs: [] },
  { type: "error", name: "NothingToClaim", inputs: [] },
  { type: "error", name: "EnforcedPause", inputs: [] },
  {
    type: "error",
    name: "TooManyWithdrawals24h",
    inputs: [
      { name: "count", type: "uint256" },
      { name: "maxAllowed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "RetryTooEarly",
    inputs: [{ name: "timeLeft", type: "uint256" }],
  },
  // Token registry
  {
    name: "getSupportedTokens",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    name: "tokenConfigs",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "enabled", type: "bool" },
      { name: "decimals", type: "uint8" },
      { name: "minDeposit", type: "uint128" },
      { name: "maxDeposit", type: "uint128" },
      { name: "maxWithdrawal", type: "uint128" },
      { name: "maxDaily", type: "uint128" },
    ],
  },
  // Deposits
  {
    name: "depositETH",
    type: "function",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    name: "depositToken",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  // Withdrawals (plaintext amount path)
  {
    name: "requestWithdrawal",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint128" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  // Withdrawals (client-side encrypted amount + recipient — stealth exits)
  {
    name: "requestWithdrawalPrivate",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "encryptedAmount", type: "bytes32" }, // externalEuint128
      { name: "encryptedRecipient", type: "bytes32" }, // externalEaddress
      { name: "inputProof", type: "bytes" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "cancelWithdrawal",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [],
  },
  // Self-relay execution (v0.9): request → publicDecrypt → callback
  {
    name: "requestWithdrawalExecution",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "retryWithdrawalExecution",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "executeWithdrawalCallback",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "uint256" },
      { name: "cleartexts", type: "bytes" },
      { name: "decryptionProof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "getWithdrawalRequest",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "requestId", type: "uint256" },
          { name: "requester", type: "address" },
          { name: "token", type: "address" },
          { name: "encryptedAmount", type: "bytes32" },      // FHE handle (euint128)
          { name: "hasSufficientBalance", type: "bytes32" }, // FHE handle (ebool)
          { name: "requestTime", type: "uint256" },
          { name: "executed", type: "bool" },
          { name: "decryptionRequested", type: "bool" },
          { name: "decryptionRequestTime", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "claimETH",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  // Views (privacy-preserving: caller-scoped getters)
  {
    name: "getMyClaimableETH",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getMyVaultId",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getMyPendingCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "withdrawalCounter",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "hasUserDeposited",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  // Get encrypted balance handle (per token).
  // Note: contract function is nonpayable (calls FHE.allow), but we declare it
  // view because wagmi's useReadContract uses eth_call which simulates without
  // persisting state. The user already has ACL permissions from deposit.
  {
    name: "getEncryptedBalance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  // Events
  {
    name: "Deposited",
    type: "event",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "user", type: "address", indexed: false },
    ],
  },
  // PRIVACY (stealth exits v2): anonymous event — the requestId is read via
  // the caller-scoped getMyWithdrawalRequestIds() instead
  {
    name: "WithdrawalRequested",
    type: "event",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    name: "getMyWithdrawalRequestIds",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "WithdrawalExecuted",
    type: "event",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "recipient", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "WithdrawalCancelled",
    type: "event",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "requester", type: "address", indexed: false },
    ],
  },
  {
    name: "ETHClaimed",
    type: "event",
    inputs: [
      { name: "user", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "DecryptionReady",
    type: "event",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "handles", type: "bytes32[]", indexed: false },
    ],
  },
] as const;

// NoctisExchangeV2 ABI (essential functions only)
export const NoctisExchangeABI = [
  // Custom errors
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "TokenNotTradable", inputs: [] },
  { type: "error", name: "BelowMinimumOrderSize", inputs: [] },
  { type: "error", name: "ExceedsMaximumOrderSize", inputs: [] },
  { type: "error", name: "OrderTooFrequent", inputs: [] },
  { type: "error", name: "OrderNotFound", inputs: [] },
  { type: "error", name: "OrderNotPending", inputs: [] },
  { type: "error", name: "UnauthorizedCancellation", inputs: [] },
  { type: "error", name: "InvalidSwapAmount", inputs: [] },
  { type: "error", name: "ZeroSlippageTolerance", inputs: [] },
  { type: "error", name: "NotOrderOwner", inputs: [] },
  { type: "error", name: "SwapAlreadyRequested", inputs: [] },
  { type: "error", name: "SwapNotRequested", inputs: [] },
  { type: "error", name: "SwapDeadlinePassed", inputs: [] },
  { type: "error", name: "InvalidOrderType", inputs: [] },
  { type: "error", name: "BuySufficiencyNotPrepared", inputs: [] },
  { type: "error", name: "InsufficientEncryptedBalance", inputs: [] },
  { type: "error", name: "OutputTooSmallForFees", inputs: [] },
  { type: "error", name: "EnforcedPause", inputs: [] },
  {
    type: "error",
    name: "SlippageToleranceTooHigh",
    inputs: [
      { name: "requested", type: "uint256" },
      { name: "maximum", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "PriceDeviationExceeded",
    inputs: [
      { name: "deviationBPS", type: "uint256" },
      { name: "maxBPS", type: "uint256" },
    ],
  },
  // Pair registry
  {
    name: "getTradableTokens",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    name: "tradeConfigs",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "baseToken", type: "address" }],
    outputs: [
      { name: "enabled", type: "bool" },
      { name: "priceFeed", type: "address" },
      { name: "baseDecimals", type: "uint8" },
      { name: "routeViaWeth", type: "bool" },
      { name: "minOrderSize", type: "uint128" },
      { name: "maxOrderSize", type: "uint128" },
      { name: "minPriceUsd", type: "uint128" },
      { name: "maxPriceUsd", type: "uint128" },
    ],
  },
  // Order creation (direct path — relayed path goes through the keeper HTTP API)
  {
    name: "createMarketOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "baseToken", type: "address" },
      { name: "amountBase", type: "uint128" },
      { name: "isBuy", type: "bool" },
      { name: "slippageToleranceBPS", type: "uint16" },
      { name: "maxPriceDeviationBPS", type: "uint16" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  // Order management
  {
    name: "cancelOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [],
  },
  // Swap execution (v0.9 self-relay)
  {
    name: "requestSwapExecution",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "executeSwapCallback",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "uint256" },
      { name: "cleartexts", type: "bytes" },
      { name: "decryptionProof", type: "bytes" },
      { name: "minAmountOut", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "finalizeBuySwap",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "uint256" },
      { name: "sufficiencyCleartexts", type: "bytes" },
      { name: "sufficiencyProof", type: "bytes" },
      { name: "minAmountOut", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "cancelSwapExecution",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [],
  },
  // Views
  {
    name: "feeBps",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    name: "getOrderPublic",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [
      { name: "exists", type: "bool" },
      { name: "baseToken", type: "address" },
      { name: "isBuy", type: "bool" },
      { name: "status", type: "uint8" },
      { name: "timestamp", type: "uint256" },
    ],
  },
  {
    name: "getMyOrder",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "orderId", type: "uint256" },
          { name: "baseToken", type: "address" },
          { name: "encryptedTrader", type: "bytes32" },     // FHE handle (eaddress)
          { name: "encryptedAmountBase", type: "bytes32" }, // FHE handle (euint128)
          { name: "isBuy", type: "bool" },
          { name: "timestamp", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "slippageToleranceBPS", type: "uint16" },
          { name: "referencePriceUSD", type: "uint256" },
          { name: "maxPriceDeviationBPS", type: "uint16" },
        ],
      },
    ],
  },
  {
    name: "swapExecutionRequested",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "pendingBuyUsdcAmount",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "orderCounter",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // Events - Privacy-preserving (no addresses or amounts)
  {
    name: "OrderCreated",
    type: "event",
    anonymous: false,
    inputs: [
      { indexed: true, name: "orderId", type: "uint256" },
      { indexed: true, name: "baseToken", type: "address" },
      { indexed: false, name: "isBuy", type: "bool" },
      { indexed: false, name: "timestamp", type: "uint256" },
    ],
  },
  {
    name: "OrderFilledSimple",
    type: "event",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    name: "OrderFilledPrivate",
    type: "event",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "encryptedAmountIn", type: "bytes32", indexed: false },
      { name: "encryptedAmountOut", type: "bytes32", indexed: false },
    ],
  },
  {
    name: "SwapDecryptionReady",
    type: "event",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "handles", type: "bytes32[]", indexed: false },
    ],
  },
  {
    name: "BuySufficiencyReady",
    type: "event",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "sufficiencyHandle", type: "bytes32", indexed: false },
      { name: "usdcNeeded", type: "uint256", indexed: false },
    ],
  },
  {
    name: "OrderCancelled",
    type: "event",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
] as const;

// ERC20 ABI (approve for deposits + metadata for the dynamic token registry)
export const ERC20ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

/**
 * ERC-7984 confidential wrapper (cUSDC) — V2.5 confidential deposits.
 * wrap() is the ONLY public amount of the flow; the vault deposit itself
 * travels as an encrypted handle via confidentialTransferAndCall.
 */
export const ConfidentialWrapperABI = [
  {
    name: "wrap",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "confidentialTransferAndCall",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "encryptedAmount", type: "bytes32" },
      { name: "inputProof", type: "bytes" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "confidentialBalanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "underlying",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
