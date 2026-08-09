"use client";

/**
 * Open amount field — no nested grey cards; JetBrains Mono amounts (tabular).
 * V2: token-agnostic — takes a symbol and an optional selector slot so the
 * trade screen can swap the base token in place.
 */

import { ChangeEvent, ReactNode } from "react";
import { cn, formatUsd, isValidAmountInput } from "@/lib/utils";
import { TokenLogo } from "@/components/ui/TokenSelector";

interface TokenInputProps {
  label: string;
  symbol: string;
  /** Secondary line under the symbol (defaults to nothing) */
  tokenName?: string;
  amount: string;
  usdValue?: number;
  balance?: string;
  readOnly?: boolean;
  isLoading?: boolean;
  onChange?: (value: string) => void;
  className?: string;
  emphasis?: "pay" | "receive";
  /** Replaces the static symbol block (e.g. a TokenSelector) */
  selectorSlot?: ReactNode;
}

export function TokenInput({
  label,
  symbol,
  tokenName,
  amount,
  usdValue = 0,
  balance,
  readOnly = false,
  isLoading = false,
  onChange,
  className,
  emphasis = "pay",
  selectorSlot,
}: TokenInputProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (isValidAmountInput(value)) onChange?.(value);
  };

  return (
    <div className={cn("group", className)}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="font-display text-[0.72rem] font-semibold uppercase tracking-[0.2em] text-ink-400">
          {label}
        </span>
        {balance != null && balance !== "" && (
          <span className="font-sans text-xs text-ink-400">
            vault{" "}
            <span className="font-amount font-semibold text-ink-600">
              {balance}
            </span>{" "}
            {symbol}
          </span>
        )}
      </div>

      <div className="flex items-end gap-4">
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div
              className={cn(
                "font-amount leading-none text-ink-300 animate-pulse",
                emphasis === "pay"
                  ? "text-[2.5rem] sm:text-[2.75rem]"
                  : "text-[2rem] sm:text-[2.25rem]"
              )}
            >
              …
            </div>
          ) : (
            <input
              type="text"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={handleChange}
              readOnly={readOnly}
              suppressHydrationWarning
              className={cn(
                "font-amount w-full bg-transparent leading-none text-ink-900",
                "placeholder:text-ink-200 focus:outline-none",
                readOnly && "cursor-default",
                emphasis === "pay"
                  ? "text-[2.5rem] sm:text-[2.75rem]"
                  : "text-[2rem] sm:text-[2.25rem] text-ink-800"
              )}
              aria-label={`${label} ${symbol} amount`}
            />
          )}
          <p className="mt-2 min-h-[1.25rem] font-sans text-sm text-ink-400">
            {usdValue > 0 ? `≈ ${formatUsd(usdValue)}` : "\u00a0"}
          </p>
        </div>

        <div className="mb-1 flex shrink-0 flex-col items-end gap-1">
          {selectorSlot ?? (
            <div className="flex items-center gap-2">
              <TokenLogo symbol={symbol} className="h-5 w-5 opacity-90" />
              <span className="font-display text-2xl font-bold tracking-[-0.04em] text-ink-900">
                {symbol}
              </span>
            </div>
          )}
          {tokenName && (
            <span className="font-sans text-[0.7rem] text-ink-400">{tokenName}</span>
          )}
        </div>
      </div>
    </div>
  );
}
