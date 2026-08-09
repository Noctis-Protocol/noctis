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
import {
  useTokenRegistry,
  useTokenLimits,
  parseTokenAmount,
  formatTokenAmount,
} from "@/hooks/useTokenRegistry";
import type { TokenInfo } from "@/hooks/useTokenRegistry";

/** PRIVACY (V2.5, shredding): max parallel requests the vault accepts */
const MAX_SHRED_TRANCHES = 8;

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

  // PRIVACY (V2.5, shredding): one recipient per line — the withdrawal is
  // split into equal tranches, one request per stealth address. Payouts land
  // as k separate keeper transactions: linking them back to one logical
  // withdrawal becomes a subset-sum problem for the observer.
  const stealthRecipients = stealthRecipient
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const handleWithdraw = async () => {
    if (!token || !amount || parseFloat(amount) <= 0) return;

    // Reset previous success state
    setShowSuccess(false);
    setRequestId(null);

    let lastId: bigint | null = null;

    if (stealthMode && stealthRecipients.length > 1) {
      // Shredding: split the raw amount into equal tranches (remainder on the
      // first) and issue one encrypted request per recipient
      const total = parseTokenAmount(amount, token.decimals);
      const n = BigInt(stealthRecipients.length);
      const base = total / n;
      for (let i = 0; i < stealthRecipients.length; i++) {
        const tranche = i === 0 ? base + (total % n) : base;
        const trancheStr = formatTokenAmount(tranche, token.decimals, token.decimals);
        const id = await requestWithdrawal(token, trancheStr, stealthRecipients[i]);
        if (id === null) return; // error surfaced by the hook; stop the batch
        lastId = id;
      }
    } else {
      // Year 2 stealth exit: optional private destination, encrypted client-side
      const recipient = stealthMode && stealthRecipients[0] ? stealthRecipients[0] : undefined;
      lastId = await requestWithdrawal(token, amount, recipient);
    }

    if (lastId !== null) {
      // Success!
      setRequestId(lastId);
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
    stealthRecipients.length > 0 &&
    (stealthRecipients.some((r) => !/^0x[a-fA-F0-9]{40}$/.test(r)) ||
      stealthRecipients.length > MAX_SHRED_TRANCHES);

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
                <textarea
                  placeholder={"0x… fresh address (revealed only at payout)\n0x… add more lines to SHRED the withdrawal"}
                  value={stealthRecipient}
                  onChange={(e) => setStealthRecipient(e.target.value)}
                  rows={Math.min(Math.max(stealthRecipients.length + 1, 2), 5)}
                  className={cn(
                    "w-full rounded-md border border-input bg-background px-3 py-2",
                    "text-sm font-mono placeholder:text-muted-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    invalidStealthRecipient && "border-red-500"
                  )}
                />
                {invalidStealthRecipient && (
                  <p className="text-xs text-red-500">
                    {stealthRecipients.length > MAX_SHRED_TRANCHES
                      ? `Max ${MAX_SHRED_TRANCHES} recipients (pending-request cap)`
                      : "Invalid address in the list"}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Destinations are encrypted in your browser and stay hidden
                  on-chain until each payout executes.{" "}
                  {stealthRecipients.length > 1
                    ? `Shredding: the amount is split into ${stealthRecipients.length} equal tranches, one per address — an observer faces a subset-sum puzzle instead of one matching payout.`
                    : "Add more lines to shred the withdrawal across several fresh addresses."}
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
              invalidStealthRecipient || (stealthMode && stealthRecipients.length === 0) || isLoading
            }
            loading={isLoading}
            onClick={handleWithdraw}
          >
            {isLoading
              ? "Processing..."
              : stealthMode && stealthRecipients.length > 1
                ? `Shred into ${stealthRecipients.length} withdrawals`
                : `Withdraw ${token?.symbol ?? ""}`}
            {!isLoading && <ArrowRight className="ml-2 h-4 w-4" />}
          </Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
