"use client";

/**
 * TokenSelector — minimal editorial dropdown for the dynamic token registry.
 *
 * Used by deposit, withdraw, balance and trade screens. No heavy deps:
 * plain button + list, styled to match the desk's font-display / ink palette.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TokenInfo } from "@/hooks/useTokenRegistry";

/** Known token logos; anything else gets a letter avatar. */
const TOKEN_LOGOS: Record<string, string> = {
  ETH: "https://upload.wikimedia.org/wikipedia/commons/0/05/Ethereum_logo_2014.svg",
  WETH: "https://upload.wikimedia.org/wikipedia/commons/0/05/Ethereum_logo_2014.svg",
  USDC: "https://upload.wikimedia.org/wikipedia/commons/4/4a/Circle_USDC_Logo.svg",
};

export function TokenLogo({
  symbol,
  className,
}: {
  symbol: string;
  className?: string;
}) {
  const logo = TOKEN_LOGOS[symbol.toUpperCase()];
  if (logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo} alt="" className={cn("rounded-full", className)} />;
  }
  return (
    <span
      className={cn(
        "flex items-center justify-center rounded-full bg-ink-900 font-display font-bold text-white",
        className
      )}
      style={{ fontSize: "0.55em" }}
      aria-hidden
    >
      {symbol.slice(0, 1).toUpperCase()}
    </span>
  );
}

interface TokenSelectorProps {
  tokens: TokenInfo[];
  selected: TokenInfo | null;
  onSelect: (token: TokenInfo) => void;
  disabled?: boolean;
  /** Compact renders inline (trade card); default renders a full-width field */
  variant?: "field" | "inline";
  className?: string;
  ariaLabel?: string;
}

export function TokenSelector({
  tokens,
  selected,
  onSelect,
  disabled = false,
  variant = "field",
  className,
  ariaLabel = "Select token",
}: TokenSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  const canOpen = !disabled && tokens.length > 1;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled || tokens.length === 0}
        onClick={() => canOpen && setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-2 transition",
          variant === "field"
            ? "w-full justify-between rounded-2xl border border-ink-200 bg-transparent px-4 py-3 hover:border-ink-400 disabled:opacity-50"
            : "rounded-full px-1 py-0.5 hover:opacity-80 disabled:opacity-50"
        )}
      >
        <span className="flex items-center gap-2">
          {selected ? (
            <>
              <TokenLogo symbol={selected.symbol} className="h-5 w-5" />
              <span className="font-display text-base font-bold tracking-[-0.03em] text-ink-900">
                {selected.symbol}
              </span>
            </>
          ) : (
            <span className="font-sans text-sm text-ink-400">
              {tokens.length === 0 ? "No tokens listed" : "Select token"}
            </span>
          )}
        </span>
        {canOpen && (
          <ChevronDown
            className={cn("h-3.5 w-3.5 text-ink-400 transition-transform", open && "rotate-180")}
          />
        )}
      </button>

      {open && (
        <ul
          role="listbox"
          className={cn(
            "absolute z-30 mt-2 max-h-64 min-w-[11rem] overflow-y-auto rounded-2xl border border-ink-200 bg-white py-1.5 shadow-lg",
            variant === "field" ? "left-0 right-0" : "right-0"
          )}
        >
          {tokens.map((token) => {
            const isSelected = selected?.address.toLowerCase() === token.address.toLowerCase();
            return (
              <li key={token.address}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onSelect(token);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition hover:bg-ink-100/70",
                    isSelected && "bg-ink-100/50"
                  )}
                >
                  <span className="flex items-center gap-2.5">
                    <TokenLogo symbol={token.symbol} className="h-5 w-5" />
                    <span className="font-display text-sm font-bold tracking-[-0.02em] text-ink-900">
                      {token.symbol}
                    </span>
                    <span className="font-sans text-[0.68rem] text-ink-400">
                      {token.isNative ? "native" : `${token.decimals} dec`}
                    </span>
                  </span>
                  {isSelected && <Check className="h-3.5 w-3.5 text-brand-700" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
