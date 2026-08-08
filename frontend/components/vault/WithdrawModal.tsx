"use client";

/**
 * WithdrawModal Component
 * 
 * Modal for withdrawing ETH or USDC from the vault.
 * Withdrawal destination and amount are encrypted.
 */

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ArrowRight, Lock, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, isValidAmountInput } from "@/lib/utils";
import { useNoctisVault } from "@/hooks/useNoctisVault";

interface WithdrawModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type WithdrawToken = "ETH" | "USDC";

export function WithdrawModal({ open, onOpenChange }: WithdrawModalProps) {
  const [token, setToken] = useState<WithdrawToken>("ETH");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [requestId, setRequestId] = useState<bigint | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);

  const { requestWithdrawal, isLoading, error } = useNoctisVault({
    onWithdrawalSuccess: () => {
      console.log("Withdrawal request succeeded");
    }
  });

  const handleWithdraw = async () => {
    if (!amount || parseFloat(amount) <= 0 || !recipient) return;
    
    // Reset previous success state
    setShowSuccess(false);
    setRequestId(null);
    
    // Call the withdrawal function
    const newRequestId = await requestWithdrawal(recipient, amount, token === "ETH");
    
    if (newRequestId !== null) {
      // Success!
      setRequestId(newRequestId);
      setShowSuccess(true);
      
      // Reset form after showing success message
      setTimeout(() => {
        setAmount("");
        setRecipient("");
        setShowSuccess(false);
        onOpenChange(false);
      }, 3000);
    }
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isValidAmountInput(e.target.value)) {
      setAmount(e.target.value);
    }
  };

  const isValidAddress = recipient.startsWith("0x") && recipient.length === 42;

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

          {/* Token selection */}
          <div className="flex gap-2 mb-6">
            {(["ETH", "USDC"] as WithdrawToken[]).map((t) => (
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

          {/* Recipient input */}
          <div className="space-y-2 mb-4">
            <label className="text-sm font-medium">Recipient Address</label>
            <Input
              type="text"
              placeholder="0x..."
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              className={cn(
                recipient && !isValidAddress && "border-red-500"
              )}
            />
            {recipient && !isValidAddress && (
              <p className="text-xs text-red-500">Invalid address format</p>
            )}
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
                className="pr-16 text-lg"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                {token}
              </span>
            </div>
          </div>

          {/* Privacy info */}
          <div className="flex items-start gap-3 p-3 rounded-xl bg-brand-50 mb-6 text-sm">
            <Lock className="h-4 w-4 text-brand-600 mt-0.5" />
            <div>
              <p className="font-medium text-brand-900">Private Withdrawal</p>
              <p className="text-brand-600 mt-0.5">
                Recipient address and amount will be encrypted. No one can see where your funds go.
              </p>
            </div>
          </div>

          {/* Success message */}
          {showSuccess && requestId && (
            <div className="flex items-start gap-3 p-3 rounded-xl bg-green-50 mb-4 text-sm">
              <CheckCircle className="h-4 w-4 text-green-600 mt-0.5" />
              <div>
                <p className="font-medium text-green-900">Withdrawal Request #{requestId.toString()} Submitted!</p>
                <p className="text-green-600 mt-0.5">
                  Go to your balance panel and click "Execute" to complete privately.
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
            disabled={!amount || parseFloat(amount) <= 0 || !isValidAddress || isLoading}
            loading={isLoading}
            onClick={handleWithdraw}
          >
            {isLoading ? "Processing..." : `Withdraw ${token}`}
            {!isLoading && <ArrowRight className="ml-2 h-4 w-4" />}
          </Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
