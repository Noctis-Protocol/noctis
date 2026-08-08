/**
 * ZAMA relayer-sdk host config by chain.
 * Sepolia = live desk. Mainnet = ready when contracts deploy (Phase D).
 */

export type FheChainId = 1 | 11155111;

export async function getFhevmHostConfig(chainId: number = 11155111) {
  const sdk = await import("@zama-fhe/relayer-sdk/node");
  if (chainId === 1) {
    const cfg = sdk.MainnetConfigV2 || sdk.MainnetConfig;
    return {
      chainId: 1 as const,
      config: cfg,
      rpc: process.env.MAINNET_RPC || "https://rpc.ankr.com/eth",
      label: "mainnet",
    };
  }
  return {
    chainId: 11155111 as const,
    config: sdk.SepoliaConfigV2 || sdk.SepoliaConfig,
    rpc: process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
    label: "sepolia",
  };
}

export function parseChainIdParam(
  value: string | null | undefined,
  fallback = 11155111
): number {
  if (!value) return fallback;
  const n = Number(value);
  if (n === 1 || n === 11155111) return n;
  return fallback;
}
