/**
 * Wagmi / RainbowKit — Sepolia live, Mainnet listed for in-app switch (contracts gated).
 */

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { mainnet, sepolia } from "wagmi/chains";
import { http, fallback } from "wagmi";
import { useAccount } from "wagmi";
import {
  env,
  getContractAddresses,
  getContractAddressesForChain,
  getNetworkInfo,
  NETWORK_INFO,
} from "./env";
import { SUPPORTED_CHAINS } from "./networks";

if (!env.walletConnectProjectId) {
  console.warn(
    "⚠️ NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID not set. Get one at https://cloud.walletconnect.com"
  );
}

const FLASHBOTS_RPC = "https://rpc.flashbots.net";
const useFlashbots = process.env.NEXT_PUBLIC_FLASHBOTS_PROTECT === "true";

const sepoliaTransport = fallback([
  http("https://ethereum-sepolia-rpc.publicnode.com"),
  http("https://rpc.sepolia.org"),
  http("https://1rpc.io/sepolia"),
]);

const mainnetTransport = useFlashbots
  ? fallback([
      http(FLASHBOTS_RPC),
      http("https://rpc.ankr.com/eth"),
      http("https://1rpc.io/eth"),
    ])
  : fallback([http("https://rpc.ankr.com/eth"), http("https://1rpc.io/eth")]);

export const config = getDefaultConfig({
  appName: "Noctis Protocol",
  projectId: env.walletConnectProjectId || "demo-project-id",
  chains: SUPPORTED_CHAINS,
  transports: {
    [sepolia.id]: sepoliaTransport,
    [mainnet.id]: mainnetTransport,
  },
  ssr: true,
});

export const FLASHBOTS_CONFIG = {
  enabled: useFlashbots,
  rpc: FLASHBOTS_RPC,
  builders: [
    "https://relay.flashbots.net",
    "https://builder0x69.io",
    "https://rpc.beaverbuild.org",
  ],
};

let _contractsCache: ReturnType<typeof getContractAddresses> | null = null;

export const CONTRACTS = new Proxy({} as ReturnType<typeof getContractAddresses>, {
  get(_target, prop) {
    if (!_contractsCache) {
      _contractsCache = getContractAddresses();
    }
    return _contractsCache[prop as keyof typeof _contractsCache];
  },
});

export { NETWORK_INFO, getNetworkInfo };

/** Chain-aware contract addresses for the connected wallet network. */
export function useContractAddresses() {
  const { chainId } = useAccount();
  return getContractAddressesForChain(chainId ?? sepolia.id);
}
