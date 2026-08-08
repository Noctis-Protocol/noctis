/**
 * Contract ABIs for Noctis Protocol
 * 
 * Minimal ABIs containing only the functions used by the frontend.
 * Full ABIs can be imported from @noctis/shared if needed.
 */

// NoctisVault ABI (essential functions only)
export const NoctisVaultABI = [
  // Custom errors (needed so wagmi/viem decode reverts instead of "RPC 0x")
  { type: "error", name: "TooManyPendingWithdrawals", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "BelowMinimumDeposit", inputs: [] },
  { type: "error", name: "InvalidAddress", inputs: [] },
  { type: "error", name: "WithdrawalAlreadyExecuted", inputs: [] },
  { type: "error", name: "WithdrawalNotFound", inputs: [] },
  { type: "error", name: "NotWithdrawalOwner", inputs: [] },
  { type: "error", name: "NotWithdrawalRequester", inputs: [] },
  { type: "error", name: "CancellationTooEarly", inputs: [] },
  { type: "error", name: "EnforcedPause", inputs: [] },
  // Deposits
  {
    name: "depositETH",
    type: "function",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    name: "depositUSDT",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  // Withdrawals
  {
    name: "requestEncryptedWithdrawal",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint128" },
      { name: "isEth", type: "bool" },
    ],
    outputs: [{ name: "requestId", type: "uint256" }],
  },
  // Privacy-first withdrawal with client-side encryption (v1.2.0)
  // Amount and recipient are encrypted BEFORE TX, never visible in input data
  {
    name: "requestEncryptedWithdrawalPrivate",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "encryptedAmount", type: "bytes32" },    // externalEuint128
      { name: "encryptedRecipient", type: "bytes32" }, // externalEaddress
      { name: "inputProof", type: "bytes" },           // ZK proof
      { name: "isEth", type: "bool" },
    ],
    outputs: [{ name: "requestId", type: "uint256" }],
  },
  {
    name: "cancelWithdrawal",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [],
  },
  // User-initiated withdrawal execution (v1.1.0)
  {
    name: "requestWithdrawalExecution",
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
    name: "withdrawalRequests",
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
          { name: "plaintextRecipient", type: "address" },
          { name: "encryptedRecipient", type: "bytes32" },   // FHE handle (eaddress)
          { name: "encryptedAmount", type: "bytes32" },      // FHE handle (euint128)
          { name: "originalBalance", type: "bytes32" },      // FHE handle (euint128)
          { name: "hasSufficientBalance", type: "bytes32" }, // FHE handle (ebool)
          { name: "isEth", type: "bool" },
          { name: "requestTime", type: "uint256" },
          { name: "executed", type: "bool" },
          { name: "gatewayRequestId", type: "uint256" },
          { name: "gatewayRequested", type: "bool" },
          { name: "gatewayRequestTime", type: "uint256" },
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
  // Views (privacy-preserving: user-only getters)
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
    name: "getMyWithdrawalStats",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "ethWithdrawn24h", type: "uint256" },
          { name: "usdtWithdrawn24h", type: "uint256" },
          { name: "lastWithdrawalTime", type: "uint256" },
          { name: "withdrawalCount24h", type: "uint256" },
          { name: "lifetimeDeposits", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "hasUserDeposited",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "isEth", type: "bool" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  // Get encrypted balance handle (replaces old public ethBalances/usdtBalances getters)
  // Note: Contract function is nonpayable (calls FHE.allow), but we declare as view
  // because wagmi's useReadContract uses eth_call which simulates without persisting state.
  // The user already has ACL permissions from deposit, so we just need the handle value.
  {
    name: "getEncryptedBalance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "isEth", type: "bool" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  // Events
  {
    name: "ETHDeposited",
    type: "event",
    inputs: [
      { name: "user", type: "address", indexed: true },
    ],
  },
  {
    name: "USDTDeposited",
    type: "event",
    inputs: [
      { name: "user", type: "address", indexed: true },
    ],
  },
  {
    name: "WithdrawalRequested",
    type: "event",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "requester", type: "address", indexed: false },
      { name: "isEth", type: "bool", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    name: "ETHClaimed",
    type: "event",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "DecryptionReady",
    type: "event",
    inputs: [
      { name: "requestId", type: "uint256", indexed: true },
      { name: "handles", type: "bytes32[]", indexed: false },
      { name: "keeper", type: "address", indexed: true },
    ],
  },
] as const;

// NoctisExchange ABI (essential functions only)
export const NoctisExchangeABI = [
  // Order creation
  {
    name: "createMarketOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountETH", type: "uint128" },
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
  // User-initiated swap execution (privacy-first flow)
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
      { name: "poolFee", type: "uint24" },
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
      { name: "poolFee", type: "uint24" },
    ],
    outputs: [],
  },
  // Relayer-only (CRIT-1). BUY path only prepares sufficiency — user must finalizeBuySwap.
  {
    name: "executeSwapViaRelayer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "uint256" },
      { name: "amount", type: "uint128" },
      { name: "minAmountOut", type: "uint256" },
      { name: "poolFee", type: "uint24" },
      { name: "cleartexts", type: "bytes" },
      { name: "decryptionProof", type: "bytes" },
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
  {
    name: "feeBps",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    name: "MAX_FEE_BPS",
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
      { name: "isBuy", type: "bool" },
      { name: "status", type: "uint8" },
      { name: "timestamp", type: "uint256" },
      { name: "orderType", type: "uint8" },
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
          { name: "encryptedTrader", type: "bytes32" },      // FHE handle (eaddress)
          { name: "encryptedAmountETH", type: "bytes32" },   // FHE handle (euint128)
          { name: "encryptedAmountUSDT", type: "bytes32" },  // FHE handle (euint128)
          { name: "isBuy", type: "bool" },
          { name: "timestamp", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "orderType", type: "uint8" },
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
    name: "pendingBuyUsdtAmount",
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
      { indexed: false, name: "isBuy", type: "bool" },
      { indexed: false, name: "timestamp", type: "uint256" },
      { indexed: false, name: "orderType", type: "uint8" },
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
      { name: "usdtNeeded", type: "uint256", indexed: false },
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

// ERC20 ABI (for USDT approval)
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
] as const;
