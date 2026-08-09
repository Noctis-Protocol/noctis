/**
 * useTokenRegistry — dynamic multi-token registry for NoctisVaultV2 / NoctisExchangeV2.
 *
 * No hardcoded token list: reads vault.getSupportedTokens() and
 * exchange.getTradableTokens() on-chain, then resolves symbol/decimals via
 * ERC-20 reads. Native ETH is address(0) => "ETH", 18 decimals.
 *
 * wagmi/react-query dedupes the underlying calls, so this hook can be used
 * from several components without extra RPC load.
 */

"use client";

import { useMemo } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { NoctisVaultABI, NoctisExchangeABI, ERC20ABI, NATIVE_TOKEN } from "@/lib/contracts/abi";
import { useContractAddresses } from "@/lib/wagmi";

export interface TokenInfo {
  /** address(0) for native ETH */
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  isNative: boolean;
  /** Registered in the vault (deposit/withdraw/balances) */
  supported: boolean;
  /** Listed on the exchange as a base token (traded against USDC) */
  tradable: boolean;
  /** Quote token of every pair */
  isUsdc: boolean;
}

interface UseTokenRegistryReturn {
  /** All known tokens (vault ∪ exchange), metadata resolved */
  tokens: TokenInfo[];
  /** Tokens accepted by the vault (deposit / withdraw / balance screens) */
  supportedTokens: TokenInfo[];
  /** Base tokens tradable against USDC (pair selector) */
  tradableTokens: TokenInfo[];
  /** The USDC quote token (from env NEXT_PUBLIC_USDT_ADDRESS slot) */
  usdc: TokenInfo | undefined;
  isLoading: boolean;
  /** Lookup by address (case-insensitive); undefined when not registered */
  getToken: (address: string | undefined | null) => TokenInfo | undefined;
  /** Symbol for display; falls back to a shortened address */
  symbolFor: (address: string | undefined | null) => string;
  /** Decimals for formatting; defaults to 18 when unknown */
  decimalsFor: (address: string | undefined | null) => number;
}

const NATIVE: Pick<TokenInfo, "symbol" | "decimals" | "isNative"> = {
  symbol: "ETH",
  decimals: 18,
  isNative: true,
};

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function useTokenRegistry(): UseTokenRegistryReturn {
  const contracts = useContractAddresses();
  const vaultAddress = contracts?.vaultAddress as `0x${string}` | undefined;
  const exchangeAddress = contracts?.exchangeAddress as `0x${string}` | undefined;
  const usdcAddress = contracts?.usdcAddress?.toLowerCase();

  const { data: supportedRaw, isLoading: loadingSupported } = useReadContract({
    abi: NoctisVaultABI,
    address: vaultAddress,
    functionName: "getSupportedTokens",
    query: {
      enabled: Boolean(vaultAddress),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  });

  const { data: tradableRaw, isLoading: loadingTradable } = useReadContract({
    abi: NoctisExchangeABI,
    address: exchangeAddress,
    functionName: "getTradableTokens",
    query: {
      enabled: Boolean(exchangeAddress),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  });

  const supportedSet = useMemo(
    () => new Set(((supportedRaw as `0x${string}`[] | undefined) ?? []).map((a) => a.toLowerCase())),
    [supportedRaw]
  );
  const tradableSet = useMemo(
    () => new Set(((tradableRaw as `0x${string}`[] | undefined) ?? []).map((a) => a.toLowerCase())),
    [tradableRaw]
  );

  /** Union of both registries, native first, ERC-20s after */
  const allAddresses = useMemo(() => {
    const union = new Set<string>([...supportedSet, ...tradableSet]);
    const list = [...union];
    list.sort((a, b) => {
      if (a === NATIVE_TOKEN) return -1;
      if (b === NATIVE_TOKEN) return 1;
      return a.localeCompare(b);
    });
    return list as `0x${string}`[];
  }, [supportedSet, tradableSet]);

  const erc20Addresses = useMemo(
    () => allAddresses.filter((a) => a !== NATIVE_TOKEN),
    [allAddresses]
  );

  // symbol() + decimals() for each ERC-20 in one multicall batch
  const { data: metadataRaw, isLoading: loadingMetadata } = useReadContracts({
    contracts: erc20Addresses.flatMap((address) => [
      { abi: ERC20ABI, address, functionName: "symbol" as const },
      { abi: ERC20ABI, address, functionName: "decimals" as const },
    ]),
    query: {
      enabled: erc20Addresses.length > 0,
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
  });

  const tokens = useMemo<TokenInfo[]>(() => {
    return allAddresses.map((address, index) => {
      const lower = address.toLowerCase();
      const isNative = lower === NATIVE_TOKEN;

      let symbol: string;
      let decimals: number;
      if (isNative) {
        symbol = NATIVE.symbol;
        decimals = NATIVE.decimals;
      } else {
        const erc20Index = erc20Addresses.indexOf(address);
        const symbolResult = metadataRaw?.[erc20Index * 2];
        const decimalsResult = metadataRaw?.[erc20Index * 2 + 1];
        symbol =
          symbolResult?.status === "success" && typeof symbolResult.result === "string"
            ? symbolResult.result
            : shortAddress(address);
        decimals =
          decimalsResult?.status === "success" && decimalsResult.result != null
            ? Number(decimalsResult.result)
            : 18;
      }

      void index;
      return {
        address,
        symbol,
        decimals,
        isNative,
        supported: supportedSet.has(lower),
        tradable: tradableSet.has(lower),
        isUsdc: Boolean(usdcAddress && lower === usdcAddress),
      };
    });
  }, [allAddresses, erc20Addresses, metadataRaw, supportedSet, tradableSet, usdcAddress]);

  const byAddress = useMemo(() => {
    const map = new Map<string, TokenInfo>();
    for (const token of tokens) map.set(token.address.toLowerCase(), token);
    return map;
  }, [tokens]);

  const getToken = useMemo(
    () => (address: string | undefined | null) =>
      address ? byAddress.get(address.toLowerCase()) : undefined,
    [byAddress]
  );

  const symbolFor = useMemo(
    () => (address: string | undefined | null) => {
      if (!address) return "?";
      const token = byAddress.get(address.toLowerCase());
      if (token) return token.symbol;
      return address.toLowerCase() === NATIVE_TOKEN ? "ETH" : shortAddress(address);
    },
    [byAddress]
  );

  const decimalsFor = useMemo(
    () => (address: string | undefined | null) => {
      if (!address) return 18;
      if (address.toLowerCase() === NATIVE_TOKEN) return 18;
      return byAddress.get(address.toLowerCase())?.decimals ?? 18;
    },
    [byAddress]
  );

  return {
    tokens,
    supportedTokens: tokens.filter((t) => t.supported),
    // Pair selector: base tokens only (USDC is the quote of every pair)
    tradableTokens: tokens.filter((t) => t.tradable && !t.isUsdc),
    usdc: tokens.find((t) => t.isUsdc),
    isLoading: loadingSupported || loadingTradable || loadingMetadata,
    getToken,
    symbolFor,
    decimalsFor,
  };
}

/** Format a raw token amount for display (trims to displayDecimals). */
export function formatTokenAmount(
  value: bigint,
  decimals: number,
  displayDecimals?: number
): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const integerPart = abs / divisor;
  const fractionalPart = abs % divisor;
  const dp = displayDecimals ?? (decimals >= 18 ? 4 : Math.min(decimals, 2));
  const fractionalStr = fractionalPart.toString().padStart(decimals, "0").slice(0, dp);
  const sign = negative ? "-" : "";
  return dp > 0 ? `${sign}${integerPart}.${fractionalStr}` : `${sign}${integerPart}`;
}

/** Parse a human amount string into raw units (floors extra precision). */
export function parseTokenAmount(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!trimmed || !/^\d*(\.\d*)?$/.test(trimmed)) return 0n;
  const [intPart = "0", fracPart = ""] = trimmed.split(".");
  const frac = fracPart.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(intPart || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

/** Default display decimals per token (ETH-like 4 dp, stablecoins 2 dp). */
export function displayDecimalsFor(token: Pick<TokenInfo, "decimals">): number {
  return token.decimals >= 18 ? 4 : Math.min(token.decimals, 2);
}

export interface TokenLimits {
  /** Human units (already divided by token decimals) */
  minDeposit?: number;
  maxDeposit?: number;
  maxWithdrawal?: number;
  isLoading: boolean;
}

/** Per-token vault limits from on-chain tokenConfigs (V2). */
export function useTokenLimits(token: TokenInfo | null): TokenLimits {
  const contracts = useContractAddresses();
  const vaultAddress = contracts?.vaultAddress as `0x${string}` | undefined;

  const { data, isLoading } = useReadContract({
    abi: NoctisVaultABI,
    address: vaultAddress,
    functionName: "tokenConfigs",
    args: token ? [token.address] : undefined,
    query: {
      enabled: Boolean(vaultAddress && token),
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
  });

  return useMemo(() => {
    if (!token || !data) return { isLoading };
    // tokenConfigs → (enabled, decimals, minDeposit, maxDeposit, maxWithdrawal, maxDaily)
    const [, , minDeposit, maxDeposit, maxWithdrawal] = data as unknown as readonly [
      boolean, number, bigint, bigint, bigint, bigint
    ];
    const divisor = 10 ** token.decimals;
    return {
      minDeposit: Number(minDeposit) / divisor,
      maxDeposit: Number(maxDeposit) / divisor,
      maxWithdrawal: Number(maxWithdrawal) / divisor,
      isLoading,
    };
  }, [token, data, isLoading]);
}
