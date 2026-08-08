/**
 * useActivityFeed Hook
 *
 * Merges:
 * 1. The Graph subgraph (deposits / withdrawals) when NEXT_PUBLIC_SUBGRAPH_URL is set
 * 2. On-chain deposits (ETHDeposited / USDTDeposited logs)
 * 3. On-chain withdrawals (withdrawalRequests scan)
 * 4. On-chain orders via getMyOrder (subgraph orders are anonymous — no trader field)
 *
 * Subgraph often lags, 404s, or stays on an old vault after redeploy —
 * on-chain fallback keeps deposits + orders + Execute / Cancel visible.
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useQuery } from "@apollo/client/react";
import { formatEther, formatUnits, parseAbiItem } from "viem";
import { GET_USER_ACTIVITY } from "@/lib/graphql/queries";
import { useContractAddresses } from "@/lib/wagmi";
import { NoctisExchangeABI, NoctisVaultABI } from "@/lib/contracts/abi";

/** Vault deploy block on Sepolia (from deployments / subgraph.yaml). */
const VAULT_START_BLOCK = 11445821n;

/** OrderStatus: Pending=0, PendingSwap=1, Filled=2, Cancelled=3 */
const ORDER_STATUS_FILLED = 2;
const ORDER_STATUS_CANCELLED = 3;
const ORDER_STATUS_PENDING_SWAP = 1;

const ETH_DEPOSITED_EVENT = parseAbiItem(
  "event ETHDeposited(address indexed user)"
);
const USDT_DEPOSITED_EVENT = parseAbiItem(
  "event USDTDeposited(address indexed user)"
);
const ERC20_TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);
/** Clear amount is public once executed (privacy boundary ends at claim). */
const WITHDRAWAL_EXECUTED_EVENT = parseAbiItem(
  "event WithdrawalExecuted(uint256 indexed requestId, address recipient, uint256 amount)"
);

// Activity types
export type ActivityType = "order" | "deposit" | "withdrawal";
export type ActivityStatus = "pending" | "confirming" | "success" | "failed";

export interface Activity {
  id: string;
  type: ActivityType;
  status: ActivityStatus;
  description: string;
  timestamp: Date;
  amount?: string;
  token?: string;
  /** Effective fill price label e.g. "$2,041" (after Reveal trades). */
  priceLabel?: string;
  txHash?: string;
  blockNumber?: bigint;
  /** Exchange order id (for private userDecrypt history). */
  orderId?: string;
  isBuy?: boolean;
}

interface UseActivityFeedReturn {
  activities: Activity[];
  isLoading: boolean;
  error: string | null;
  refetch: (options?: { fetchPolicy?: string }) => void;
}

// GraphQL response type
interface GraphQLResponse {
  deposits?: Array<{
    id: string;
    token: string;
    amount: string;
    timestamp: string;
    txHash: string;
  }>;
  withdrawals?: Array<{
    id: string;
    token: string;
    amount: string;
    timestamp: string;
    txHash: string;
    status: string;
  }>;
  orders?: Array<{
    id: string;
    isBuy: boolean;
    status: string;
    createdAt: string;
    filledAt?: string;
    createdTxHash: string;
    filledTxHash?: string;
  }>;
}

function parseDeposit(deposit: any): Activity {
  return {
    id: deposit.id,
    type: "deposit",
    status: "success",
    description: `Deposit ${deposit.token}`,
    timestamp: new Date(Number(deposit.timestamp) * 1000),
    amount: deposit.amountFormatted,
    token: deposit.token,
    txHash: deposit.transactionHash,
  };
}

function parseWithdrawal(withdrawal: any): Activity {
  let description = "Withdrawal Request";
  let status: ActivityStatus = "pending";
  let amount = "🔒";

  if (withdrawal.status === "PENDING") {
    description = "Withdrawal Processing";
    status = "pending";
    amount = "🔒";
  } else if (withdrawal.status === "COMPLETED") {
    description = "Withdrawal Completed";
    status = "success";
    amount = withdrawal.amountFormatted || "🔒";
  } else if (withdrawal.status === "CANCELLED") {
    description = "Withdrawal Cancelled";
    status = "failed";
    amount = "🔒";
  }

  return {
    id: withdrawal.id,
    type: "withdrawal",
    status,
    description,
    timestamp: new Date(Number(withdrawal.timestamp) * 1000),
    amount,
    token: withdrawal.token || (withdrawal.isEth ? "ETH" : "USDC"),
    txHash: withdrawal.transactionHash,
  };
}

function parseOrder(order: any): Activity {
  const direction = order.isBuy ? "Buy ETH" : "Sell ETH";

  let status: ActivityStatus = "pending";
  let description = `${direction} Order`;

  if (order.status === "FILLED") {
    status = "success";
    description = `${direction} Filled`;
  } else if (order.status === "CANCELLED") {
    status = "failed";
    description = `${direction} Cancelled`;
  }

  const orderId = String(order.orderId ?? order.id);
  return {
    id: order.id,
    type: "order",
    status,
    description,
    timestamp: new Date(Number(order.filledAt || order.createdAt) * 1000),
    amount: "🔒",
    token: "Private",
    txHash: order.filledTxHash || order.createdTxHash,
    orderId,
    isBuy: Boolean(order.isBuy),
  };
}

function normalizeWithdrawalId(id: string): string {
  if (id.startsWith("withdrawal-")) return id;
  return `withdrawal-${id}`;
}

/**
 * Scan vault deposit events for this user when The Graph is down / empty.
 */
async function fetchOnChainDeposits(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  vaultAddress: `0x${string}`,
  userAddress: `0x${string}`,
  usdtAddress?: `0x${string}`
): Promise<Activity[]> {
  const latest = await publicClient.getBlockNumber();
  const fromBlock =
    latest > VAULT_START_BLOCK ? VAULT_START_BLOCK : 0n;

  const [ethLogs, usdtLogs] = await Promise.all([
    publicClient.getLogs({
      address: vaultAddress,
      event: ETH_DEPOSITED_EVENT,
      args: { user: userAddress },
      fromBlock,
      toBlock: latest,
    }),
    publicClient.getLogs({
      address: vaultAddress,
      event: USDT_DEPOSITED_EVENT,
      args: { user: userAddress },
      fromBlock,
      toBlock: latest,
    }),
  ]);

  const activities: Activity[] = [];

  for (const log of ethLogs) {
    const [tx, block] = await Promise.all([
      publicClient.getTransaction({ hash: log.transactionHash }),
      publicClient.getBlock({ blockNumber: log.blockNumber }),
    ]);
    const amount = formatEther(tx.value);
    activities.push({
      id: `deposit-eth-${log.transactionHash}-${log.logIndex}`,
      type: "deposit",
      status: "success",
      description: "Deposit ETH",
      timestamp: new Date(Number(block.timestamp) * 1000),
      amount,
      token: "ETH",
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
    });
  }

  for (const log of usdtLogs) {
    const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
    let amount: string | undefined;
    if (usdtAddress) {
      try {
        const transfers = await publicClient.getLogs({
          address: usdtAddress,
          event: ERC20_TRANSFER_EVENT,
          args: { from: userAddress, to: vaultAddress },
          fromBlock: log.blockNumber,
          toBlock: log.blockNumber,
        });
        const match = transfers.find(
          (t) => t.transactionHash === log.transactionHash
        );
        if (match?.args?.value != null) {
          amount = formatUnits(match.args.value as bigint, 6);
        }
      } catch {
        // Privacy-safe fallback: show deposit without amount
      }
    }
    activities.push({
      id: `deposit-usdc-${log.transactionHash}-${log.logIndex}`,
      type: "deposit",
      status: "success",
      description: "Deposit USDC",
      timestamp: new Date(Number(block.timestamp) * 1000),
      amount: amount ?? "🔒",
      token: "USDC",
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
    });
  }

  return activities;
}

/**
 * Scan recent withdrawalRequests for this user (pending + settled).
 * Needed when The Graph is empty after redeploy — otherwise Execute success
 * drops pendingCount to 0 and the row vanishes from Activity.
 */
async function fetchOnChainWithdrawals(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  vaultAddress: `0x${string}`,
  userAddress: `0x${string}`
): Promise<Activity[]> {
  const counter = (await publicClient.readContract({
    address: vaultAddress,
    abi: NoctisVaultABI,
    functionName: "withdrawalCounter",
  })) as bigint;

  if (counter === 0n) return [];

  const latest = await publicClient.getBlockNumber();
  const fromBlock =
    latest > VAULT_START_BLOCK ? VAULT_START_BLOCK : 0n;

  // Executed amounts are clear on-chain — map requestId → amount for completed rows.
  // `recipient` is not indexed on WithdrawalExecuted, so filter client-side.
  const executedAmountById = new Map<string, bigint>();
  try {
    const executedLogs = await publicClient.getLogs({
      address: vaultAddress,
      event: WITHDRAWAL_EXECUTED_EVENT,
      fromBlock,
      toBlock: latest,
    });
    const user = userAddress.toLowerCase();
    for (const log of executedLogs) {
      const recipient = String(log.args.recipient ?? "").toLowerCase();
      if (recipient !== user) continue;
      const rid = log.args.requestId;
      const amt = log.args.amount;
      if (rid != null && amt != null) {
        executedAmountById.set(rid.toString(), amt as bigint);
      }
    }
  } catch {
    // Fall back to 🔒 for completed rows if log scan fails
  }

  const found: Activity[] = [];
  const maxScan = Math.min(Number(counter), 100);
  const user = userAddress.toLowerCase();

  for (let id = maxScan; id >= 1; id--) {
    const request = (await publicClient.readContract({
      address: vaultAddress,
      abi: NoctisVaultABI,
      functionName: "withdrawalRequests",
      args: [BigInt(id)],
    })) as any;

    const requestId = BigInt(request.requestId ?? request[0] ?? 0);
    if (requestId === 0n) continue;

    const requester = String(request.requester ?? request[1] ?? "").toLowerCase();
    if (requester !== user) continue;

    const executed = Boolean(request.executed ?? request[9]);
    const gatewayRequested = Boolean(request.gatewayRequested ?? request[11]);
    const isEth = Boolean(request.isEth ?? request[7]);
    const requestTime = Number(request.requestTime ?? request[8] ?? 0);
    const token = isEth ? "ETH" : "USDC";

    let status: ActivityStatus = "pending";
    let description = "Withdrawal Processing";
    // Pending/confirming: amount still encrypted → padlock. Completed: show clear amount.
    let amount = "🔒";

    if (executed) {
      status = "success";
      description = "Withdrawal Completed";
      const clear = executedAmountById.get(String(id));
      if (clear != null) {
        amount = isEth ? formatEther(clear) : formatUnits(clear, 6);
      }
    } else if (gatewayRequested) {
      status = "confirming";
      description = "Withdrawal Executing";
    }

    found.push({
      id: `withdrawal-${id}`,
      type: "withdrawal",
      status,
      description,
      timestamp: new Date((requestTime || Math.floor(Date.now() / 1000)) * 1000),
      amount,
      token,
    });
  }

  return found;
}

/**
 * Load this wallet's orders. Subgraph cannot filter by trader (privacy-first schema).
 * Probe getMyOrder(orderId) with eth_call from=user — reverts if not owner.
 */
async function fetchOnChainOrders(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  exchangeAddress: `0x${string}`,
  userAddress: `0x${string}`
): Promise<Activity[]> {
  const counter = (await publicClient.readContract({
    address: exchangeAddress,
    abi: NoctisExchangeABI,
    functionName: "orderCounter",
  })) as bigint;

  if (counter === 0n) return [];

  const maxScan = Math.min(Number(counter), 80);
  const start = Math.max(1, Number(counter) - maxScan + 1);
  const found: Activity[] = [];

  const probes = await Promise.all(
    Array.from({ length: Number(counter) - start + 1 }, (_, i) => {
      const id = BigInt(start + i);
      return publicClient
        .readContract({
          address: exchangeAddress,
          abi: NoctisExchangeABI,
          functionName: "getMyOrder",
          args: [id],
          account: userAddress,
        })
        .then((order) => ({ id, order: order as any }))
        .catch(() => null);
    })
  );

  for (const hit of probes) {
    if (!hit?.order) continue;
    const order = hit.order;
    const orderId = String(order.orderId ?? hit.id);
    const isBuy = Boolean(order.isBuy);
    const statusRaw = Number(order.status ?? 0);
    const ts = Number(order.timestamp ?? 0);
    const direction = isBuy ? "Buy ETH" : "Sell ETH";

    let status: ActivityStatus = "pending";
    let description = `${direction} Order`;
    if (statusRaw === ORDER_STATUS_FILLED) {
      status = "success";
      description = `${direction} Filled`;
    } else if (statusRaw === ORDER_STATUS_CANCELLED) {
      status = "failed";
      description = `${direction} Cancelled`;
    } else if (statusRaw === ORDER_STATUS_PENDING_SWAP) {
      status = "confirming";
      description = `${direction} Executing`;
    }

    found.push({
      id: `order-${orderId}`,
      type: "order",
      status,
      description,
      timestamp: new Date((ts || Math.floor(Date.now() / 1000)) * 1000),
      amount: "🔒",
      token: "Private",
      orderId,
      isBuy,
    });
  }

  return found;
}

export function useActivityFeed(): UseActivityFeedReturn {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const contracts = useContractAddresses();

  const subgraphConfigured =
    typeof window !== "undefined" && !!process.env.NEXT_PUBLIC_SUBGRAPH_URL;

  const { data, loading, error, refetch } = useQuery<GraphQLResponse>(GET_USER_ACTIVITY, {
    variables: {
      user: address?.toLowerCase() || "",
    },
    skip: !isConnected || !address || !subgraphConfigured,
    fetchPolicy: "cache-and-network",
    pollInterval: subgraphConfigured ? 10000 : 0,
  });

  const [activities, setActivities] = useState<Activity[]>([]);
  const [onChainLoading, setOnChainLoading] = useState(false);
  const [onChainTick, setOnChainTick] = useState(0);

  const mergeActivities = useCallback(
    async (graphData: GraphQLResponse | undefined) => {
      const fromGraph: Activity[] = [];

      if (graphData?.deposits) {
        for (const deposit of graphData.deposits) {
          fromGraph.push(parseDeposit(deposit));
        }
      }
      if (graphData?.withdrawals) {
        for (const withdrawal of graphData.withdrawals) {
          fromGraph.push(parseWithdrawal(withdrawal));
        }
      }
      let onChainDeposits: Activity[] = [];
      let onChainWithdrawals: Activity[] = [];
      let onChainOrders: Activity[] = [];
      if (isConnected && address && publicClient && contracts?.vaultAddress) {
        setOnChainLoading(true);
        try {
          const vault = contracts.vaultAddress as `0x${string}`;
          const user = address as `0x${string}`;
          const usdt = contracts.usdtAddress as `0x${string}` | undefined;
          const exchange = contracts.exchangeAddress as `0x${string}` | undefined;
          const tasks: Promise<Activity[]>[] = [
            fetchOnChainDeposits(publicClient, vault, user, usdt),
            fetchOnChainWithdrawals(publicClient, vault, user),
          ];
          if (exchange) {
            tasks.push(fetchOnChainOrders(publicClient, exchange, user));
          }
          const results = await Promise.all(tasks);
          onChainDeposits = results[0];
          onChainWithdrawals = results[1];
          onChainOrders = results[2] ?? [];
        } catch (err) {
          console.warn("On-chain activity scan failed:", err);
        } finally {
          setOnChainLoading(false);
        }
      }

      // On-chain wins over subgraph for same tx / withdrawal id (fresher after redeploy)
      const onChainWithdrawalIds = new Set(
        onChainWithdrawals.map((a) => normalizeWithdrawalId(a.id))
      );
      const onChainDepositTx = new Set(
        onChainDeposits.map((a) => (a.txHash || "").toLowerCase()).filter(Boolean)
      );
      const onChainOrderIds = new Set(
        onChainOrders.map((a) => a.orderId || a.id).filter(Boolean)
      );

      const merged = [
        ...onChainDeposits,
        ...onChainWithdrawals,
        ...onChainOrders,
        ...fromGraph.filter((a) => {
          if (a.type === "withdrawal") {
            return !onChainWithdrawalIds.has(normalizeWithdrawalId(a.id));
          }
          if (a.type === "deposit" && a.txHash) {
            return !onChainDepositTx.has(a.txHash.toLowerCase());
          }
          if (a.type === "order" && a.orderId) {
            return !onChainOrderIds.has(a.orderId);
          }
          return true;
        }),
      ];

      const seen = new Set<string>();
      const unique = merged.filter((a) => {
        const key =
          a.type === "withdrawal"
            ? normalizeWithdrawalId(a.id)
            : a.type === "deposit" && a.txHash
              ? `deposit-${a.txHash.toLowerCase()}`
              : a.type === "order" && a.orderId
                ? `order-${a.orderId}`
                : a.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      unique.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      if (process.env.NODE_ENV === "development") {
        console.log(
          `📊 Activity: graph=${fromGraph.length}, deposits=${onChainDeposits.length}, withdrawals=${onChainWithdrawals.length}, orders=${onChainOrders.length}, merged=${unique.length}`
        );
      }

      setActivities(unique);
    },
    [
      address,
      contracts?.usdtAddress,
      contracts?.vaultAddress,
      contracts?.exchangeAddress,
      isConnected,
      publicClient,
    ]
  );

  useEffect(() => {
    if (!isConnected || !address) {
      setActivities([]);
      return;
    }
    void mergeActivities(data);
  }, [data, isConnected, address, mergeActivities, onChainTick]);

  // Poll on-chain pending even when subgraph is missing / empty
  useEffect(() => {
    if (!isConnected || !address) return;
    const id = setInterval(() => setOnChainTick((t) => t + 1), 15000);
    const onRefresh = () => setOnChainTick((t) => t + 1);
    window.addEventListener("noctis:refresh-activity", onRefresh);
    window.addEventListener("noctis:refresh-balance", onRefresh);
    window.addEventListener("noctis:transaction-success", onRefresh);
    return () => {
      clearInterval(id);
      window.removeEventListener("noctis:refresh-activity", onRefresh);
      window.removeEventListener("noctis:refresh-balance", onRefresh);
      window.removeEventListener("noctis:transaction-success", onRefresh);
    };
  }, [isConnected, address]);

  const handleRefetch = useCallback(
    (_options?: { fetchPolicy?: string }) => {
      if (subgraphConfigured) {
        refetch();
      }
      setOnChainTick((t) => t + 1);
    },
    [refetch, subgraphConfigured]
  );

  const showGraphError = Boolean(error && subgraphConfigured && activities.length === 0);

  return {
    activities,
    isLoading: (loading || onChainLoading) && activities.length === 0,
    error: showGraphError ? "Failed to load activities from The Graph" : null,
    refetch: handleRefetch,
  };
}
