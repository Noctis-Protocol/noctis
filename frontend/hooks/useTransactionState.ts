/**
 * useTransactionState Hook
 * 
 * Manages transaction lifecycle with clear state transitions.
 * Follows "overcommunicate pending states" best practice.
 * 
 * States: idle → pending → confirming → success/failed
 */

import { useState, useCallback } from "react";
import { toast } from "sonner";

export type TransactionStatus = 
  | "idle" 
  | "pending"      // Waiting for wallet signature
  | "confirming"   // Transaction submitted, waiting for confirmation
  | "success" 
  | "failed";

interface TransactionState {
  status: TransactionStatus;
  hash?: `0x${string}`;
  error?: string;
  step?: number;
  totalSteps?: number;
}

interface UseTransactionStateReturn {
  state: TransactionState;
  // State setters
  setIdle: () => void;
  setPending: (step?: number, totalSteps?: number, customMessage?: string, description?: string) => void;
  setConfirming: (hash: `0x${string}`) => void;
  setSuccess: (message?: string) => void;
  setFailed: (error: string) => void;
  // Helpers
  isLoading: boolean;
  reset: () => void;
}

export function useTransactionState(): UseTransactionStateReturn {
  const [state, setState] = useState<TransactionState>({
    status: "idle",
  });

  const setIdle = useCallback(() => {
    setState({ status: "idle" });
  }, []);

  const setPending = useCallback((step?: number, totalSteps?: number, customMessage?: string, description?: string) => {
    setState({ status: "pending", step, totalSteps });
    const message = customMessage 
      ? (step && totalSteps ? `Step ${step} of ${totalSteps}: ${customMessage}` : customMessage)
      : (step && totalSteps ? `Step ${step} of ${totalSteps}: Waiting for wallet...` : "Waiting for wallet confirmation...");
    toast.loading(message, { 
      id: "tx-pending",
      description: description,
      duration: Infinity, // Keep visible until dismissed
    });
  }, []);

  const setConfirming = useCallback((hash: `0x${string}`) => {
    setState({ status: "confirming", hash });
    toast.loading("Transaction submitted. Confirming...", { 
      id: "tx-pending",
      description: `Hash: ${hash.slice(0, 10)}...`,
    });
  }, []);

  const setSuccess = useCallback((message = "Transaction confirmed!") => {
    setState((prev) => ({ ...prev, status: "success" }));
    toast.success(message, { id: "tx-pending" });
  }, []);

  const setFailed = useCallback((error: string) => {
    setState({ status: "failed", error });
    toast.error("Transaction failed", { 
      id: "tx-pending",
      description: error,
    });
  }, []);

  const reset = useCallback(() => {
    setState({ status: "idle" });
    toast.dismiss("tx-pending");
  }, []);

  return {
    state,
    setIdle,
    setPending,
    setConfirming,
    setSuccess,
    setFailed,
    isLoading: state.status === "pending" || state.status === "confirming",
    reset,
  };
}
