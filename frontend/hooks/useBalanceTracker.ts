/**
 * useBalanceTracker Hook
 * 
 * Tracks deposits, withdrawals, and trades locally (localStorage)
 * to provide estimated balances without on-chain decryption.
 * 
 * Privacy-preserving: No on-chain revelations, all calculations local.
 * 
 * Uses custom events to synchronize state across all hook instances,
 * so balance updates in one component reflect in all others.
 */

"use client";

import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import { useAccount } from "wagmi";

export interface BalanceTransaction {
  type: "deposit" | "withdrawal" | "trade";
  /** Token symbol (multi-token V2: any registered symbol, e.g. "ETH", "USDC") */
  token: string;
  amount: number; // Amount in human-readable format (e.g., 0.01 for ETH)
  timestamp: number;
  txHash?: string;
}

interface BalanceTrackerData {
  [address: string]: {
    transactions: BalanceTransaction[];
    lastUpdated: number;
  };
}

interface UseBalanceTrackerReturn {
  // Estimated balances (legacy shortcuts)
  estimatedETH: number;
  estimatedUSDT: number;
  /** Estimated local balance for any token symbol */
  estimatedFor: (symbol: string) => number;
  // Add transaction
  addTransaction: (tx: BalanceTransaction) => void;
  // Transaction history
  transactions: BalanceTransaction[];
  // Clear history
  clearHistory: () => void;
}

const STORAGE_KEY = "noctis_balance_tracker";

// Global version counter for triggering re-renders across all hook instances
let globalVersion = 0;
const listeners = new Set<() => void>();

function notifyListeners() {
  globalVersion++;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getClientSnapshot() {
  return globalVersion;
}

// Server snapshot - always return 0 to avoid hydration mismatch
function getServerSnapshot() {
  return 0;
}

// Helper to read from localStorage (client-only)
function getStoredData(): BalanceTrackerData {
  if (typeof window === "undefined") return {};
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

export function useBalanceTracker(): UseBalanceTrackerReturn {
  const { address } = useAccount();
  
  // Track if we're mounted (client-side)
  const [isMounted, setIsMounted] = useState(false);
  
  useEffect(() => {
    setIsMounted(true);
  }, []);
  
  // Subscribe to global version changes to trigger re-renders across components
  // Use different snapshots for client/server to avoid hydration issues
  const version = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
  
  const [transactions, setTransactions] = useState<BalanceTransaction[]>([]);

  // Load transactions from localStorage on mount and when version changes
  // Only runs on client after mount to avoid hydration issues
  useEffect(() => {
    if (!isMounted) return;
    
    if (!address) {
      setTransactions([]);
      return;
    }

    const data = getStoredData();
    const userData = data[address.toLowerCase()];
    if (userData) {
      setTransactions(userData.transactions);
    } else {
      setTransactions([]);
    }
  }, [address, version, isMounted]); // Re-run when version changes or mount state

  // Save transactions to localStorage and notify all listeners
  const saveTransactions = useCallback((txs: BalanceTransaction[]) => {
    if (!address) return;

    try {
      const data = getStoredData();
      
      data[address.toLowerCase()] = {
        transactions: txs,
        lastUpdated: Date.now(),
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      
      // Notify all hook instances to re-read from storage
      notifyListeners();
    } catch (err) {
      console.error("Failed to save balance tracker:", err);
    }
  }, [address]);

  // Add a new transaction
  const addTransaction = useCallback((tx: BalanceTransaction) => {
    if (!address) return;
    
    // Read current state from storage to avoid race conditions
    const data = getStoredData();
    const userData = data[address.toLowerCase()];
    const currentTxs = userData?.transactions || [];
    
    const newTxs = [...currentTxs, tx];
    saveTransactions(newTxs);
    console.log("📊 Balance tracker: Added transaction", tx);
  }, [address, saveTransactions]);

  // Clear history
  const clearHistory = useCallback(() => {
    saveTransactions([]);
  }, [saveTransactions]);

  // Calculate estimated balance for a token symbol
  const estimatedFor = useCallback(
    (symbol: string) =>
      transactions.reduce((acc, tx) => {
        if (tx.token !== symbol) return acc;
        switch (tx.type) {
          case "deposit":
            return acc + tx.amount;
          case "withdrawal":
            return acc - tx.amount;
          case "trade":
            // Trade amount can be positive (received) or negative (sent)
            return acc + tx.amount;
          default:
            return acc;
        }
      }, 0),
    [transactions]
  );

  return {
    estimatedETH: estimatedFor("ETH"),
    estimatedUSDT: estimatedFor("USDC"),
    estimatedFor,
    addTransaction,
    transactions,
    clearHistory,
  };
}
