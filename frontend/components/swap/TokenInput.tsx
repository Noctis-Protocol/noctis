"use client";

/**
 * Open amount field — no nested grey cards; JetBrains Mono amounts (tabular).
 */

import { ChangeEvent } from "react";
import { cn, formatUsd, isValidAmountInput } from "@/lib/utils";

interface TokenInputProps {
  label: string;
  token: "ETH" | "USDC";
  amount: string;
  usdValue?: number;
  balance?: string;
  readOnly?: boolean;
  isLoading?: boolean;
  onChange?: (value: string) => void;
  className?: string;
  emphasis?: "pay" | "receive";
}

const TOKEN_META = {
  ETH: {
    symbol: "ETH",
    name: "Ether",
    logo: "https://upload.wikimedia.org/wikipedia/commons/0/05/Ethereum_logo_2014.svg",
  },
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    logo: "https://upload.wikimedia.org/wikipedia/commons/4/4a/Circle_USDC_Logo.svg",
  },
} as const;

export function TokenInput({
  label,
  token,
  amount,
  usdValue = 0,
  balance,
  readOnly = false,
  isLoading = false,
  onChange,
  className,
  emphasis = "pay",
}: TokenInputProps) {
  const meta = TOKEN_META[token];

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
            {meta.symbol}
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
              aria-label={`${label} ${meta.symbol} amount`}
            />
          )}
          <p className="mt-2 min-h-[1.25rem] font-sans text-sm text-ink-400">
            {usdValue > 0 ? `≈ ${formatUsd(usdValue)}` : "\u00a0"}
          </p>
        </div>

        <div className="mb-1 flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <img src={meta.logo} alt="" className="h-5 w-5 opacity-90" />
            <span className="font-display text-2xl font-bold tracking-[-0.04em] text-ink-900">
              {meta.symbol}
            </span>
          </div>
          <span className="font-sans text-[0.7rem] text-ink-400">{meta.name}</span>
        </div>
      </div>
    </div>
  );
}
