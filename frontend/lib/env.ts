/**
 * Environment + per-chain contract addresses.
 * Sepolia: required for live desk. Mainnet: optional until Phase D SSOT exists.
 */

import { mainnet, sepolia } from "wagmi/chains";
import { getDeskNetwork, isDeskLive } from "./networks";

export const env = {
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "",
  // Sepolia (live)
  vaultAddress: process.env.NEXT_PUBLIC_VAULT_ADDRESS || "",
  exchangeAddress: process.env.NEXT_PUBLIC_EXCHANGE_ADDRESS || "",
  usdtAddress: process.env.NEXT_PUBLIC_USDT_ADDRESS || "",
  subgraphUrl: process.env.NEXT_PUBLIC_SUBGRAPH_URL || "",
  relayerUrl: process.env.NEXT_PUBLIC_RELAYER_URL || "http://localhost:3001",
  // Mainnet (Phase D — leave empty until deployments/mainnet.json)
  vaultAddressMainnet: process.env.NEXT_PUBLIC_VAULT_ADDRESS_MAINNET || "",
  exchangeAddressMainnet: process.env.NEXT_PUBLIC_EXCHANGE_ADDRESS_MAINNET || "",
  usdtAddressMainnet: process.env.NEXT_PUBLIC_USDT_ADDRESS_MAINNET || "",
  subgraphUrlMainnet: process.env.NEXT_PUBLIC_SUBGRAPH_URL_MAINNET || "",
  relayerUrlMainnet: process.env.NEXT_PUBLIC_RELAYER_URL_MAINNET || "",
} as const;

export type ContractAddresses = {
  vaultAddress: string;
  exchangeAddress: string;
  usdtAddress: string;
  subgraphUrl: string;
  relayerUrl: string;
  configured: boolean;
};

export function validateEnv(): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!env.vaultAddress) missing.push("NEXT_PUBLIC_VAULT_ADDRESS");
  if (!env.exchangeAddress) missing.push("NEXT_PUBLIC_EXCHANGE_ADDRESS");
  if (!env.usdtAddress) missing.push("NEXT_PUBLIC_USDT_ADDRESS");
  return { valid: missing.length === 0, missing };
}

export function requireConfig() {
  const { valid, missing } = validateEnv();
  if (!valid) {
    console.error(
      `Missing Sepolia configuration: ${missing.join(", ")}. SSOT: noctis-protocol/deployments/sepolia.json`
    );
    throw new Error("Sepolia configuration incomplete");
  }
}

/** Addresses for a chain. Mainnet returns empty until env is filled. */
export function getContractAddressesForChain(chainId: number | undefined): ContractAddresses {
  if (chainId === mainnet.id) {
    const vaultAddress = env.vaultAddressMainnet;
    const exchangeAddress = env.exchangeAddressMainnet;
    const usdtAddress = env.usdtAddressMainnet;
    return {
      vaultAddress,
      exchangeAddress,
      usdtAddress,
      subgraphUrl: env.subgraphUrlMainnet,
      relayerUrl: env.relayerUrlMainnet || env.relayerUrl,
      configured: Boolean(vaultAddress && exchangeAddress && usdtAddress),
    };
  }

  // Default / Sepolia
  return {
    vaultAddress: env.vaultAddress,
    exchangeAddress: env.exchangeAddress,
    usdtAddress: env.usdtAddress,
    subgraphUrl: env.subgraphUrl,
    relayerUrl: env.relayerUrl,
    configured: Boolean(env.vaultAddress && env.exchangeAddress && env.usdtAddress),
  };
}

/** @deprecated Prefer getContractAddressesForChain(chainId) — Sepolia defaults for SSR. */
export function getContractAddresses() {
  const a = getContractAddressesForChain(sepolia.id);
  return {
    vaultAddress: a.vaultAddress,
    exchangeAddress: a.exchangeAddress,
    usdtAddress: a.usdtAddress,
  };
}

export function getNetworkInfo(chainId: number | undefined = sepolia.id) {
  const desk = getDeskNetwork(chainId) ?? getDeskNetwork(sepolia.id)!;
  return {
    name: desk.label,
    chainId: desk.chain.id,
    explorer: desk.explorer,
    live: desk.live && isDeskLive(desk.chain.id),
    rpc:
      desk.chain.id === sepolia.id
        ? "https://ethereum-sepolia-rpc.publicnode.com"
        : "https://rpc.ankr.com/eth",
    gateway:
      desk.chain.id === sepolia.id
        ? "0xa02Cda4Ca3a71D7C46997716F4283aa851C28812"
        : "",
  };
}

/** Default for explorer links before wallet connects (Sepolia). */
export const NETWORK_INFO = getNetworkInfo(sepolia.id);
