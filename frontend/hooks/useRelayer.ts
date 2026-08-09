/**
 * useRelayer - Privacy-preserving transaction relay hook
 * 
 * Signs EIP-712 typed data with the user's wallet, then sends the signed
 * request to the relayer HTTP server. The relayer submits the transaction
 * on-chain (hiding the user's address from tx.from).
 * 
 * Uses opaque vaultId instead of address in all signed messages.
 */

import { useCallback, useState, useEffect } from 'react';
import { useAccount, useReadContract, useSignTypedData } from 'wagmi';
import { env } from '../lib/env';
import { NoctisVaultABI } from '../lib/contracts/abi';

const RELAYER_URL = env.relayerUrl;

// EIP-712 Domain (must match NoctisExchangeV2 and the keeper relayer)
const EIP712_DOMAIN = {
  name: 'NoctisExchange' as const,
  version: '2' as const,
  chainId: 11155111,
  verifyingContract: env.exchangeAddress as `0x${string}`,
} as const;

// EIP-712 Types (V2: per-token orders — baseToken + amountBase in base units)
const CREATE_ORDER_TYPES = {
  CreateOrder: [
    { name: 'vaultId', type: 'uint256' },
    { name: 'baseToken', type: 'address' },
    { name: 'amountBase', type: 'uint128' },
    { name: 'isBuy', type: 'bool' },
    { name: 'slippageToleranceBPS', type: 'uint16' },
    { name: 'maxPriceDeviationBPS', type: 'uint16' },
    { name: 'gasRefundWei', type: 'uint128' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

const SWAP_REQUEST_TYPES = {
  SwapRequest: [
    { name: 'orderId', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

// V2: poolFee removed (routing is resolved per-token by the contract)
const SWAP_EXECUTION_TYPES = {
  SwapExecution: [
    { name: 'orderId', type: 'uint256' },
    { name: 'amount', type: 'uint128' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

const CANCEL_ORDER_TYPES = {
  CancelOrder: [
    { name: 'orderId', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

// Deadline: 5 minutes from now
function getDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 300);
}

/**
 * Fetch the suggested gas-in-kind refund from the relayer.
 * The user signs this flat amount in the CreateOrder intent; it is skimmed
 * from the swap output at settlement (capped on-chain by maxGasRefundWei).
 * Falls back to 0 (no refund) if the quote is unavailable.
 */
async function fetchGasRefundQuote(): Promise<bigint> {
  try {
    const res = await fetch(`${RELAYER_URL}/api/relay/gasQuote`);
    if (!res.ok) return 0n;
    const data = await res.json();
    return BigInt(data.gasRefundWei || '0');
  } catch {
    return 0n;
  }
}

interface RelayerStatus {
  available: boolean;
  relayer?: string;
  rpc?: string;
}

export function useRelayer() {
  const { address, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const [relayerStatus, setRelayerStatus] = useState<RelayerStatus>({ available: false });

  // Fetch user's vaultId (assigned on first deposit)
  const { data: vaultId, refetch: refetchVaultId } = useReadContract({
    address: env.vaultAddress as `0x${string}`,
    abi: NoctisVaultABI,
    functionName: 'getMyVaultId',
    query: {
      enabled: isConnected,
    },
  });

  // Meta-tx nonces: on-chain tracking removed (dead state — the contract never incremented
  // them, so reads always returned 0). Replay protection is the signed EIP-712 deadline;
  // clients sign nonce = 0 to keep the typed-data shape stable.
  const orderNonce = 0n;
  const swapNonce = 0n;

  // Check relayer health on mount
  useEffect(() => {
    async function checkHealth() {
      try {
        const res = await fetch(`${RELAYER_URL}/api/relay/health`);
        if (res.ok) {
          const data = await res.json();
          setRelayerStatus({ available: true, relayer: data.relayer, rpc: data.rpc });
        } else {
          setRelayerStatus({ available: false });
        }
      } catch {
        setRelayerStatus({ available: false });
      }
    }
    checkHealth();
    const interval = setInterval(checkHealth, 30000); // Check every 30s
    return () => clearInterval(interval);
  }, []);

  /**
   * Create a market order via relayer
   * User signs EIP-712 message with vaultId, relayer submits on-chain
   */
  const signAndCreateOrder = useCallback(async (params: {
    baseToken: `0x${string}`;
    amountBase: bigint;
    isBuy: boolean;
    slippageBPS: number;
    maxDeviationBPS: number;
    gasRefundWei?: bigint;
  }): Promise<{ orderId: string; txHash: string }> => {
    if (!vaultId) throw new Error('No vaultId found. Please deposit first.');
    if (!relayerStatus.available) throw new Error('Relayer is not available');

    const deadline = getDeadline();
    const nonce = orderNonce;

    // Gas-in-kind refund: quote from relayer unless caller pinned a value
    const gasRefundWei = params.gasRefundWei ?? (await fetchGasRefundQuote());

    // Sign EIP-712 message (wallet popup - no gas cost!)
    const signature = await signTypedDataAsync({
      domain: EIP712_DOMAIN,
      types: CREATE_ORDER_TYPES,
      primaryType: 'CreateOrder',
      message: {
        vaultId: BigInt(vaultId as bigint),
        baseToken: params.baseToken,
        amountBase: params.amountBase,
        isBuy: params.isBuy,
        slippageToleranceBPS: params.slippageBPS,
        maxPriceDeviationBPS: params.maxDeviationBPS,
        gasRefundWei,
        deadline,
        nonce,
      },
    });

    // Send to relayer
    const res = await fetch(`${RELAYER_URL}/api/relay/createOrder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vaultId: (vaultId as bigint).toString(),
        baseToken: params.baseToken,
        amountBase: params.amountBase.toString(),
        isBuy: params.isBuy,
        slippageBPS: params.slippageBPS,
        maxDeviationBPS: params.maxDeviationBPS,
        gasRefundWei: gasRefundWei.toString(),
        deadline: deadline.toString(),
        nonce: nonce.toString(),
        signature,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Relayer error');
    }

    return res.json();
  }, [vaultId, orderNonce, relayerStatus.available, signTypedDataAsync]);

  /**
   * Request swap execution via relayer
   */
  const signAndRequestSwap = useCallback(async (params: {
    orderId: bigint;
  }): Promise<{ txHash: string; handles: string[] }> => {
    if (!vaultId) throw new Error('No vaultId found');
    if (!relayerStatus.available) throw new Error('Relayer is not available');

    const deadline = getDeadline();
    const nonce = swapNonce;

    const signature = await signTypedDataAsync({
      domain: EIP712_DOMAIN,
      types: SWAP_REQUEST_TYPES,
      primaryType: 'SwapRequest',
      message: {
        orderId: params.orderId,
        deadline,
        nonce,
      },
    });

    const res = await fetch(`${RELAYER_URL}/api/relay/requestSwap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: params.orderId.toString(),
        vaultId: (vaultId as bigint).toString(),
        deadline: deadline.toString(),
        nonce: nonce.toString(),
        signature,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Relayer error');
    }

    return res.json();
  }, [vaultId, swapNonce, relayerStatus.available, signTypedDataAsync]);

  /**
   * Execute swap via relayer (with FHE decryption proof)
   */
  const signAndExecuteSwap = useCallback(async (params: {
    orderId: bigint;
    amount: bigint;
    minAmountOut: bigint;
    cleartexts: string;
    decryptionProof: string;
  }): Promise<{
    txHash: string;
    buySufficiencyHandle?: string;
    sufficiencyHandle?: string;
    usdcNeeded?: string;
  }> => {
    if (!vaultId) throw new Error('No vaultId found');
    if (!relayerStatus.available) throw new Error('Relayer is not available');

    const deadline = getDeadline();
    const nonce = swapNonce;

    const signature = await signTypedDataAsync({
      domain: EIP712_DOMAIN,
      types: SWAP_EXECUTION_TYPES,
      primaryType: 'SwapExecution',
      message: {
        orderId: params.orderId,
        amount: params.amount,
        minAmountOut: params.minAmountOut,
        deadline,
        nonce,
      },
    });

    const res = await fetch(`${RELAYER_URL}/api/relay/executeSwap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: params.orderId.toString(),
        amount: params.amount.toString(),
        minAmountOut: params.minAmountOut.toString(),
        cleartexts: params.cleartexts,
        decryptionProof: params.decryptionProof,
        vaultId: (vaultId as bigint).toString(),
        deadline: deadline.toString(),
        nonce: nonce.toString(),
        signature,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Relayer error');
    }

    return res.json();
  }, [vaultId, swapNonce, relayerStatus.available, signTypedDataAsync]);

  /**
   * Cancel order via relayer
   */
  const signAndCancelOrder = useCallback(async (params: {
    orderId: bigint;
  }): Promise<{ txHash: string }> => {
    if (!vaultId) throw new Error('No vaultId found');
    if (!relayerStatus.available) throw new Error('Relayer is not available');

    const deadline = getDeadline();
    const nonce = orderNonce;

    const signature = await signTypedDataAsync({
      domain: EIP712_DOMAIN,
      types: CANCEL_ORDER_TYPES,
      primaryType: 'CancelOrder',
      message: {
        orderId: params.orderId,
        deadline,
        nonce,
      },
    });

    const res = await fetch(`${RELAYER_URL}/api/relay/cancelOrder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: params.orderId.toString(),
        vaultId: (vaultId as bigint).toString(),
        deadline: deadline.toString(),
        nonce: nonce.toString(),
        signature,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Relayer error');
    }

    return res.json();
  }, [vaultId, orderNonce, relayerStatus.available, signTypedDataAsync]);

  return {
    // State
    vaultId: vaultId as bigint | undefined,
    relayerStatus,
    hasVaultId: vaultId !== undefined && vaultId !== null,

    // Actions
    signAndCreateOrder,
    signAndRequestSwap,
    signAndExecuteSwap,
    signAndCancelOrder,
    refetchVaultId,
  };
}
