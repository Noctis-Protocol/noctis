/**
 * Utility Functions Tests
 */

import { describe, it, expect } from "vitest";
import {
  cn,
  formatAddress,
  formatEth,
  formatUsdt,
  formatUsd,
  parseAmount,
  calculatePriceImpact,
  getPriceImpactColor,
  isValidAmountInput,
} from "@/lib/utils";

describe("cn (class names)", () => {
  it("should merge class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("should handle conditional classes", () => {
    expect(cn("base", true && "active", false && "disabled")).toBe("base active");
  });

  it("should merge Tailwind classes correctly", () => {
    expect(cn("p-4", "p-2")).toBe("p-2"); // Last one wins
  });
});

describe("formatAddress", () => {
  it("should truncate address", () => {
    const address = "0x1234567890abcdef1234567890abcdef12345678";
    expect(formatAddress(address)).toBe("0x1234...5678");
  });

  it("should handle custom char count", () => {
    const address = "0x1234567890abcdef1234567890abcdef12345678";
    expect(formatAddress(address, 6)).toBe("0x123456...345678");
  });

  it("should handle empty address", () => {
    expect(formatAddress("")).toBe("");
  });
});

describe("formatEth", () => {
  it("should format wei to ETH", () => {
    expect(formatEth(1000000000000000000n)).toBe("1"); // 1 ETH
  });

  it("should handle decimals", () => {
    expect(formatEth(1500000000000000000n, 2)).toBe("1.5");
  });

  it("should handle zero", () => {
    expect(formatEth(0n)).toBe("0");
  });
});

describe("formatUsdt", () => {
  it("should format USDT with 6 decimals", () => {
    expect(formatUsdt(1000000n)).toBe("1.00"); // 1 USDT
  });

  it("should format large amounts", () => {
    expect(formatUsdt(1000000000n)).toBe("1,000.00"); // 1000 USDT
  });
});

describe("formatUsd", () => {
  it("should format as currency", () => {
    expect(formatUsd(1234.56)).toBe("$1,234.56");
  });

  it("should handle zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("parseAmount", () => {
  it("should parse whole number", () => {
    expect(parseAmount("1", 18)).toBe(1000000000000000000n);
  });

  it("should parse decimal", () => {
    expect(parseAmount("1.5", 18)).toBe(1500000000000000000n);
  });

  it("should handle empty input", () => {
    expect(parseAmount("", 18)).toBe(0n);
  });

  it("should handle 6 decimals (USDT)", () => {
    expect(parseAmount("100", 6)).toBe(100000000n);
  });
});

describe("calculatePriceImpact", () => {
  it("should calculate zero impact for zero input", () => {
    expect(calculatePriceImpact(0n, 0n, 3000)).toBe(0);
  });

  it("should calculate positive impact", () => {
    // Input: 1 ETH at $3000, Output: 2900 USDT = 3.33% impact
    const impact = calculatePriceImpact(1000000000000000000n, 2900n, 3000);
    expect(impact).toBeGreaterThan(0);
  });
});

describe("getPriceImpactColor", () => {
  it("should return green for low impact", () => {
    expect(getPriceImpactColor(0.5)).toBe("text-green-600");
  });

  it("should return yellow for medium impact", () => {
    expect(getPriceImpactColor(2)).toBe("text-yellow-600");
  });

  it("should return red for high impact", () => {
    expect(getPriceImpactColor(5)).toBe("text-red-600");
  });
});

describe("isValidAmountInput", () => {
  it("should accept numbers", () => {
    expect(isValidAmountInput("123")).toBe(true);
  });

  it("should accept decimals", () => {
    expect(isValidAmountInput("1.5")).toBe(true);
  });

  it("should accept empty string", () => {
    expect(isValidAmountInput("")).toBe(true);
  });

  it("should reject letters", () => {
    expect(isValidAmountInput("abc")).toBe(false);
  });

  it("should reject multiple decimals", () => {
    expect(isValidAmountInput("1.2.3")).toBe(false);
  });
});
