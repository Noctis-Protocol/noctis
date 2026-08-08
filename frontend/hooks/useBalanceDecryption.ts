/**
 * useBalanceDecryption Hook
 * 
 * Provides private client-side decryption of encrypted FHE balances.
 * Uses @zama-fhe/relayer-sdk (via useFhevm) to decrypt balances off-chain.
 * 
 * Security:
 * - Decryption happens client-side only
 * - Requires ACL permissions (granted during deposit)
 * - Uses user's signature for authentication
 * - Plaintext balance never touches blockchain
 */

"use client";

import { useState, useCallback, useEffect } from "react";
import { useAccount, useReadContract } from "wagmi";
import { useContractAddresses } from "@/lib/wagmi";
import { NoctisVaultABI } from "@/lib/contracts/abi";
import { useFhevm } from "./useFhevm";

// LocalStorage keys for caching
// NOTE: Keys include vault address to invalidate cache on contract upgrade
const BALANCE_CACHE_KEY = "noctis_decrypted_balances_v2";
const HANDLE_CACHE_KEY = "noctis_decrypted_handles_v2";

// Load cached balances from localStorage
function loadCachedBalances(address: string, vaultAddress: string): { eth: DecryptedBalance | null; usdt: DecryptedBalance | null } {
  if (typeof window === "undefined") return { eth: null, usdt: null };
  
  try {
    // Include vault address in cache key to invalidate on contract upgrade
    const cacheKey = `${BALANCE_CACHE_KEY}_${vaultAddress.toLowerCase()}_${address.toLowerCase()}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      // Convert string values back to bigint
      return {
        eth: parsed.eth ? { ...parsed.eth, value: BigInt(parsed.eth.value) } : null,
        usdt: parsed.usdt ? { ...parsed.usdt, value: BigInt(parsed.usdt.value) } : null,
      };
    }
  } catch (e) {
    console.warn("Failed to load cached balances:", e);
  }
  return { eth: null, usdt: null };
}

// Save balances to localStorage
function saveCachedBalances(address: string, vaultAddress: string, eth: DecryptedBalance | null, usdt: DecryptedBalance | null) {
  if (typeof window === "undefined") return;
  
  try {
    const toSave = {
      eth: eth ? { ...eth, value: eth.value.toString() } : null,
      usdt: usdt ? { ...usdt, value: usdt.value.toString() } : null,
    };
    // Include vault address in cache key to invalidate on contract upgrade
    const cacheKey = `${BALANCE_CACHE_KEY}_${vaultAddress.toLowerCase()}_${address.toLowerCase()}`;
    localStorage.setItem(cacheKey, JSON.stringify(toSave));
  } catch (e) {
    console.warn("Failed to save cached balances:", e);
  }
}

// Cache the last successfully decrypted handle
function saveCachedHandle(address: string, vaultAddress: string, token: "ETH" | "USDC", handle: string) {
  if (typeof window === "undefined") return;
  try {
    const key = `${HANDLE_CACHE_KEY}_${vaultAddress.toLowerCase()}_${address.toLowerCase()}_${token}`;
    localStorage.setItem(key, handle);
  } catch (e) {
    console.warn("Failed to save cached handle:", e);
  }
}

// Get the last successfully decrypted handle
function getCachedHandle(address: string, vaultAddress: string, token: "ETH" | "USDC"): string | null {
  if (typeof window === "undefined") return null;
  try {
    const key = `${HANDLE_CACHE_KEY}_${vaultAddress.toLowerCase()}_${address.toLowerCase()}_${token}`;
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

// Check if the handle has changed (new deposit/transaction)
function hasHandleChanged(address: string, vaultAddress: string, token: "ETH" | "USDC", currentHandle: string): boolean {
  const cachedHandle = getCachedHandle(address, vaultAddress, token);
  if (!cachedHandle) return false; // No previous handle, first time
  return cachedHandle !== currentHandle;
}

export type TokenType = "ETH" | "USDC";

interface DecryptedBalance {
  value: bigint;
  formatted: string;
  decimals: number;
}

interface DecryptionState {
  eth: DecryptedBalance | null;
  usdt: DecryptedBalance | null;
  isDecrypting: boolean;
  isSyncing: boolean; // Gateway is syncing new ciphertext
  isNewDeposit: boolean; // New deposit detected, waiting for indexation
  error: string | null;
  retryCount: number;
}

interface UseBalanceDecryptionReturn {
  // State
  decrypted: DecryptionState;
  // Actions
  decryptBalance: (token: TokenType) => Promise<void>;
  clearDecrypted: () => void;
  // Status
  canDecrypt: boolean;
}

function isAclOrSyncError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("not authorized") ||
    m.includes("acl") ||
    m.includes("not ready") ||
    m.includes("timed_out") ||
    m.includes("503") ||
    m.includes("ciphertext") ||
    // Stale sessionId (server restarted / session expired): useFhevm drops the
    // signature cache on this error, so a retry gets a fresh keypair.
    m.includes("session")
  );
}

export function useBalanceDecryption(): UseBalanceDecryptionReturn {
  const { address, isConnected } = useAccount();
  const contracts = useContractAddresses();
  const { reencrypt, isReady: isFhevmReady } = useFhevm();

  const [state, setState] = useState<DecryptionState>({
    eth: null,
    usdt: null,
    isDecrypting: false,
    isSyncing: false,
    isNewDeposit: false,
    error: null,
    retryCount: 0,
  });

  // Max retries for sync / ACL indexation errors
  const MAX_SYNC_RETRIES = 4;
  const SYNC_RETRY_DELAY = 8000; // 8 seconds — ZAMA ACL often needs a short wait after balance writes

  // Load cached balances on mount
  useEffect(() => {
    if (address && contracts?.vaultAddress) {
      const cached = loadCachedBalances(address, contracts.vaultAddress);
      if (cached.eth || cached.usdt) {
        console.log("📦 Loaded cached balances from localStorage");
        setState((prev) => ({
          ...prev,
          eth: cached.eth,
          usdt: cached.usdt,
        }));
      }
    }
  }, [address, contracts?.vaultAddress]);

  // Read encrypted ETH balance handle via getEncryptedBalance(user, isEth=true)
  // Note: ethBalances mapping is now internal (privacy fix), use getter instead
  const { data: ethBalanceHandle, refetch: refetchEthHandle } = useReadContract({
    address: contracts?.vaultAddress as `0x${string}` | undefined,
    abi: NoctisVaultABI,
    functionName: "getEncryptedBalance",
    args: address ? [address, true] : undefined,
    query: {
      enabled: !!address && !!contracts?.vaultAddress,
    },
  });

  // Read encrypted USDT balance handle via getEncryptedBalance(user, isEth=false)
  // Note: usdtBalances mapping is now internal (privacy fix), use getter instead
  const { data: usdtBalanceHandle, refetch: refetchUsdtHandle } = useReadContract({
    address: contracts?.vaultAddress as `0x${string}` | undefined,
    abi: NoctisVaultABI,
    functionName: "getEncryptedBalance",
    args: address ? [address, false] : undefined,
    query: {
      enabled: !!address && !!contracts?.vaultAddress,
    },
  });

  // Decrypt balance for a specific token
  const decryptBalance = useCallback(
    async (token: TokenType) => {
      if (!address || !contracts?.vaultAddress || !isConnected) {
        setState((prev) => ({
          ...prev,
          error: "Wallet not connected",
        }));
        return;
      }

      if (!isFhevmReady) {
        setState((prev) => ({
          ...prev,
          error: "FHE library not ready",
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        isDecrypting: true,
        error: null,
      }));

      // Fetch handle via server (FHE-capable RPC). Browser RPCs often return a
      // new ephemeral FHE.asEuint128(0) handle each call — those have no ACL.
      let rawHandle: string | undefined;
      try {
        const res = await fetch(
          `/api/fhevm/balance-handle?user=${encodeURIComponent(address)}&token=${token}`
        );
        const raw = await res.text();
        let data: { error?: string; empty?: boolean; handle?: string };
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error(
            `Balance handle API returned non-JSON (HTTP ${res.status}). ` +
              `Use http://localhost:3000 and restart \`npm run dev\` if .next is stale.`
          );
        }
        if (!res.ok || data.error) {
          throw new Error(data.error || `Handle fetch failed (${res.status})`);
        }
        if (data.empty || !data.handle) {
          setState((prev) => ({
            ...prev,
            isDecrypting: false,
            error:
              token === "ETH"
                ? "No ETH vault balance — deposit ETH first"
                : "No USDC vault balance — deposit USDC first (min 10). A SELL credits USDC only after a deposit init.",
          }));
          return;
        }
        rawHandle = data.handle as string;
        console.log(`📡 Server balance handle: ${rawHandle}`);
      } catch (e) {
        console.warn("Server handle fetch failed, falling back to wagmi:", e);
        try {
          const refetched =
            token === "ETH" ? await refetchEthHandle() : await refetchUsdtHandle();
          rawHandle = (refetched.data ??
            (token === "ETH" ? ethBalanceHandle : usdtBalanceHandle)) as
            | string
            | undefined;
        } catch {
          rawHandle = (token === "ETH" ? ethBalanceHandle : usdtBalanceHandle) as
            | string
            | undefined;
        }
      }

      if (!rawHandle || rawHandle === "0x0000000000000000000000000000000000000000000000000000000000000000") {
        setState((prev) => ({
          ...prev,
          isDecrypting: false,
          error: token === "ETH" 
            ? "No ETH balance to decrypt (deposit first)" 
            : "No USDT balance to decrypt (deposit first)",
        }));
        return;
      }

      // Convert bytes32 hex string to bigint for the reencrypt function
      const handle = BigInt(rawHandle as string);

      // Use the raw hex for handle comparison/caching
      const handleHex = rawHandle as string;
      
      // Check if this is a new handle (new deposit/transaction)
      const isNewHandle = hasHandleChanged(address, contracts.vaultAddress, token, handleHex);
      if (isNewHandle) {
        console.log(`🆕 New ${token} balance handle — waiting briefly for ZAMA ACL index...`);
        await new Promise((r) => setTimeout(r, 3000));
      }

      try {
        console.log(`Decrypting ${token} balance...`);
        console.log(`Handle: ${handleHex}`);
        console.log(`Contract: ${contracts.vaultAddress}`);
        console.log(`User: ${address}`);

        // Reencrypt (private decryption) the balance
        const cleartext = await reencrypt(
          handle,
          contracts.vaultAddress,
          address
        );

        if (cleartext === null) {
          throw new Error(
            "Balance decrypt failed. Wait ~15s after a deposit/swap for ZAMA ACL, then retry."
          );
        }

        const decimals = token === "ETH" ? 18 : 6;
        const divisor = BigInt(10 ** decimals);
        
        // UNDERFLOW DETECTION: Values close to 2^128 indicate an underflow
        // This happens when pending withdrawals exceed the actual balance
        // Max reasonable balance: 1 million ETH (10^24 wei) or 1 billion USDT (10^15)
        const maxReasonableBalance = token === "ETH" 
          ? BigInt(10) ** BigInt(24)  // 1 million ETH
          : BigInt(10) ** BigInt(15); // 1 billion USDT
        
        const isUnderflow = cleartext > maxReasonableBalance;
        
        // Format the balance (or show 0 if underflow)
        const safeValue = isUnderflow ? BigInt(0) : cleartext;
        const integerPart = safeValue / divisor;
        const fractionalPart = safeValue % divisor;
        const fractionalStr = fractionalPart.toString().padStart(decimals, "0");
        // Match desk trade / wallet formatting (ETH 4 dp, USDC 2 dp)
        const displayDecimals = token === "ETH" ? 4 : 2;
        const trimmedFractional = fractionalStr.slice(0, displayDecimals);
        
        const formatted = isUnderflow 
          ? "0.00 (pending)" // Show pending indicator for underflow
          : `${integerPart}.${trimmedFractional}`;
        
        if (isUnderflow) {
          console.warn(`⚠️ ${token} balance underflow detected - showing 0 (cancel pending withdrawals to restore)`);
        }

        const decryptedBalance: DecryptedBalance = {
          value: cleartext,
          formatted,
          decimals,
        };

        setState((prev) => {
          // State key is `usdt` (legacy); UI token label is USDC
          const newState: DecryptionState = {
            ...prev,
            eth: token === "ETH" ? decryptedBalance : prev.eth,
            usdt: token === "USDC" ? decryptedBalance : prev.usdt,
            isDecrypting: false,
            isSyncing: false,
            isNewDeposit: false,
            error: null,
            retryCount: 0,
          };
          
          // Save to localStorage for persistence across page refreshes
          if (address && contracts.vaultAddress) {
            saveCachedBalances(
              address,
              contracts.vaultAddress,
              newState.eth,
              newState.usdt
            );
            saveCachedHandle(address, contracts.vaultAddress, token, handleHex);
            console.log("💾 Saved decrypted balance and handle to cache");
          }
          
          return newState;
        });

        console.log(`✅ ${token} balance decrypted: ${formatted}`);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Decryption failed";
        console.error(`Decryption failed for ${token}:`, err);
        
        // ACL not indexed yet, or stale handle after a swap debit — retry with fresh handle
        const isSyncError = isAclOrSyncError(errorMessage);
        
        if (isSyncError && state.retryCount < MAX_SYNC_RETRIES) {
          console.log(`🔄 ACL/gateway syncing... retry in ${SYNC_RETRY_DELAY/1000}s (attempt ${state.retryCount + 1}/${MAX_SYNC_RETRIES})`);
          
          setState((prev) => ({
            ...prev,
            isDecrypting: false,
            isSyncing: true,
            isNewDeposit: isNewHandle,
            error: null,
            retryCount: prev.retryCount + 1,
          }));
          
          setTimeout(() => {
            console.log(`🔄 Retrying decryption for ${token}...`);
            decryptBalance(token);
          }, SYNC_RETRY_DELAY);
        } else if (isSyncError) {
          console.log(`⏳ ACL still syncing after ${MAX_SYNC_RETRIES} retries.`);
          const usdcHint =
            token === "USDC"
              ? " If you never deposited USDC, deposit ≥10 USDC first (SELL credit alone may not init ACL on current vault)."
              : "";
          setState((prev) => ({
            ...prev,
            isDecrypting: false,
            isSyncing: false,
            isNewDeposit: isNewHandle,
            error:
              "Cannot decrypt this balance yet." + usdcHint + " Wait ~15s after deposit then retry.",
            retryCount: 0,
          }));
        } else {
          setState((prev) => ({
            ...prev,
            isDecrypting: false,
            isSyncing: false,
            isNewDeposit: false,
            error: errorMessage,
          }));
        }
      }
    },
    [
      address,
      contracts,
      isConnected,
      isFhevmReady,
      reencrypt,
      ethBalanceHandle,
      usdtBalanceHandle,
      refetchEthHandle,
      refetchUsdtHandle,
      state.retryCount,
    ]
  );

  // Clear decrypted balances (on modal close)
  const clearDecrypted = useCallback(() => {
    setState({
      eth: null,
      usdt: null,
      isDecrypting: false,
      isSyncing: false,
      isNewDeposit: false,
      error: null,
      retryCount: 0,
    });
  }, []);

  const canDecrypt = isConnected && isFhevmReady && !!contracts?.vaultAddress;

  return {
    decrypted: state,
    decryptBalance,
    clearDecrypted,
    canDecrypt,
  };
}
