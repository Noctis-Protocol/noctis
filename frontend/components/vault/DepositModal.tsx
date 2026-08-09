"use client";

/**
 * DepositModal Component (V2 — multi-token)
 *
 * Deposit any vault-registered token: native ETH (depositETH) or
 * ERC-20 (approve + depositToken). Token list comes from the on-chain
 * registry; limits from tokenConfigs.
 */

import { useState, useEffect, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ArrowRight, AlertCircle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TokenSelector } from "@/components/ui/TokenSelector";
import {
  useNoctisVault,
  useVaultBalances,
  useBalanceTracker,
  useTokenRegistry,
  useTokenLimits,
  parseTokenAmount,
} from "@/hooks";
import type { TokenInfo } from "@/hooks";
import { cn, isValidAmountInput } from "@/lib/utils";
import { validateAmountWithLimits, quickAmountsFor } from "@/lib/validation";

interface DepositModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DepositModal({ open, onOpenChange }: DepositModalProps) {
  const { supportedTokens, isLoading: registryLoading } = useTokenRegistry();
  const [selected, setSelected] = useState<TokenInfo | null>(null);
  const [amount, setAmount] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  // Default to the first supported token (native ETH sorts first)
  const token = selected ?? supportedTokens[0] ?? null;
  const limits = useTokenLimits(token);

  // Get refetchBalances from vault balances hook
  const { refetchBalances } = useVaultBalances();

  // Get balance tracker
  const { addTransaction } = useBalanceTracker();

  // Pass callbacks to refresh balances and track deposits
  const { depositETH, depositToken, isLoading, error: transactionError } = useNoctisVault({
    onDepositSuccess: refetchBalances,
    onDepositTracked: (depositAmount, depositTokenSymbol, txHash) => {
      addTransaction({
        type: "deposit",
        token: depositTokenSymbol,
        amount: depositAmount,
        timestamp: Date.now(),
        txHash,
      });
    },
  });

  const quickAmounts = useMemo(
    () => (token ? quickAmountsFor(token.symbol) : []),
    [token]
  );

  // Real-time validation against on-chain limits
  useEffect(() => {
    if (amount && token) {
      const result = validateAmountWithLimits(
        amount,
        token.symbol,
        limits.minDeposit,
        limits.maxDeposit
      );
      setValidationError(result.error || null);
    } else {
      setValidationError(null);
    }
  }, [amount, token, limits.minDeposit, limits.maxDeposit]);

  const handleDeposit = async () => {
    if (!token || !amount || parseFloat(amount) <= 0 || validationError) return;

    let success = false;

    try {
      if (token.isNative) {
        success = await depositETH(amount);
      } else {
        const amountBigInt = parseTokenAmount(amount, token.decimals);
        success = await depositToken(token, amountBigInt);
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

          {/* Token selection (dynamic registry) */}
          <div className="mb-4">
            <label className="text-xs text-muted-foreground mb-2 block">
              Token
            </label>
            <TokenSelector
              tokens={supportedTokens}
              selected={token}
              onSelect={(t) => {
                setSelected(t);
                setAmount("");
              }}
              disabled={registryLoading}
              ariaLabel="Select deposit token"
            />
          </div>

          {/* Quick amounts */}
          {quickAmounts.length > 0 && (
            <div className="mb-4">
              <label className="text-xs text-muted-foreground mb-2 block">
                Quick amounts
              </label>
              <div className="flex gap-2">
                {quickAmounts.map((quickAmount) => (
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
          )}

          {/* Amount input */}
          <div className="space-y-2 mb-6">
            <label className="text-sm font-medium">Amount</label>
            <div className="relative">
              <Input
                type="text"
                inputMode="decimal"
                placeholder={
                  limits.minDeposit !== undefined && token
                    ? `Min: ${limits.minDeposit} ${token.symbol}`
                    : "0.0"
                }
                value={amount}
                onChange={handleAmountChange}
                className={cn(
                  "pr-16 text-lg",
                  validationError && "border-red-500 focus-visible:ring-red-500"
                )}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                {token?.symbol ?? ""}
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

            {/* Helper text (on-chain limits) */}
            {token && limits.minDeposit !== undefined && (
              <p className="text-xs text-muted-foreground">
                Limits: {limits.minDeposit} –{" "}
                {limits.maxDeposit?.toLocaleString() ?? "∞"} {token.symbol}
              </p>
            )}
          </div>

          {/* Info */}
          <div className="p-3 rounded-xl bg-muted mb-4 text-sm text-muted-foreground">
            <p>
              Your deposit will be encrypted using FHE. Only you can view your balance.
              {token && !token.isNative && " ERC-20 deposits need an approval transaction first."}
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
            disabled={!token || !amount || !!validationError || isLoading}
            loading={isLoading}
            onClick={handleDeposit}
          >
            {isLoading ? "Depositing..." : `Deposit ${token?.symbol ?? ""}`}
            {!isLoading && <ArrowRight className="ml-2 h-4 w-4" />}
          </Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
