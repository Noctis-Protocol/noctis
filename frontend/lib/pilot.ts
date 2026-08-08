/**
 * Public pilot facts for docs / about (SSOT: noctis-protocol/deployments/sepolia.json).
 * Env overrides when set; fallbacks match the current Sepolia desk.
 */

const FALLBACK = {
  vault: "0x6607cE016237C3D8969B318018604c09D16fdd03",
  exchange: "0xcF13F272cdc5684c3863b589C2a9fb14A0aa0362",
  usdt: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  feeBps: 5,
  subgraph:
    "https://api.studio.thegraph.com/query/1724540/noctis-protocol/v0.9.0",
  github: "https://github.com/Noctis-Protocol/noctis",
  explorer: "https://sepolia.etherscan.io",
} as const;

export const PILOT = {
  network: "Ethereum Sepolia",
  chainId: 11155111,
  feeBps: FALLBACK.feeBps,
  feeLabel: "0.05%",
  pair: "ETH / USDC (USDT slot on Sepolia)",
  vault:
    process.env.NEXT_PUBLIC_VAULT_ADDRESS?.trim() || FALLBACK.vault,
  exchange:
    process.env.NEXT_PUBLIC_EXCHANGE_ADDRESS?.trim() || FALLBACK.exchange,
  usdt: process.env.NEXT_PUBLIC_USDT_ADDRESS?.trim() || FALLBACK.usdt,
  subgraph: process.env.NEXT_PUBLIC_SUBGRAPH_URL?.trim() || FALLBACK.subgraph,
  github: FALLBACK.github,
  explorer: FALLBACK.explorer,
  explorerAddress(addr: string) {
    return `${FALLBACK.explorer}/address/${addr}`;
  },
} as const;
