/**
 * useBalanceDecryption Hook (V2 — multi-token)
 *
 * Provides private client-side decryption of encrypted FHE balances,
 * keyed by token address (address(0) = native ETH).
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
import { useAccount, usePublicClient } from "wagmi";
import { useContractAddresses } from "@/lib/wagmi";
import { NoctisVaultABI } from "@/lib/contracts/abi";
import { useFhevm } from "./useFhevm";
import type { TokenInfo } from "./useTokenRegistry";

// LocalStorage keys for caching
// NOTE: Keys include vault address to invalidate cache on contract upgrade
const BALANCE_CACHE_KEY = "noctis_decrypted_balances_v3";
const HANDLE_CACHE_KEY = "noctis_decrypted_handles_v3";

export interface DecryptedBalance {
  value: bigint;
  formatted: string;
  decimals: number;
}

/** token address (lowercase) → decrypted balance */
type BalanceMap = Record<string, DecryptedBalance | null>;

interface DecryptionState {
  balances: BalanceMap;
  isDecrypting: boolean;
  /** Token address currently being decrypted (lowercase) */
  decryptingToken: string | null;
  isSyncing: boolean; // Gateway is syncing new ciphertext
  isNewDeposit: boolean; // New deposit detected, waiting for indexation
  error: string | null;
  retryCount: number;
}

interface UseBalanceDecryptionReturn {
  decrypted: DecryptionState;
  /** Decrypt a token's vault balance client-side */
  decryptBalance: (token: TokenInfo) => Promise<void>;
  /** Decrypted balance for a token address, or null */
  balanceFor: (tokenAddress: string | undefined | null) => DecryptedBalance | null;
  clearDecrypted: () => void;
  canDecrypt: boolean;
}

function cacheKey(prefix: string, vault: string, user: string): string {
  return `${prefix}_${vault.toLowerCase()}_${user.toLowerCase()}`;
}

// Load cached balances from localStorage (values persisted as strings)
function loadCachedBalances(address: string, vaultAddress: string): BalanceMap {
  if (typeof window === "undefined") return {};
  try {
    const cached = localStorage.getItem(cacheKey(BALANCE_CACHE_KEY, vaultAddress, address));
    if (!cached) return {};
    const parsed = JSON.parse(cached) as Record<
      string,
      { value: string; formatted: string; decimals: number } | null
    >;
    const result: BalanceMap = {};
    for (const [token, entry] of Object.entries(parsed)) {
      result[token] = entry ? { ...entry, value: BigInt(entry.value) } : null;
    }
    return result;
  } catch (e) {
    console.warn("Failed to load cached balances:", e);
    return {};
  }
}

function saveCachedBalances(address: string, vaultAddress: string, balances: BalanceMap) {
  if (typeof window === "undefined") return;
  try {
    const toSave: Record<string, { value: string; formatted: string; decimals: number } | null> = {};
    for (const [token, entry] of Object.entries(balances)) {
      toSave[token] = entry ? { ...entry, value: entry.value.toString() } : null;
    }
    localStorage.setItem(
      cacheKey(BALANCE_CACHE_KEY, vaultAddress, address),
      JSON.stringify(toSave)
    );
  } catch (e) {
    console.warn("Failed to save cached balances:", e);
  }
}

// Cache the last successfully decrypted handle (per token address)
function saveCachedHandle(address: string, vaultAddress: string, token: string, handle: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      `${cacheKey(HANDLE_CACHE_KEY, vaultAddress, address)}_${token.toLowerCase()}`,
      handle
    );
  } catch (e) {
    console.warn("Failed to save cached handle:", e);
  }
}

function getCachedHandle(address: string, vaultAddress: string, token: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(
      `${cacheKey(HANDLE_CACHE_KEY, vaultAddress, address)}_${token.toLowerCase()}`
    );
  } catch {
    return null;
  }
}

// Check if the handle has changed (new deposit/transaction)
function hasHandleChanged(
  address: string,
  vaultAddress: string,
  token: string,
  currentHandle: string
): boolean {
  const cachedHandle = getCachedHandle(address, vaultAddress, token);
  if (!cachedHandle) return false; // No previous handle, first time
  return cachedHandle !== currentHandle;
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

const EMPTY_STATE: DecryptionState = {
  balances: {},
  isDecrypting: false,
  decryptingToken: null,
  isSyncing: false,
  isNewDeposit: false,
  error: null,
  retryCount: 0,
};

export function useBalanceDecryption(): UseBalanceDecryptionReturn {
  const { address, isConnected } = useAccount();
  const contracts = useContractAddresses();
  const publicClient = usePublicClient();
  const { reencrypt, isReady: isFhevmReady } = useFhevm();

  const [state, setState] = useState<DecryptionState>(EMPTY_STATE);

  // Max retries for sync / ACL indexation errors
  const MAX_SYNC_RETRIES = 4;
  const SYNC_RETRY_DELAY = 8000; // 8 seconds — ZAMA ACL often needs a short wait after balance writes

  // Load cached balances on mount
  useEffect(() => {
    if (address && contracts?.vaultAddress) {
      const cached = loadCachedBalances(address, contracts.vaultAddress);
      if (Object.keys(cached).length > 0) {
        console.log("📦 Loaded cached balances from localStorage");
        setState((prev) => ({
          ...prev,
          balances: { ...cached, ...prev.balances },
        }));
      }
    }
  }, [address, contracts?.vaultAddress]);

  // Decrypt balance for a specific token
  const decryptBalance = useCallback(
    async (token: TokenInfo) => {
      if (!address || !contracts?.vaultAddress || !isConnected) {
        setState((prev) => ({ ...prev, error: "Wallet not connected" }));
        return;
      }

      if (!isFhevmReady) {
        setState((prev) => ({ ...prev, error: "FHE library not ready" }));
        return;
      }

      const tokenKey = token.address.toLowerCase();

      setState((prev) => ({
        ...prev,
        isDecrypting: true,
        decryptingToken: tokenKey,
        error: null,
      }));

      // Fetch handle via server (FHE-capable RPC). Browser RPCs often return a
      // new ephemeral FHE.asEuint128(0) handle each call — those have no ACL.
      let rawHandle: string | undefined;
      try {
        // PRIVACY: POST body — never put the user address in a query string
        // (it would land in access logs / proxies)
        const res = await fetch("/api/fhevm/balance-handle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user: address, token: token.address }),
        });
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
            decryptingToken: null,
            error: `No ${token.symbol} vault balance — deposit ${token.symbol} first`,
          }));
          return;
        }
        rawHandle = data.handle as string;
        console.log(`📡 Server balance handle: ${rawHandle}`);
      } catch (e) {
        console.warn("Server handle fetch failed, falling back to direct read:", e);
        try {
          rawHandle = (await publicClient?.readContract({
            address: contracts.vaultAddress as `0x${string}`,
            abi: NoctisVaultABI,
            functionName: "getEncryptedBalance",
            args: [address, token.address],
          })) as string | undefined;
        } catch {
          rawHandle = undefined;
        }
      }

      if (!rawHandle || rawHandle === "0x0000000000000000000000000000000000000000000000000000000000000000") {
        setState((prev) => ({
          ...prev,
          isDecrypting: false,
          decryptingToken: null,
          error: `No ${token.symbol} balance to decrypt (deposit first)`,
        }));
        return;
      }

      // Convert bytes32 hex string to bigint for the reencrypt function
      const handle = BigInt(rawHandle as string);

      // Use the raw hex for handle comparison/caching
      const handleHex = rawHandle as string;

      // Check if this is a new handle (new deposit/transaction)
      const isNewHandle = hasHandleChanged(address, contracts.vaultAddress, tokenKey, handleHex);
      if (isNewHandle) {
        console.log(`🆕 New ${token.symbol} balance handle — waiting briefly for ZAMA ACL index...`);
        await new Promise((r) => setTimeout(r, 3000));
      }

      try {
        console.log(`Decrypting ${token.symbol} balance...`);

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

        const decimals = token.decimals;
        const divisor = 10n ** BigInt(decimals);

        // UNDERFLOW DETECTION: Values close to 2^128 indicate an underflow
        // (pending withdrawals exceeding the actual balance). Heuristic cap:
        // 10^(decimals + 6) base units, i.e. 1 million whole tokens.
        const maxReasonableBalance = 10n ** BigInt(decimals + 6);
        const isUnderflow = cleartext > maxReasonableBalance;

        // Format the balance (or show 0 if underflow)
        const safeValue = isUnderflow ? 0n : cleartext;
        const integerPart = safeValue / divisor;
        const fractionalPart = safeValue % divisor;
        const fractionalStr = fractionalPart.toString().padStart(decimals, "0");
        // Match desk trade / wallet formatting (18-dec tokens 4 dp, stablecoins 2 dp)
        const displayDecimals = decimals >= 18 ? 4 : Math.min(decimals, 2);
        const trimmedFractional = fractionalStr.slice(0, displayDecimals);

        const formatted = isUnderflow
          ? "0.00 (pending)" // Show pending indicator for underflow
          : `${integerPart}.${trimmedFractional}`;

        if (isUnderflow) {
          console.warn(`⚠️ ${token.symbol} balance underflow detected - showing 0 (cancel pending withdrawals to restore)`);
        }

        const decryptedBalance: DecryptedBalance = {
          value: cleartext,
          formatted,
          decimals,
        };

        setState((prev) => {
          const newBalances = { ...prev.balances, [tokenKey]: decryptedBalance };

          // Save to localStorage for persistence across page refreshes
          if (address && contracts.vaultAddress) {
            saveCachedBalances(address, contracts.vaultAddress, newBalances);
            saveCachedHandle(address, contracts.vaultAddress, tokenKey, handleHex);
            console.log("💾 Saved decrypted balance and handle to cache");
          }

          return {
            ...prev,
            balances: newBalances,
            isDecrypting: false,
            decryptingToken: null,
            isSyncing: false,
            isNewDeposit: false,
            error: null,
            retryCount: 0,
          };
        });

        console.log(`✅ ${token.symbol} balance decrypted: ${formatted}`);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Decryption failed";
        console.error(`Decryption failed for ${token.symbol}:`, err);

        // ACL not indexed yet, or stale handle after a swap debit — retry with fresh handle
        const isSyncError = isAclOrSyncError(errorMessage);

        if (isSyncError && state.retryCount < MAX_SYNC_RETRIES) {
          console.log(`🔄 ACL/gateway syncing... retry in ${SYNC_RETRY_DELAY / 1000}s (attempt ${state.retryCount + 1}/${MAX_SYNC_RETRIES})`);

          setState((prev) => ({
            ...prev,
            isDecrypting: false,
            decryptingToken: null,
            isSyncing: true,
            isNewDeposit: isNewHandle,
            error: null,
            retryCount: prev.retryCount + 1,
          }));

          setTimeout(() => {
            console.log(`🔄 Retrying decryption for ${token.symbol}...`);
            decryptBalance(token);
          }, SYNC_RETRY_DELAY);
        } else if (isSyncError) {
          console.log(`⏳ ACL still syncing after ${MAX_SYNC_RETRIES} retries.`);
          setState((prev) => ({
            ...prev,
            isDecrypting: false,
            decryptingToken: null,
            isSyncing: false,
            isNewDeposit: isNewHandle,
            error:
              `Cannot decrypt this ${token.symbol} balance yet. Wait ~15s after deposit then retry.`,
            retryCount: 0,
          }));
        } else {
          setState((prev) => ({
            ...prev,
            isDecrypting: false,
            decryptingToken: null,
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
      publicClient,
      reencrypt,
      state.retryCount,
    ]
  );

  const balanceFor = useCallback(
    (tokenAddress: string | undefined | null): DecryptedBalance | null => {
      if (!tokenAddress) return null;
      return state.balances[tokenAddress.toLowerCase()] ?? null;
    },
    [state.balances]
  );

  // Clear decrypted balances (on modal close)
  const clearDecrypted = useCallback(() => {
    setState(EMPTY_STATE);
  }, []);

  const canDecrypt = isConnected && isFhevmReady && !!contracts?.vaultAddress;

  return {
    decrypted: state,
    decryptBalance,
    balanceFor,
    clearDecrypted,
    canDecrypt,
  };
}
