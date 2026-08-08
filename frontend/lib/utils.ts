/**
 * Utility functions for Noctis Frontend
 */

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// Tailwind class merger (shadcn pattern)
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Format address for display (0x1234...5678)
export function formatAddress(address: string, chars = 4): string {
  if (!address) return "";
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

// Format ETH amount (18 decimals)
export function formatEth(wei: bigint, decimals = 4): string {
  const eth = Number(wei) / 1e18;
  return eth.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

// Format USDT amount (6 decimals)
export function formatUsdt(amount: bigint, decimals = 2): string {
  const usdt = Number(amount) / 1e6;
  return usdt.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  });
}

// Format USD value
export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// Parse user input to bigint (handles decimals)
export function parseAmount(input: string, decimals: number): bigint {
  if (!input || input === "") return 0n;
  
  const [whole, fraction = ""] = input.split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  const combined = whole + paddedFraction;
  
  return BigInt(combined);
}

// Calculate price impact percentage
export function calculatePriceImpact(
  inputAmount: bigint,
  outputAmount: bigint,
  spotPrice: number
): number {
  if (inputAmount === 0n) return 0;
  
  const expectedOutput = Number(inputAmount) * spotPrice;
  const actualOutput = Number(outputAmount);
  const impact = ((expectedOutput - actualOutput) / expectedOutput) * 100;
  
  return Math.max(0, impact);
}

// Get price impact color class
export function getPriceImpactColor(impact: number): string {
  if (impact < 1) return "text-green-600";
  if (impact < 3) return "text-yellow-600";
  return "text-red-600";
}

// Validate amount input (only numbers and one decimal point)
export function isValidAmountInput(value: string): boolean {
  return /^\d*\.?\d*$/.test(value);
}

// Debounce function
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}
