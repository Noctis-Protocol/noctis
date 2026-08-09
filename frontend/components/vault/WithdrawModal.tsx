"use client";

/**
 * WithdrawModal Component (V2 — multi-token)
 *
 * Request a withdrawal for any vault-registered token. The amount AND the
 * payout destination are encrypted client-side (stealth exits): an optional
 * private destination address is revealed on-chain only when the payout
 * executes, so funds can land on a fresh address with no prior link.
 */

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ArrowRight, Lock, CheckCircle, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TokenSelector } from "@/components/ui/TokenSelector";
import { cn, isValidAmountInput } from "@/lib/utils";
import { useNoctisVault } from "@/hooks/useNoctisVault";
import { useTokenRegistry, useTokenLimits } from "@/hooks/useTokenRegistry";
import type { TokenInfo } from "@/hooks/useTokenRegistry";

interface WithdrawModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WithdrawModal({ open, onOpenChange }: WithdrawModalProps) {
  const { supportedTokens, isLoading: registryLoading } = useTokenRegistry();
  const [selected, setSelected] = useState<TokenInfo | null>(null);
  const [amount, setAmount] = useState("");
  const [requestId, setRequestId] = useState<bigint | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [stealthMode, setStealthMode] = useState(false);
  const [stealthRecipient, setStealthRecipient] = useState("");

  const token = selected ?? supportedTokens[0] ?? null;
  const limits = useTokenLimits(token);

  const { requestWithdrawal, isLoading, error } = useNoctisVault({
    onWithdrawalSuccess: () => {
      console.log("Withdrawal request succeeded");
    }
  });

  const handleWithdraw = async () => {
    if (!token || !amount || parseFloat(amount) <= 0) return;

    // Reset previous success state
    setShowSuccess(false);
    setRequestId(null);

    // Year 2 stealth exit: optional private destination, encrypted client-side
    const recipient = stealthMode && stealthRecipient ? stealthRecipient : undefined;
    const newRequestId = await requestWithdrawal(token, amount, recipient);

    if (newRequestId !== null) {
      // Success!
      setRequestId(newRequestId);
      setShowSuccess(true);

      // Reset form after showing success message
      setTimeout(() => {
        setAmount("");
        setStealthRecipient("");
        setStealthMode(false);
        setShowSuccess(false);
        onOpenChange(false);
      }, 3000);
    }
  };

  const invalidStealthRecipient =
    stealthMode &&
    Boolean(stealthRecipient) &&
    !/^0x[a-fA-F0-9]{40}$/.test(stealthRecipient);

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isValidAmountInput(e.target.value)) {
      setAmount(e.target.value);
    }
  };

  const exceedsCap =
    limits.maxWithdrawal !== undefined &&
    limits.maxWithdrawal > 0 &&
    Boolean(amount) &&
    parseFloat(amount) > limits.maxWithdrawal;

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
              Withdraw from Vault
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>

          {/* Token selection (dynamic registry) */}
          <div className="mb-6">
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
              ariaLabel="Select withdrawal token"
            />
          </div>

          {/* Amount input */}
          <div className="space-y-2 mb-6">
            <label className="text-sm font-medium">Amount</label>
            <div className="relative">
              <Input
                type="text"
                inputMode="decimal"
                placeholder="0.0"
                value={amount}
                onChange={handleAmountChange}
                className={cn("pr-16 text-lg", exceedsCap && "border-red-500")}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                {token?.symbol ?? ""}
              </span>
            </div>
            {exceedsCap && token && (
              <p className="text-xs text-red-500">
                Exceeds the per-request cap ({limits.maxWithdrawal} {token.symbol})
              </p>
            )}
          </div>

          {/* Stealth exit (Year 2): optional private destination */}
          <div className="space-y-2 mb-6">
            <button
              type="button"
              onClick={() => setStealthMode((v) => !v)}
              className="flex items-center gap-2 text-sm font-medium text-brand-700 hover:text-brand-900"
            >
              <EyeOff className="h-4 w-4" />
              Private destination {stealthMode ? "(on)" : "(off)"}
            </button>
            {stealthMode && (
              <>
                <Input
                  type="text"
                  placeholder="0x… fresh address (revealed only at payout)"
                  value={stealthRecipient}
                  onChange={(e) => setStealthRecipient(e.target.value.trim())}
                  className={cn("text-sm font-mono", invalidStealthRecipient && "border-red-500")}
                />
                {invalidStealthRecipient && (
                  <p className="text-xs text-red-500">Invalid address</p>
                )}
                <p className="text-xs text-muted-foreground">
                  The destination is encrypted in your browser and stays hidden
                  on-chain until the payout executes. ETH is pushed directly —
                  the fresh address needs no gas to receive it.
                </p>
              </>
            )}
          </div>

          {/* Privacy info */}
          <div className="flex items-start gap-3 p-3 rounded-xl bg-brand-50 mb-6 text-sm">
            <Lock className="h-4 w-4 text-brand-600 mt-0.5" />
            <div>
              <p className="font-medium text-brand-900">Private Withdrawal</p>
              <p className="text-brand-600 mt-0.5">
                Amount and destination are encrypted client-side. The keeper pays
                out automatically at the next batch window — your wallet never
                signs the payout, so funds land on{" "}
                {stealthMode && stealthRecipient ? "your private destination" : "your wallet"}{" "}
                with no on-chain link
                {token?.isNative && !(stealthMode && stealthRecipient) ? " (ETH goes to Ready to claim)" : ""}.
              </p>
            </div>
          </div>

          {/* Success message */}
          {showSuccess && requestId && (
            <div className="flex items-start gap-3 p-3 rounded-xl bg-green-50 mb-4 text-sm">
              <CheckCircle className="h-4 w-4 text-green-600 mt-0.5" />
              <div>
                <p className="font-medium text-green-900">Withdrawal Request Submitted!</p>
                <p className="text-green-600 mt-0.5">
                  The keeper will pay it out automatically at the next batch
                  window. You can also execute it manually from the Activity panel.
                </p>
              </div>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="flex items-start gap-3 p-3 rounded-xl bg-red-50 mb-4 text-sm">
              <X className="h-4 w-4 text-red-600 mt-0.5" />
              <div>
                <p className="font-medium text-red-900">Error</p>
                <p className="text-red-600 mt-0.5">{error}</p>
              </div>
            </div>
          )}

          {/* Submit */}
          <Button
            variant="gradient"
            size="lg"
            className="w-full"
            disabled={
              !token || !amount || parseFloat(amount) <= 0 || exceedsCap ||
              invalidStealthRecipient || (stealthMode && !stealthRecipient) || isLoading
            }
            loading={isLoading}
            onClick={handleWithdraw}
          >
            {isLoading ? "Processing..." : `Withdraw ${token?.symbol ?? ""}`}
            {!isLoading && <ArrowRight className="ml-2 h-4 w-4" />}
          </Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
