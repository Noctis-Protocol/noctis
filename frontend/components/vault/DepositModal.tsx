"use client";

/**
 * DepositModal Component
 * 
 * Modal for depositing ETH or USDC into the vault.
 * Shows step progress for multi-step transactions.
 */

import { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ArrowRight, AlertCircle, CheckCircle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNoctisVault, useVaultBalances, useBalanceTracker } from "@/hooks";
import { cn, isValidAmountInput } from "@/lib/utils";
import { DEPOSIT_LIMITS, validateDepositAmount } from "@/lib/validation";

interface DepositModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type DepositToken = "ETH" | "USDC";

export function DepositModal({ open, onOpenChange }: DepositModalProps) {
  const [token, setToken] = useState<DepositToken>("ETH");
  const [amount, setAmount] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  
  // Get refetchBalances from vault balances hook
  const { refetchBalances } = useVaultBalances();
  
  // Get balance tracker
  const { addTransaction } = useBalanceTracker();
  
  // Pass callbacks to refresh balances and track deposits
  const { depositETH, depositUSDT, isLoading, error: transactionError } = useNoctisVault({
    onDepositSuccess: refetchBalances,
    onDepositTracked: (depositAmount, depositToken, txHash) => {
      addTransaction({
        type: "deposit",
        token: depositToken as "ETH" | "USDC",
        amount: depositAmount,
        timestamp: Date.now(),
        txHash,
      });
    },
  });

  // Real-time validation
  useEffect(() => {
    if (amount) {
      const result = validateDepositAmount(amount, token);
      setValidationError(result.error || null);
    } else {
      setValidationError(null);
    }
  }, [amount, token]);

  const handleDeposit = async () => {
    if (!amount || parseFloat(amount) <= 0 || validationError) return;

    let success = false;
    
    try {
      if (token === "ETH") {
        success = await depositETH(amount);
      } else {
        // Convert USDC amount to 6 decimals
        const amountBigInt = BigInt(Math.floor(parseFloat(amount) * 1e6));
        success = await depositUSDT(amountBigInt);
      }

      // Only reset and close on confirmed success
      if (success) {
        setAmount("");
        onOpenChange(false);
      }
      // On failure, modal stays open with error displayed
    } catch {
      // Unexpected error - modal stays open
      // Error is already handled in the hook via setFailed()
    }
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isValidAmountInput(e.target.value)) {
      setAmount(e.target.value);
    }
  };

  const handleQuickAmount = (quickAmount: number) => {
    setAmount(quickAmount.toString());
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
            "w-full max-w-md p-6 rounded-2xl bg-white shadow-xl z-50",
            "focus:outline-none"
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <Dialog.Title className="text-lg font-semibold">
              Deposit to Vault
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>

          {/* Token selection */}
          <div className="flex gap-2 mb-4">
            {(["ETH", "USDC"] as DepositToken[]).map((t) => (
              <Button
                key={t}
                variant={token === t ? "default" : "outline"}
                className="flex-1"
                onClick={() => setToken(t)}
              >
                {t}
              </Button>
            ))}
          </div>

          {/* Quick amounts */}
          <div className="mb-4">
            <label className="text-xs text-muted-foreground mb-2 block">
              Quick amounts
            </label>
            <div className="flex gap-2">
              {DEPOSIT_LIMITS[token].QUICK_AMOUNTS.map((quickAmount) => (
                <Button
                  key={quickAmount}
                  variant="outline"
                  size="sm"
                  onClick={() => handleQuickAmount(quickAmount)}
                  className="flex-1 text-xs"
                >
                  {quickAmount}
                </Button>
              ))}
            </div>
          </div>

          {/* Amount input */}
          <div className="space-y-2 mb-6">
            <label className="text-sm font-medium">Amount</label>
            <div className="relative">
              <Input
                type="text"
                inputMode="decimal"
                placeholder={`Min: ${DEPOSIT_LIMITS[token].MIN} ${token}`}
                value={amount}
                onChange={handleAmountChange}
                className={cn(
                  "pr-16 text-lg",
                  validationError && "border-red-500 focus-visible:ring-red-500"
                )}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                {token}
              </span>
            </div>
            
            {/* Validation feedback */}
            {validationError ? (
              <p className="text-xs text-red-500 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {validationError}
              </p>
            ) : amount && (
              <p className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle className="h-3 w-3" />
                Valid amount
              </p>
            )}
            
            {/* Helper text */}
            <p className="text-xs text-muted-foreground">
              Limits: {DEPOSIT_LIMITS[token].MIN} - {DEPOSIT_LIMITS[token].MAX.toLocaleString()} {token}
            </p>
          </div>

          {/* Info */}
          <div className="p-3 rounded-xl bg-muted mb-4 text-sm text-muted-foreground">
            <p>
              Your deposit will be encrypted using FHE. Only you can view your balance.
            </p>
          </div>

          {/* Transaction error */}
          {transactionError && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 mb-4 text-sm text-red-700 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <p>{transactionError}</p>
            </div>
          )}

          {/* Submit */}
          <Button
            variant="gradient"
            size="lg"
            className="w-full"
            disabled={!amount || !!validationError || isLoading}
            loading={isLoading}
            onClick={handleDeposit}
          >
            {isLoading ? "Depositing..." : `Deposit ${token}`}
            {!isLoading && <ArrowRight className="ml-2 h-4 w-4" />}
          </Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
