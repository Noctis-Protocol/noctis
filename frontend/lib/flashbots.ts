/**
 * Flashbots Protect Integration
 * 
 * Sends transactions privately to block builders, bypassing the public mempool.
 * This prevents MEV extraction (frontrunning, sandwich attacks).
 * 
 * How it works:
 * 1. Transaction is sent to Flashbots RPC instead of public mempool
 * 2. Only block builders see the transaction
 * 3. Transaction is included directly in a block
 * 4. No public visibility = no frontrunning
 * 
 * Endpoints:
 * - Mainnet: https://rpc.flashbots.net
 * - Sepolia: https://rpc-sepolia.flashbots.net
 */

import { 
  createPublicClient,
  http, 
  type Hash,
  encodeFunctionData,
  type WalletClient,
  type PublicClient,
} from "viem";
import { sepolia, mainnet } from "viem/chains";

// Flashbots RPC endpoints
const FLASHBOTS_RPC = {
  mainnet: "https://rpc.flashbots.net",
  sepolia: "https://rpc-sepolia.flashbots.net",
} as const;

// Status API endpoints
const FLASHBOTS_STATUS_API = {
  mainnet: "https://protect.flashbots.net/tx/",
  sepolia: "https://protect-sepolia.flashbots.net/tx/",
} as const;

export type FlashbotsNetwork = "mainnet" | "sepolia";

export interface FlashbotsConfig {
  network: FlashbotsNetwork;
}

export interface FlashbotsTransactionRequest {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface FlashbotsStatus {
  status: "PENDING" | "INCLUDED" | "FAILED" | "CANCELLED" | "UNKNOWN";
  hash: Hash;
  blockNumber?: number;
}

/**
 * Create a Flashbots-enabled public client
 * This client sends transactions to Flashbots RPC instead of public mempool
 */
export function createFlashbotsPublicClient(network: FlashbotsNetwork = "sepolia") {
  const chain = network === "mainnet" ? mainnet : sepolia;
  const rpcUrl = FLASHBOTS_RPC[network];
  
  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
}

/**
 * Get Flashbots RPC URL for a network
 * Users can add this to their wallet for MEV protection
 */
export function getFlashbotsRpcUrl(network: FlashbotsNetwork): string {
  return FLASHBOTS_RPC[network];
}

/**
 * Instructions for adding Flashbots RPC to MetaMask
 */
export const FLASHBOTS_SETUP_INSTRUCTIONS = {
  mainnet: {
    networkName: "Ethereum Mainnet (Flashbots)",
    rpcUrl: FLASHBOTS_RPC.mainnet,
    chainId: 1,
    symbol: "ETH",
    blockExplorer: "https://etherscan.io",
  },
  sepolia: {
    networkName: "Sepolia (Flashbots)",
    rpcUrl: FLASHBOTS_RPC.sepolia,
    chainId: 11155111,
    symbol: "ETH",
    blockExplorer: "https://sepolia.etherscan.io",
  },
};

/**
 * Check transaction status via Flashbots Status API
 * 
 * @param txHash - Transaction hash to check
 * @param network - Network
 * @returns Transaction status
 */
export async function getFlashbotsStatus(
  txHash: Hash,
  network: FlashbotsNetwork = "sepolia"
): Promise<FlashbotsStatus> {
  const statusUrl = FLASHBOTS_STATUS_API[network];
  
  try {
    const response = await fetch(`${statusUrl}${txHash}`);
    
    if (!response.ok) {
      return { status: "UNKNOWN", hash: txHash };
    }
    
    const data = await response.json();
    
    return {
      status: data.status || "PENDING",
      hash: txHash,
      blockNumber: data.blockNumber,
    };
  } catch {
    return { status: "UNKNOWN", hash: txHash };
  }
}

/**
 * Wait for a Flashbots transaction to be included
 * 
 * @param txHash - Transaction hash
 * @param network - Network
 * @param timeoutMs - Timeout in milliseconds (default 2 minutes)
 * @returns Final status
 */
export async function waitForFlashbotsInclusion(
  txHash: Hash,
  network: FlashbotsNetwork = "sepolia",
  timeoutMs: number = 120_000
): Promise<FlashbotsStatus> {
  const startTime = Date.now();
  const pollInterval = 3000; // 3 seconds
  
  while (Date.now() - startTime < timeoutMs) {
    const status = await getFlashbotsStatus(txHash, network);
    
    if (status.status === "INCLUDED") {
      return status;
    }
    
    if (status.status === "FAILED" || status.status === "CANCELLED") {
      throw new Error(`Transaction ${status.status.toLowerCase()}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  
  throw new Error("Transaction inclusion timeout");
}

/**
 * Encode contract call data for Flashbots transaction
 */
export function encodeSwapCallbackData(
  orderId: bigint,
  cleartexts: `0x${string}`,
  proof: `0x${string}`,
  minAmountOut: bigint
): `0x${string}` {
  // ABI for executeSwapCallback (V2: routing is per-token, no poolFee)
  const abi = [{
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
  }] as const;
  
  return encodeFunctionData({
    abi,
    functionName: "executeSwapCallback",
    args: [orderId, cleartexts, proof, minAmountOut],
  });
}

/**
 * Check if Flashbots is available for current network
 */
export function isFlashbotsSupported(chainId: number): boolean {
  // Flashbots Protect supports Mainnet and Sepolia
  return chainId === 1 || chainId === 11155111;
}

/**
 * Get Flashbots network from chain ID
 */
export function getFlashbotsNetwork(chainId: number): FlashbotsNetwork | null {
  if (chainId === 1) return "mainnet";
  if (chainId === 11155111) return "sepolia";
  return null;
}
