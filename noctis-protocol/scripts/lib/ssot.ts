/**
 * Deployment SSOT helpers — Sepolia (pilot) + Mainnet (Phase D).
 */

import * as fs from "fs";
import * as path from "path";

export type SupportedChainId = 1 | 11155111;

export function networkNameForChainId(chainId: bigint | number): "mainnet" | "sepolia" {
  const id = typeof chainId === "bigint" ? Number(chainId) : chainId;
  if (id === 1) return "mainnet";
  if (id === 11155111) return "sepolia";
  throw new Error(
    `Unsupported chainId ${id}. Use --network sepolia or --network mainnet.`
  );
}

export function assertSupportedChain(chainId: bigint): SupportedChainId {
  const name = networkNameForChainId(chainId);
  return name === "mainnet" ? 1 : 11155111;
}

export function ssotPathForChain(chainId: bigint | number): string {
  const name = networkNameForChainId(chainId);
  return path.join(__dirname, "..", "..", "deployments", `${name}.json`);
}

export function loadSsot(chainId: bigint | number): {
  path: string;
  data: any;
  network: "mainnet" | "sepolia";
} {
  const network = networkNameForChainId(chainId);
  const ssotPath = ssotPathForChain(chainId);
  if (!fs.existsSync(ssotPath)) {
    throw new Error(
      `Missing SSOT ${ssotPath}. Deploy first (deploy:sepolia / deploy:mainnet) or copy from mainnet.json.example.`
    );
  }
  return {
    path: ssotPath,
    data: JSON.parse(fs.readFileSync(ssotPath, "utf8")),
    network,
  };
}

export function saveSsot(ssotPath: string, data: unknown) {
  fs.writeFileSync(ssotPath, JSON.stringify(data, null, 2) + "\n");
}

/** RPC URL for Safe SDK / off-hardhat clients. */
export function rpcUrlForChain(chainId: bigint | number): string {
  const network = networkNameForChainId(chainId);
  if (network === "mainnet") {
    return (
      process.env.MAINNET_RPC ||
      process.env.ETH_RPC ||
      "https://rpc.ankr.com/eth"
    );
  }
  return (
    process.env.SEPOLIA_RPC ||
    process.env.SEPOLIA_RPC_URL ||
    "https://ethereum-sepolia-rpc.publicnode.com"
  );
}

/** Default Timelock delay: 5m Sepolia (smoke), 48h mainnet. */
export function defaultTimelockDelay(chainId: bigint | number): number {
  return networkNameForChainId(chainId) === "mainnet" ? 172_800 : 300;
}
