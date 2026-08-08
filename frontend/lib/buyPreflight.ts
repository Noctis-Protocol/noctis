/**
 * BUY preflight — oracle-size the encrypted ETH leg (so on-chain USDC debit ≈
 * what the user typed) and warn when Uniswap spot is far below Chainlink.
 * Exchange BUY floor is min(oracle, pool), so thin Sepolia pools can settle.
 */

import type { PublicClient } from "viem";

const UNISWAP_V2_ROUTER = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008" as const;
const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9" as const;
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
const ETH_USD_FEED = "0x694AA1769357215DE4FAC081bf1f309aDC325306" as const;

export const MAX_MARKET_ORDER_SLIPPAGE_BPS = 300;

const ROUTER_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

const FEED_ABI = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

export type BuyPreflightResult =
  | {
      ok: true;
      /** Encrypted ETH leg — oracle-sized so USDC debit ≈ user input */
      amountETH: bigint;
      poolEthOut: bigint;
      oracleEthFair: bigint;
      usdtNeeded: bigint;
      gapBps: number;
      warning?: string;
    }
  | {
      ok: false;
      reason: string;
      poolEthOut?: bigint;
      oracleEthFair?: bigint;
      gapBps?: number;
    };

export async function buyPreflight(
  publicClient: PublicClient,
  usdcHuman: number,
  slippageBps: number
): Promise<BuyPreflightResult> {
  if (!Number.isFinite(usdcHuman) || usdcHuman <= 0) {
    return { ok: false, reason: "Enter USDC to spend" };
  }

  const slip = Math.min(
    Math.max(1, Math.round(slippageBps)),
    MAX_MARKET_ORDER_SLIPPAGE_BPS
  );
  const usdcIn = BigInt(Math.floor(usdcHuman * 1e6));

  let poolEthOut: bigint;
  try {
    const amounts = await publicClient.readContract({
      address: UNISWAP_V2_ROUTER,
      abi: ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [usdcIn, [USDC, WETH]],
    });
    poolEthOut = amounts[1] ?? 0n;
  } catch {
    return { ok: false, reason: "Uniswap quote failed — try again" };
  }
  if (poolEthOut <= 0n) {
    return { ok: false, reason: "Pool returned zero ETH for this size" };
  }

  let oraclePrice: bigint;
  try {
    const round = await publicClient.readContract({
      address: ETH_USD_FEED,
      abi: FEED_ABI,
      functionName: "latestRoundData",
    });
    if (round[1] <= 0n) {
      return { ok: false, reason: "Chainlink price unavailable" };
    }
    oraclePrice = round[1];
  } catch {
    return { ok: false, reason: "Chainlink price unavailable" };
  }

  // On-chain BUY debit: usdtNeeded ≈ amountETH * oracle / 1e20 * (1+slip)
  // Size amountETH so debit ≈ usdcIn (what the user typed).
  const amountETH = (usdcIn * 10n ** 20n) / oraclePrice;
  const usdtNeeded = (amountETH * oraclePrice) / 10n ** 20n;
  const usdtNeededWithSlip = (usdtNeeded * BigInt(10000 + slip)) / 10000n;
  const oracleEthFair = (usdtNeededWithSlip * 10n ** 20n) / oraclePrice;
  const oracleFloor = (oracleEthFair * BigInt(10000 - slip)) / 10000n;

  let gapBps = 0;
  let warning: string | undefined;
  if (oracleFloor > 0n && poolEthOut < oracleFloor) {
    gapBps = Number(((oracleFloor - poolEthOut) * 10000n) / oracleFloor);
    warning = `Sepolia pool is ~${(gapBps / 100).toFixed(1)}% below oracle — you receive Uniswap spot (~${(Number(poolEthOut) / 1e18).toFixed(6)} ETH), not Chainlink fair.`;
  }

  return {
    ok: true,
    amountETH,
    poolEthOut,
    oracleEthFair,
    usdtNeeded: usdtNeededWithSlip,
    gapBps,
    warning,
  };
}
