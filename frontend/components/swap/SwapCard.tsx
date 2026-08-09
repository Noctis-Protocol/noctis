"use client";

/**
 * SwapCard Component (V2 — multi-token)
 *
 * Central trading interface with USER-INITIATED SWAP:
 * - Pair selector: any tradable base token vs USDC
 * - Create encrypted order (base units, per-token decimals)
 * - Request swap execution (mark for decryption)
 * - Decrypt privately via Gateway
 * - Execute with proof
 *
 * PRIVACY-FIRST: No keeper involvement, user controls entire flow.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useAccount, useChainId, usePublicClient } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { ArrowDownUp, CheckCircle, Loader2, AlertTriangle, Copy, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { TokenInput } from "./TokenInput";
import { isFlashbotsConfigured, isFlashbotsUrl, getSavedRpcUrl, saveRpcUrl } from "./FlashbotsSetupModal";
import { TokenSelector } from "@/components/ui/TokenSelector";
import {
  useNoctisExchange,
  useVaultBalances,
  useSwapExecution,
  useBalanceDecryption,
  useTokenRegistry,
  useBaseTokenMarket,
  parseTokenAmount,
} from "@/hooks";
import type { TokenInfo } from "@/hooks";
import { cn, formatUsd, getPriceImpactColor } from "@/lib/utils";
import { buyPreflight } from "@/lib/buyPreflight";
import { NoctisExchangeABI } from "@/lib/contracts/abi";
import { useContractAddresses } from "@/lib/wagmi";

// NoctisExchange caps slippage at 3% (MAX_MARKET_ORDER_SLIPPAGE_BPS = 300).
// The Sepolia pilot pools are shallow: sub-1% tolerances can never clear the
// oracle slippage floor and the swap reverts with INSUFFICIENT_OUTPUT_AMOUNT.
const SLIPPAGE_OPTIONS = [0.5, 1.0, 2.0, 3.0];

// Flashbots RPC URLs
const FLASHBOTS_RPC = {
  mainnet: "https://rpc.flashbots.net",
  sepolia: "https://rpc-sepolia.flashbots.net",
};

/**
 * MEV Protection Check Component
 * Inline RPC verification with Flashbots info
 */
function MevProtectionCheck({
  onRpcChecked
}: {
  onRpcChecked: (isFlashbots: boolean) => void;
}) {
  const chainId = useChainId();
  const [userRpc, setUserRpc] = useState(getSavedRpcUrl());
  const [copied, setCopied] = useState(false);
  const [copiedChainId, setCopiedChainId] = useState(false);

  const isMainnet = chainId === 1;
  const flashbotsUrl = isMainnet ? FLASHBOTS_RPC.mainnet : FLASHBOTS_RPC.sepolia;
  const chainIdStr = isMainnet ? "1" : "11155111";
  const networkName = isMainnet ? "Ethereum Mainnet" : "Sepolia";

  const handleRpcChange = (value: string) => {
    setUserRpc(value);
    saveRpcUrl(value);
    onRpcChecked(isFlashbotsUrl(value));
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(flashbotsUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyChainId = () => {
    navigator.clipboard.writeText(chainIdStr);
    setCopiedChainId(true);
    setTimeout(() => setCopiedChainId(false), 2000);
  };

  const isUserProtected = isFlashbotsUrl(userRpc);

  return (
    <div className={cn(
      "p-3 rounded-xl border",
      isUserProtected
        ? "bg-green-50 border-green-200"
        : "bg-amber-50 border-amber-200"
    )}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        {isUserProtected ? (
          <CheckCircle className="h-4 w-4 text-green-600" />
        ) : (
          <AlertTriangle className="h-4 w-4 text-amber-600" />
        )}
        <span className={cn(
          "font-medium text-sm",
          isUserProtected ? "text-green-900" : "text-amber-900"
        )}>
          {isUserProtected ? "MEV Protection Active" : "Not Protected - Configure Flashbots"}
        </span>
      </div>

      {/* RPC Input */}
      <div className="mb-3">
        <label className="block text-xs text-muted-foreground mb-1">
          Your RPC URL (from MetaMask → {networkName}):
        </label>
        <input
          type="text"
          value={userRpc}
          onChange={(e) => handleRpcChange(e.target.value)}
          placeholder="Paste your RPC URL here..."
          className={cn(
            "w-full px-2.5 py-1.5 rounded-lg border text-xs font-mono",
            "focus:outline-none focus:ring-1",
            isUserProtected
              ? "border-green-300 focus:ring-green-500 bg-white"
              : "border-amber-300 focus:ring-amber-500 bg-white"
          )}
        />
      </div>

      {/* Flashbots Info - Always visible */}
      <div className="p-2.5 rounded-lg bg-white/80 border border-gray-200">
        <p className="text-xs text-muted-foreground mb-2">
          Flashbots hides your swap from the public mempool, preventing bots from frontrunning you.
        </p>
        <p className="text-xs font-medium text-gray-700 mb-2">
          How to check / configure:
        </p>
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Flashbots RPC:</span>
            <div className="flex items-center gap-1">
              <code className="px-1.5 py-0.5 bg-gray-100 rounded text-[10px] font-mono max-w-[150px] truncate">
                {flashbotsUrl}
              </code>
              <button
                onClick={handleCopy}
                className="p-1 hover:bg-gray-100 rounded"
              >
                {copied ? (
                  <CheckCircle className="h-3 w-3 text-green-600" />
                ) : (
                  <Copy className="h-3 w-3 text-gray-500" />
                )}
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Chain ID:</span>
            <div className="flex items-center gap-1">
              <code className="px-1.5 py-0.5 bg-gray-100 rounded text-[10px] font-mono">
                {chainIdStr}
              </code>
              <button
                onClick={handleCopyChainId}
                className="p-1 hover:bg-gray-100 rounded"
              >
                {copiedChainId ? (
                  <CheckCircle className="h-3 w-3 text-green-600" />
                ) : (
                  <Copy className="h-3 w-3 text-gray-500" />
                )}
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Currency:</span>
            <code className="px-1.5 py-0.5 bg-gray-100 rounded text-[10px] font-mono">
              ETH
            </code>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SwapCardProps {
  /** Controlled pair selection (desk page shares it with chart + depth) */
  baseAddress?: string | null;
  onBaseAddressChange?: (address: string) => void;
}

export function SwapCard({
  baseAddress: baseAddressProp,
  onBaseAddressChange,
}: SwapCardProps = {}) {
  const { isConnected, address } = useAccount();
  const publicClient = usePublicClient();
  const contracts = useContractAddresses();
  const { tradableTokens, usdc } = useTokenRegistry();

  // Pair selection: base token vs USDC (controlled by the page when provided)
  const [internalBase, setInternalBase] = useState<string | null>(null);
  const baseAddress =
    baseAddressProp !== undefined ? baseAddressProp : internalBase;
  const baseToken: TokenInfo | null =
    tradableTokens.find(
      (t) => t.address.toLowerCase() === baseAddress?.toLowerCase()
    ) ?? tradableTokens[0] ?? null;
  const quoteSymbol = usdc?.symbol ?? "USDC";

  const market = useBaseTokenMarket(baseToken);
  const basePrice = market.price;

  const { createMarketOrder, isLoading: isCreatingOrder, isFheReady, relayerAvailable } = useNoctisExchange();
  const {
    executeFullSwap,
    cancelSwapExecution,
    swapState,
    isLoading: isSwapping,
    error: swapError,
    reset: resetSwap,
  } = useSwapExecution({
    onSwapSuccess: () => {
      setInputAmount("");
      setSwapStep("complete");
      setBuyBlockReason(null);
      setBuyWarning(null);
      setTimeout(() => setSwapStep("idle"), 3000);
    },
    onSwapError: () => setSwapStep("idle"),
  });
  const { hasBalance } = useVaultBalances();
  const { balanceFor } = useBalanceDecryption();

  // Swap state — isSell: pay base receive USDC; !isSell (BUY): pay USDC receive base
  const [isSell, setIsSell] = useState(true);
  const [inputAmount, setInputAmount] = useState("");
  // 2% default: required for typical sizes on the shallow pilot pools (see
  // SLIPPAGE_OPTIONS note). Users trading smaller sizes can lower it.
  const [slippage, setSlippage] = useState(2.0);
  const [showSettings, setShowSettings] = useState(false);
  const [swapStep, setSwapStep] = useState<"idle" | "creating" | "executing" | "complete">("idle");
  const [lastOrderId, setLastOrderId] = useState<bigint | null>(null);
  const [pendingOrderIds, setPendingOrderIds] = useState<bigint[]>([]);
  const [, setFlashbotsEnabled] = useState(false);
  const [showMev, setShowMev] = useState(false);
  const [buyBlockReason, setBuyBlockReason] = useState<string | null>(null);
  const [buyWarning, setBuyWarning] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancellingId, setCancellingId] = useState<bigint | null>(null);

  // Load Flashbots status on mount
  useEffect(() => {
    setFlashbotsEnabled(isFlashbotsConfigured());
  }, []);

  // Update status when user checks their RPC in modal
  const handleRpcChecked = useCallback((isFlashbots: boolean) => {
    setFlashbotsEnabled(isFlashbots);
  }, []);

  // Real output from Uniswap
  const [realOutput, setRealOutput] = useState<{ output: number; priceImpact: number } | null>(null);

  const [isLoadingQuote, setIsLoadingQuote] = useState(false);
  const QUOTE_REFRESH_INTERVAL = 10; // Refresh every 10 seconds (like 1inch)

  // Minimum order size (base units → human)
  const minOrderBase = useMemo(() => {
    if (!baseToken || market.minOrderSize <= 0n) return 0;
    return Number(market.minOrderSize) / 10 ** baseToken.decimals;
  }, [baseToken, market.minOrderSize]);

  // Use ref to avoid re-creating intervals when fetchQuote changes
  const fetchQuoteRef = useRef<() => Promise<void>>(async () => {});

  // Keep ref updated with latest fetchQuote function
  fetchQuoteRef.current = async () => {
    const inputValue = parseFloat(inputAmount) || 0;
    if (inputValue <= 0 || !baseToken) {
      setRealOutput(null);
      return;
    }

    setIsLoadingQuote(true);
    try {
      const result = await market.getOutputAmount(inputValue, isSell);
      setRealOutput(result);
    } catch (e) {
      console.error("Quote fetch error:", e);
      setRealOutput(null);
    } finally {
      setIsLoadingQuote(false);
    }
  };

  // Debounced fetch on input change (only depends on input values, not functions)
  useEffect(() => {
    const inputValue = parseFloat(inputAmount) || 0;
    if (inputValue <= 0) {
      setRealOutput(null);
      setBuyBlockReason(null);
      setBuyWarning(null);
      return;
    }

    const timeout = setTimeout(() => {
      fetchQuoteRef.current?.();
    }, 300);
    return () => clearTimeout(timeout);
  }, [inputAmount, isSell, baseToken?.address]); // eslint-disable-line react-hooks/exhaustive-deps

  // BUY: size/warn from Uniswap; hard-block only on quote failure
  useEffect(() => {
    if (isSell || !publicClient || !market.preflightBase) {
      setBuyBlockReason(null);
      setBuyWarning(null);
      return;
    }
    const usdcAmount = parseFloat(inputAmount) || 0;
    if (usdcAmount <= 0) {
      setBuyBlockReason(null);
      setBuyWarning(null);
      return;
    }
    const preflightBase = market.preflightBase;
    let cancelled = false;
    const t = setTimeout(async () => {
      const result = await buyPreflight(
        publicClient,
        usdcAmount,
        Math.round(slippage * 100),
        preflightBase
      );
      if (cancelled) return;
      if (!result.ok) {
        setBuyBlockReason(result.reason);
        setBuyWarning(null);
      } else {
        setBuyBlockReason(null);
        setBuyWarning(result.warning ?? null);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [inputAmount, isSell, slippage, publicClient, market.preflightBase]);

  // Quote refresh timer
  useEffect(() => {
    const inputValue = parseFloat(inputAmount) || 0;
    if (inputValue <= 0) return;

    const interval = setInterval(() => {
      fetchQuoteRef.current?.();
    }, QUOTE_REFRESH_INTERVAL * 1000);

    return () => clearInterval(interval);
  }, [inputAmount]);

  // Refetch on window focus
  useEffect(() => {
    const handleFocus = () => {
      const inputValue = parseFloat(inputAmount) || 0;
      if (inputValue > 0) {
        fetchQuoteRef.current?.();
      }
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [inputAmount]);

  // Derived values — direction-aware (SELL: base→USDC, BUY: USDC→base)
  const inputValue = parseFloat(inputAmount) || 0;
  const outputAmount = realOutput
    ? isSell
      ? realOutput.output.toFixed(2)
      : realOutput.output.toFixed(6)
    : inputAmount && basePrice > 0
      ? isSell
        ? (inputValue * basePrice).toFixed(2)
        : (inputValue / basePrice).toFixed(6)
      : "";
  const inputUsd = inputAmount
    ? isSell
      ? inputValue * basePrice
      : inputValue
    : 0;
  const outputUsd = outputAmount
    ? isSell
      ? parseFloat(outputAmount)
      : parseFloat(outputAmount) * basePrice
    : 0;
  const priceImpact = realOutput?.priceImpact ?? 0;

  const baseVaultBalance = balanceFor(baseToken?.address)?.formatted;
  const usdcVaultBalance = balanceFor(usdc?.address)?.formatted;
  const payBalance = isSell ? baseVaultBalance : usdcVaultBalance;
  const receiveBalance = isSell ? usdcVaultBalance : baseVaultBalance;

  // Discover stuck PendingSwap orders for this wallet (survives refresh)
  const refreshPendingOrders = useCallback(async () => {
    if (!publicClient || !contracts?.exchangeAddress || !address) {
      setPendingOrderIds([]);
      return;
    }
    try {
      const counter = (await publicClient.readContract({
        address: contracts.exchangeAddress as `0x${string}`,
        abi: NoctisExchangeABI,
        functionName: "orderCounter",
      })) as bigint;
      const found: bigint[] = [];
      const start = counter > 30n ? counter - 30n : 1n;
      for (let id = start; id <= counter; id++) {
        const requested = (await publicClient.readContract({
          address: contracts.exchangeAddress as `0x${string}`,
          abi: NoctisExchangeABI,
          functionName: "swapExecutionRequested",
          args: [id],
        })) as boolean;
        if (!requested) continue;
        try {
          await publicClient.readContract({
            address: contracts.exchangeAddress as `0x${string}`,
            abi: NoctisExchangeABI,
            functionName: "getMyOrder",
            args: [id],
            account: address,
          });
          found.push(id);
        } catch {
          /* not owner */
        }
      }
      setPendingOrderIds(found);
      if (found.length > 0 && lastOrderId == null) {
        setLastOrderId(found[found.length - 1]!);
      }
    } catch (e) {
      console.warn("pending order scan failed", e);
    }
  }, [publicClient, contracts?.exchangeAddress, address, lastOrderId]);

  useEffect(() => {
    if (!isConnected) {
      setPendingOrderIds([]);
      return;
    }
    void refreshPendingOrders();
    const t = setInterval(() => void refreshPendingOrders(), 20_000);
    return () => clearInterval(t);
  }, [isConnected, refreshPendingOrders]);

  // Swap direction — keep notional when possible (convert via quote or oracle)
  const handleSwapDirection = useCallback(() => {
    const amt = parseFloat(inputAmount);
    let nextAmount = "";
    if (amt > 0 && basePrice > 0) {
      if (isSell) {
        // SELL → BUY: pay USDC ≈ previous receive (or base * price)
        const usdcAmt = realOutput?.output ?? amt * basePrice;
        nextAmount = usdcAmt.toFixed(2);
      } else {
        // BUY → SELL: pay base ≈ previous receive (or USDC / price)
        const baseAmt = realOutput?.output ?? amt / basePrice;
        nextAmount = baseAmt.toFixed(6);
      }
    }
    setIsSell((v) => !v);
    setInputAmount(nextAmount);
    setRealOutput(null);
    setSwapStep("idle");
  }, [basePrice, inputAmount, isSell, realOutput]);

  const handleSelectBase = useCallback(
    (token: TokenInfo) => {
      setInternalBase(token.address);
      onBaseAddressChange?.(token.address);
      setInputAmount("");
      setRealOutput(null);
      setBuyBlockReason(null);
      setBuyWarning(null);
      setSwapStep("idle");
    },
    [onBaseAddressChange]
  );

  // Execute full swap: create order → request → decrypt → execute
  const handleSwap = useCallback(async () => {
    if (!inputAmount || parseFloat(inputAmount) <= 0 || !baseToken) return;

    try {
      // Step 1: Create encrypted order
      setSwapStep("creating");
      const isBuy = !isSell; // Buying base with USDC

      let amountBase: bigint;

      if (isBuy) {
        if (!publicClient || !market.preflightBase) {
          setSwapStep("idle");
          return;
        }
        const pre = await buyPreflight(
          publicClient,
          parseFloat(inputAmount),
          Math.round(slippage * 100),
          market.preflightBase
        );
        if (!pre.ok) {
          setBuyBlockReason(pre.reason);
          setSwapStep("idle");
          return;
        }
        // Oracle-sized base leg (honest receive). Still blocked above when the
        // oracle floor cannot be met for the oracle-priced USDC debit.
        amountBase = pre.amountBase;
      } else {
        amountBase = parseTokenAmount(inputAmount, baseToken.decimals);
      }

      const orderId = await createMarketOrder({
        baseToken: baseToken.address,
        amountBase,
        isBuy,
        slippageBPS: Math.round(slippage * 100),
        maxDeviationBPS: 150,
      });

      if (!orderId) {
        setSwapStep("idle");
        return;
      }

      setLastOrderId(orderId);
      setSwapStep("executing");

      // minAmountOut = Uniswap floor (pre protocol fee). Prefer live pool quote.
      const slipBps = BigInt(Math.round(slippage * 100));
      let outputValue: bigint;
      if (isBuy) {
        const baseOut = realOutput?.output ?? parseFloat(outputAmount || "0");
        outputValue = parseTokenAmount(baseOut.toFixed(baseToken.decimals), baseToken.decimals);
      } else {
        outputValue = BigInt(
          Math.floor(parseFloat(outputAmount || "0") * 1e6)
        );
      }
      const minAmountOut =
        outputValue > 0n
          ? (outputValue * (10000n - slipBps)) / 10000n
          : 0n;

      const success = await executeFullSwap(orderId, minAmountOut, isBuy);

      if (!success) {
        setSwapStep("idle");
      }
      // On success, the callback will set swapStep to "complete"

    } catch (err) {
      console.error("Swap failed:", err);
      setSwapStep("idle");
    }
  }, [
    inputAmount,
    isSell,
    baseToken,
    outputAmount,
    realOutput,
    slippage,
    publicClient,
    market.preflightBase,
    createMarketOrder,
    executeFullSwap,
  ]);

  const handleCancelPending = useCallback(
    async (orderId: bigint) => {
      setIsCancelling(true);
      setCancellingId(orderId);
      try {
        const ok = await cancelSwapExecution(orderId);
        if (ok) {
          setPendingOrderIds((prev) => prev.filter((id) => id !== orderId));
          if (lastOrderId === orderId) setLastOrderId(null);
          setBuyBlockReason(null);
          resetSwap();
          await refreshPendingOrders();
        }
      } finally {
        setIsCancelling(false);
        setCancellingId(null);
      }
    },
    [cancelSwapExecution, lastOrderId, resetSwap, refreshPendingOrders]
  );

  // Loading state
  const isLoading = isCreatingOrder || isSwapping || swapStep === "creating" || swapStep === "executing";

  const baseSymbol = baseToken?.symbol ?? "…";

  // Button state
  const getButtonConfig = () => {
    if (!isConnected) {
      return { text: "Connect Wallet", disabled: false, showConnect: true };
    }
    if (!baseToken) {
      return { text: "Loading pairs…", disabled: true };
    }
    if (!inputAmount || parseFloat(inputAmount) <= 0) {
      return {
        text: isSell ? `Enter ${baseSymbol} to sell` : `Enter ${quoteSymbol} to spend`,
        disabled: true,
      };
    }
    // Contract minOrderSize applies to the order's amountBase (oracle-sized),
    // NOT the Uniswap receive quote (thin Sepolia pools can quote below it).
    const baseLeg = isSell
      ? parseFloat(inputAmount)
      : basePrice > 0
        ? parseFloat(inputAmount) / basePrice
        : 0;
    if (minOrderBase > 0 && baseLeg > 0 && baseLeg < minOrderBase) {
      if (isSell) {
        return { text: `Minimum order: ${minOrderBase} ${baseSymbol}`, disabled: true };
      }
      const minUsdc = (minOrderBase * basePrice).toFixed(2);
      return {
        text: `Minimum ~${minUsdc} ${quoteSymbol} (≥ ${minOrderBase} ${baseSymbol})`,
        disabled: true,
      };
    }
    if (!isSell && buyBlockReason) {
      return { text: "BUY unavailable", disabled: true };
    }
    if (!isFheReady) {
      return { text: "Initializing encryption...", disabled: true };
    }
    if (swapStep === "creating") {
      return { text: relayerAvailable ? "Sign order..." : "Creating Order...", disabled: true, loading: true };
    }
    if (swapStep === "executing") {
      const step = swapState.step;
      if (step === "requesting") return { text: relayerAvailable ? "1/3: Sign request..." : "1/3: Requesting...", disabled: true, loading: true };
      if (step === "decrypting") return { text: "2/3: Decrypting...", disabled: true, loading: true };
      if (step === "executing") return { text: relayerAvailable ? "3/3: Sign & swap..." : "3/3: Swapping...", disabled: true, loading: true };
      return { text: "Executing Swap...", disabled: true, loading: true };
    }
    if (swapStep === "complete") {
      return {
        text: isSell ? "Sell complete" : "Buy complete",
        disabled: true,
        success: true,
      };
    }
    if (isLoading) {
      return { text: "Processing...", disabled: true, loading: true };
    }
    return {
      text: isSell
        ? `Sell ${baseSymbol} for ${quoteSymbol}`
        : `Buy ${baseSymbol} with ${quoteSymbol}`,
      disabled: false,
    };
  };

  const buttonConfig = getButtonConfig();

  const setDirection = (sell: boolean) => {
    if (sell === isSell) return;
    handleSwapDirection();
  };

  const tradeSummary =
    inputAmount && parseFloat(inputAmount) > 0
      ? isSell
        ? `Sell ${inputAmount} ${baseSymbol} → ~${outputAmount || "…"} ${quoteSymbol}`
        : `Spend ${inputAmount} ${quoteSymbol} → ~${outputAmount || "…"} ${baseSymbol}`
      : null;

  const hasBaseBalance = hasBalance(baseToken?.address);
  const hasUsdcBalance = hasBalance(usdc?.address);
  const vaultPay = payBalance
    ? payBalance
    : (isSell ? hasBaseBalance : hasUsdcBalance)
      ? "••••"
      : "0";
  const vaultRecv = receiveBalance
    ? receiveBalance
    : (isSell ? hasUsdcBalance : hasBaseBalance)
      ? "••••"
      : "0";

  // Inline base-token selector (used in whichever leg is the base side)
  const baseSelector = (
    <TokenSelector
      tokens={tradableTokens}
      selected={baseToken}
      onSelect={handleSelectBase}
      variant="inline"
      ariaLabel="Select base token"
    />
  );

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="mb-8 flex items-end justify-between gap-4">
        <div>
          <p className="font-display text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-ink-400">
            Trade
          </p>
          <h2 className="font-display mt-2 text-[clamp(2rem,5vw,2.6rem)] font-bold leading-[0.92] tracking-[-0.045em] text-ink-900">
            {isSell ? (
              <>
                Sell <span className="text-brand-700">{baseSymbol}</span>
              </>
            ) : (
              <>
                Buy <span className="text-brand-700">{baseSymbol}</span>
              </>
            )}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setShowSettings(!showSettings)}
          className="mb-1 font-sans text-xs text-ink-400 underline-offset-4 transition hover:text-ink-700 hover:underline"
        >
          Slip {slippage}%
        </button>
      </div>

      <div className="mb-8 flex items-end justify-between gap-4 border-b border-ink-200/80">
        <div className="flex gap-8">
          <button
            type="button"
            onClick={() => setDirection(true)}
            className={cn(
              "font-display -mb-px pb-3 text-lg font-bold tracking-[-0.03em] transition-colors",
              isSell
                ? "border-b-2 border-ink-900 text-ink-900"
                : "text-ink-300 hover:text-ink-600"
            )}
          >
            Sell
          </button>
          <button
            type="button"
            onClick={() => setDirection(false)}
            className={cn(
              "font-display -mb-px pb-3 text-lg font-bold tracking-[-0.03em] transition-colors",
              !isSell
                ? "border-b-2 border-ink-900 text-ink-900"
                : "text-ink-300 hover:text-ink-600"
            )}
          >
            Buy
          </button>
        </div>
        {/* Pair selector */}
        <div className="mb-2 flex items-center gap-1.5">
          {baseSelector}
          <span className="font-sans text-xs text-ink-400">/ {quoteSymbol}</span>
        </div>
      </div>

      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="mb-6 overflow-hidden"
          >
            <div className="flex items-center gap-3">
              <span className="font-sans text-xs text-ink-500">Max slippage</span>
              <div className="flex gap-2">
                {SLIPPAGE_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setSlippage(option)}
                    className={cn(
                      "font-amount rounded-full px-3 py-1 text-sm font-semibold transition-colors",
                      slippage === option
                        ? "bg-ink-900 text-white"
                        : "bg-ink-100 text-ink-600 hover:bg-ink-200"
                    )}
                  >
                    {option}%
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div>
        <TokenInput
          label="From vault"
          symbol={isSell ? baseSymbol : quoteSymbol}
          amount={inputAmount}
          usdValue={inputUsd}
          balance={vaultPay}
          onChange={setInputAmount}
          emphasis="pay"
        />

        <div className="relative my-1 flex items-center gap-3 py-2">
          <div className="h-px flex-1 bg-ink-200/70" />
          <button
            type="button"
            aria-label="Invert sell / buy"
            onClick={(e) => {
              e.preventDefault();
              handleSwapDirection();
            }}
            className="font-display flex h-9 w-9 items-center justify-center rounded-full border border-ink-200 bg-[hsl(var(--background))] text-ink-600 transition hover:border-brand-400 hover:text-brand-700"
          >
            <ArrowDownUp className="h-3.5 w-3.5" />
          </button>
          <div className="h-px flex-1 bg-ink-200/70" />
        </div>

        <TokenInput
          label="You receive"
          symbol={isSell ? quoteSymbol : baseSymbol}
          amount={outputAmount}
          usdValue={outputUsd}
          balance={vaultRecv}
          readOnly
          isLoading={isLoadingQuote && inputAmount !== ""}
          emphasis="receive"
        />
      </div>

      <div className="mt-8 flex flex-wrap items-baseline justify-between gap-2 border-t border-ink-200/70 pt-5">
        <p className="font-display text-base font-bold tracking-[-0.03em] text-ink-900">
          {tradeSummary ?? (isSell ? `${baseSymbol} → ${quoteSymbol}` : `${quoteSymbol} → ${baseSymbol}`)}
        </p>
        <p className="font-amount text-sm font-semibold text-ink-500">
          1 {baseSymbol} = {formatUsd(basePrice)}
          {inputAmount && parseFloat(inputAmount) > 0 && (
            <span className={cn("ml-2 font-sans text-xs font-medium", getPriceImpactColor(priceImpact))}>
              · {isLoadingQuote ? "…" : `${priceImpact.toFixed(2)}%`}
            </span>
          )}
        </p>
      </div>
      {!isSell && buyBlockReason && (
        <p className="mt-2 flex gap-2 font-sans text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{buyBlockReason}</span>
        </p>
      )}
      {!isSell && !buyBlockReason && buyWarning && (
        <p className="mt-2 flex gap-2 font-sans text-xs text-amber-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{buyWarning}</span>
        </p>
      )}
      {!isSell && !buyBlockReason && !buyWarning && priceImpact > 25 && inputAmount && parseFloat(inputAmount) > 0 && (
        <p className="mt-2 font-sans text-xs text-amber-700">
          High price impact on Sepolia Uniswap — receive amount uses the live pool quote.
        </p>
      )}
      {(swapError || pendingOrderIds.length > 0) && (
        <div className="mt-3 flex flex-col gap-2 rounded-xl border border-amber-300/80 bg-amber-50 px-3 py-3">
          {swapError && (
            <p className="font-sans text-xs text-ink-700">{swapError}</p>
          )}
          {pendingOrderIds.length > 0 && (
            <>
              <p className="font-sans text-xs font-semibold text-amber-900">
                Stuck pending swap{pendingOrderIds.length > 1 ? "s" : ""} — cancel to unlock {quoteSymbol}
              </p>
              {pendingOrderIds.map((id) => (
                <button
                  key={id.toString()}
                  type="button"
                  onClick={() => handleCancelPending(id)}
                  disabled={isCancelling}
                  className="font-display rounded-xl bg-ink-900 px-3 py-2 text-left text-sm font-bold text-white transition hover:bg-ink-800 disabled:opacity-50"
                >
                  {cancellingId === id
                    ? `Cancelling #${id.toString()}…`
                    : `Cancel order #${id.toString()}`}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between font-sans text-[0.7rem] text-ink-400">
        <span>
          <span
            className={cn(
              "mr-1.5 inline-block h-1.5 w-1.5 rounded-full",
              relayerAvailable ? "bg-brand-600" : "bg-amber-500"
            )}
          />
          {relayerAvailable ? "Private relay" : "Direct mode"}
        </span>
        <button
          type="button"
          onClick={() => setShowMev((v) => !v)}
          className="inline-flex items-center gap-1 hover:text-ink-700"
        >
          RPC
          <ChevronDown className={cn("h-3 w-3 transition-transform", showMev && "rotate-180")} />
        </button>
      </div>

      <AnimatePresence>
        {showMev && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="mt-3 overflow-hidden"
          >
            <MevProtectionCheck onRpcChecked={handleRpcChecked} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {swapStep === "executing" && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-6"
          >
            <p className="font-display text-sm font-bold text-ink-800">
              Private swap in progress
            </p>
            <div className="mt-3 flex gap-6">
              {["Request", "Decrypt", "Execute"].map((step, i) => {
                const stepNames = ["requesting", "decrypting", "executing"];
                const currentStepIndex = stepNames.indexOf(swapState.step);
                const isActive = currentStepIndex === i;
                const isComplete = currentStepIndex > i;
                return (
                  <div key={step} className="flex items-center gap-2">
                    {isComplete ? (
                      <CheckCircle className="h-3.5 w-3.5 text-brand-600" />
                    ) : isActive ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-700" />
                    ) : (
                      <span className="font-amount text-xs text-ink-300">{i + 1}</span>
                    )}
                    <span
                      className={cn(
                        "font-sans text-xs",
                        isActive || isComplete ? "text-ink-800" : "text-ink-300"
                      )}
                    >
                      {step}
                    </span>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-8">
        {buttonConfig.showConnect ? (
          <ConnectButton.Custom>
            {({ openConnectModal }) => (
              <button
                type="button"
                onClick={openConnectModal}
                className="font-display w-full rounded-2xl bg-ink-900 px-6 py-4 text-lg font-bold tracking-[-0.03em] text-white transition hover:bg-ink-800 active:scale-[0.99]"
              >
                Connect wallet
              </button>
            )}
          </ConnectButton.Custom>
        ) : (
          <button
            type="button"
            disabled={buttonConfig.disabled}
            onClick={handleSwap}
            className={cn(
              "font-display w-full rounded-2xl px-6 py-4 text-lg font-bold tracking-[-0.03em] transition active:scale-[0.99]",
              buttonConfig.success
                ? "bg-brand-700 text-white"
                : buttonConfig.disabled
                  ? "bg-ink-100 text-ink-400"
                  : "bg-ink-900 text-white hover:bg-ink-800"
            )}
          >
            {buttonConfig.loading ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {buttonConfig.text}
              </span>
            ) : (
              buttonConfig.text
            )}
          </button>
        )}
      </div>
    </div>
  );
}
