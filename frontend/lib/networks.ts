/**
 * Supported desk networks.
 * Sepolia = live fhEVM path. Mainnet = UI switch ready; contracts gated until Phase D deploy.
 */

import { mainnet, sepolia, type Chain } from "wagmi/chains";

export type DeskNetworkId = "sepolia" | "mainnet";

export interface DeskNetwork {
  id: DeskNetworkId;
  chain: Chain;
  label: string;
  shortLabel: string;
  explorer: string;
  /** Base flag — Mainnet also needs NEXT_PUBLIC_*_MAINNET addresses. */
  live: boolean;
  /** Shown in switcher even if !live */
  comingSoonNote?: string;
}

export const DESK_NETWORKS: DeskNetwork[] = [
  {
    id: "sepolia",
    chain: sepolia,
    label: "Ethereum Sepolia",
    shortLabel: "Sepolia",
    explorer: "https://sepolia.etherscan.io",
    live: true,
  },
  {
    id: "mainnet",
    chain: mainnet,
    label: "Ethereum Mainnet",
    shortLabel: "Mainnet",
    explorer: "https://etherscan.io",
    live: false,
    comingSoonNote: "Soft open after Phase D deploy (fhEVM / coprocessor ready)",
  },
];

export const SUPPORTED_CHAINS = DESK_NETWORKS.map((n) => n.chain) as [Chain, ...Chain[]];

export function getDeskNetwork(chainId: number | undefined): DeskNetwork | undefined {
  if (chainId == null) return undefined;
  const base = DESK_NETWORKS.find((n) => n.chain.id === chainId);
  if (!base) return undefined;
  // Flip Mainnet to live when Phase D env addresses are present (avoid circular import of env).
  if (base.id === "mainnet") {
    const ready = Boolean(
      process.env.NEXT_PUBLIC_VAULT_ADDRESS_MAINNET &&
        process.env.NEXT_PUBLIC_EXCHANGE_ADDRESS_MAINNET &&
        process.env.NEXT_PUBLIC_USDT_ADDRESS_MAINNET
    );
    return {
      ...base,
      live: ready,
      comingSoonNote: ready ? undefined : base.comingSoonNote,
    };
  }
  return base;
}

export function isDeskLive(chainId: number | undefined): boolean {
  return Boolean(getDeskNetwork(chainId)?.live);
}
