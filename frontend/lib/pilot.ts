/**
 * Public pilot facts for docs / about (SSOT: noctis-protocol/deployments/sepolia.v2.json).
 * Env overrides when set; fallbacks match the current Sepolia V2 desk.
 */

const FALLBACK = {
  vault: "0xe65b394c8A4347D92bc665C60c6263Eb115d21A7",
  exchange: "0xCa06f9981407D0469DA5f9ffE78A6684DECD7d56",
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
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
  pair: "Registered tokens / USDC",
  vault:
    process.env.NEXT_PUBLIC_VAULT_ADDRESS?.trim() || FALLBACK.vault,
  exchange:
    process.env.NEXT_PUBLIC_EXCHANGE_ADDRESS?.trim() || FALLBACK.exchange,
  usdc:
    process.env.NEXT_PUBLIC_USDC_ADDRESS?.trim() ||
    process.env.NEXT_PUBLIC_USDT_ADDRESS?.trim() ||
    FALLBACK.usdc,
  subgraph: process.env.NEXT_PUBLIC_SUBGRAPH_URL?.trim() || FALLBACK.subgraph,
  github: FALLBACK.github,
  explorer: FALLBACK.explorer,
  explorerAddress(addr: string) {
    return `${FALLBACK.explorer}/address/${addr}`;
  },
} as const;
