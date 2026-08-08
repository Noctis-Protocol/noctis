"use client";

/**
 * ActivityFeed Component
 * 
 * Right sidebar showing recent activity:
 * - Pending orders
 * - Recent deposits/withdrawals
 * - Filled orders
 * 
 * Connected to real on-chain events via useActivityFeed hook
 */

import { useAccount } from "wagmi";
import { 
  Clock, 
  CheckCircle2, 
  XCircle, 
  ArrowUpRight, 
  ArrowDownLeft,
  Loader2,
  ExternalLink,
  RefreshCw,
  Lock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  useActivityFeed,
  useNoctisVault,
  useWithdrawalStatus,
  useTradeHistoryDecryption,
  formatTimeRemaining,
  type ActivityType,
  type ActivityStatus,
} from "@/hooks";
import { getNetworkInfo } from "@/lib/env";
import { Button } from "@/components/ui/button";
import { useMemo, useState } from "react";

function getStatusIcon(status: ActivityStatus) {
  switch (status) {
    case "pending":
      return <Clock className="h-4 w-4 text-yellow-500" />;
    case "confirming":
      return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
    case "success":
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-red-500" />;
  }
}

function getTypeIcon(type: ActivityType) {
  switch (type) {
    case "order":
      return <ArrowUpRight className="h-4 w-4" />;
    case "deposit":
      return <ArrowDownLeft className="h-4 w-4 text-green-600" />;
    case "withdrawal":
      return <ArrowUpRight className="h-4 w-4 text-orange-600" />;
  }
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function ActivityFeed() {
  const { isConnected, chainId } = useAccount();
  const explorer = getNetworkInfo(chainId).explorer;
  const { activities, isLoading, error, refetch } = useActivityFeed();
  const { executeWithdrawal, cancelWithdrawal, isLoading: isExecuting } = useNoctisVault();
  // Keep row visible while Execute runs (multi-minute decrypt) and after success
  const [statusOverrides, setStatusOverrides] = useState<
    Record<string, { status: ActivityStatus; description: string }>
  >({});

  const orderIdsForDecrypt = useMemo(() => {
    return activities
      .filter((a) => a.type === "order" && a.orderId)
      .map((a) => a.orderId as string);
  }, [activities]);

  const {
    revealed: revealedTrades,
    isDecrypting: isDecryptingTrades,
    error: tradeDecryptError,
    canDecrypt: canDecryptTrades,
    pendingCount: encryptedTradeCount,
    decryptTrades,
  } = useTradeHistoryDecryption(orderIdsForDecrypt);

  const displayActivities = useMemo(() => {
    return activities.map((a) => {
      let row = a;
      const override = statusOverrides[a.id];
      if (override && a.status !== "success" && a.status !== "failed") {
        row = { ...a, ...override };
      }
      if (row.type === "order" && row.orderId && revealedTrades[row.orderId]) {
        const t = revealedTrades[row.orderId];
        row = {
          ...row,
          amount: t.displayAmount,
          token: t.displayToken,
          priceLabel: t.priceLabel,
          txHash: t.fillTxHash || row.txHash,
        };
      }
      return row;
    });
  }, [activities, statusOverrides, revealedTrades]);
  
  // Get pending withdrawal IDs to check their cancellation status
  const pendingWithdrawalIds = useMemo(() => {
    return displayActivities
      .filter(a => a.type === "withdrawal" && (a.status === "pending" || a.status === "confirming"))
      .map(a => a.id);
  }, [displayActivities]);
  
  // Fetch on-chain status for pending withdrawals
  const withdrawalStatuses = useWithdrawalStatus(pendingWithdrawalIds);

  const handleRevealTrades = () => {
    void decryptTrades(orderIdsForDecrypt);
  };
  
  const handleRefresh = () => {
    console.log("🔄 Manual refresh triggered - forcing network fetch");
    // Force refetch from network, bypassing Apollo cache completely
    refetch({ 
      fetchPolicy: "network-only" 
    } as any);
    // Also trigger balance refresh
    window.dispatchEvent(new CustomEvent("noctis:refresh-balance"));
  };

  // Handle execute withdrawal
  const handleExecuteWithdrawal = async (withdrawalId: string) => {
    try {
      // Extract the request ID from the withdrawal ID (format: "withdrawal-{requestId}")
      const requestId = withdrawalId.replace("withdrawal-", "");
      console.log("🔓 Executing withdrawal:", requestId);
      setStatusOverrides((prev) => ({
        ...prev,
        [withdrawalId]: {
          status: "confirming",
          description: "Withdrawal Executing",
        },
      }));
      const success = await executeWithdrawal(BigInt(requestId));
      if (success) {
        setStatusOverrides((prev) => ({
          ...prev,
          [withdrawalId]: {
            status: "success",
            description: "Withdrawal Completed",
          },
        }));
        handleRefresh();
      } else {
        setStatusOverrides((prev) => {
          const next = { ...prev };
          delete next[withdrawalId];
          return next;
        });
      }
    } catch (err) {
      console.error("Failed to execute withdrawal:", err);
      setStatusOverrides((prev) => {
        const next = { ...prev };
        delete next[withdrawalId];
        return next;
      });
    }
  };

  // Handle cancel withdrawal
  const handleCancelWithdrawal = async (withdrawalId: string) => {
    try {
      const requestId = withdrawalId.replace("withdrawal-", "");
      console.log("❌ Cancelling withdrawal:", requestId);
      const success = await cancelWithdrawal(BigInt(requestId));
      if (success) {
        setStatusOverrides((prev) => ({
          ...prev,
          [withdrawalId]: {
            status: "failed",
            description: "Withdrawal Cancelled",
          },
        }));
        handleRefresh();
      }
    } catch (err) {
      console.error("Failed to cancel withdrawal:", err);
    }
  };

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <p className="font-sans text-sm text-ink-500">Connect wallet to view activity</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-end gap-2">
        {encryptedTradeCount > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={handleRevealTrades}
            disabled={!canDecryptTrades && !isDecryptingTrades}
            title="Privately decrypt your trade sizes (FHE userDecrypt). Uniswap fills stay public on-chain."
          >
            {isDecryptingTrades ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Lock className="h-3 w-3" />
            )}
            {isDecryptingTrades
              ? "Decrypting…"
              : `Reveal trades (${encryptedTradeCount})`}
          </Button>
        )}
        <button
          onClick={handleRefresh}
          disabled={isLoading}
          className="rounded-md p-1.5 text-ink-400 transition-colors hover:text-ink-700 disabled:opacity-50"
          title="Refresh activity"
        >
          <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
        </button>
      </div>
      {tradeDecryptError && (
        <p className="mb-2 text-xs text-amber-700">{tradeDecryptError}</p>
      )}
      <div className="max-h-[600px] overflow-y-auto">
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-start gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-8">
            <XCircle className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        ) : displayActivities.length === 0 ? (
          <div className="text-center py-8">
            <Clock className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No activity yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Deposits and withdrawals load from the chain if the indexer is empty
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {displayActivities.map((activity) => (
              <div
                key={activity.id}
                className={cn(
                  "flex items-start gap-3 rounded-lg p-2 -mx-2 transition-colors hover:bg-muted/50",
                  (activity.status === "pending" || activity.status === "confirming") && "bg-yellow-50"
                )}
              >
                {/* Type icon */}
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                  {getTypeIcon(activity.type)}
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">
                      {activity.description}
                    </span>
                    {activity.type === "withdrawal" && activity.status === "confirming" && (
                      <div className="flex gap-1 items-center">
                        <Badge variant="warning" className="text-xs gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Decrypting…
                        </Badge>
                        {(() => {
                          const status = withdrawalStatuses.get(activity.id);
                          if (!status || status.isLoading || isExecuting) return null;
                          if (status.canCancel) {
                            return (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                                onClick={() => handleCancelWithdrawal(activity.id)}
                              >
                                Cancel
                              </Button>
                            );
                          }
                          return (
                            <span className="text-xs text-muted-foreground">
                              Cancel in {formatTimeRemaining(status.timeUntilCancellable)}
                            </span>
                          );
                        })()}
                      </div>
                    )}
                    {activity.status === "pending" && (
                      <>
                        {activity.type === "withdrawal" ? (
                          <div className="flex gap-1 items-center">
                            <Button
                              size="sm"
                              variant="default"
                              className="h-6 px-2 text-xs bg-green-600 hover:bg-green-700"
                              onClick={() => handleExecuteWithdrawal(activity.id)}
                              disabled={isExecuting}
                            >
                              {isExecuting ? (
                                <>
                                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                  ...
                                </>
                              ) : (
                                "Execute"
                              )}
                            </Button>
                            {(() => {
                              const status = withdrawalStatuses.get(activity.id);
                              if (!status || status.isLoading) {
                                return (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 px-2 text-xs text-gray-400"
                                    disabled
                                  >
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  </Button>
                                );
                              }
                              if (status.canCancel) {
                                return (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                                    onClick={() => handleCancelWithdrawal(activity.id)}
                                    disabled={isExecuting}
                                  >
                                    Cancel
                                  </Button>
                                );
                              }
                              // Show time remaining until cancellable
                              return (
                                <span className="text-xs text-muted-foreground" title="Wait for timeout to cancel">
                                  Cancel in {formatTimeRemaining(status.timeUntilCancellable)}
                                </span>
                              );
                            })()}
                          </div>
                        ) : (
                          <Badge variant="warning" className="text-xs">
                            Pending
                          </Badge>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                    {activity.amount && (
                      <>
                        <span className="font-amount text-xs text-ink-700">
                          {activity.token
                            ? `${activity.amount} ${activity.token}`
                            : activity.amount}
                        </span>
                        <span className="text-xs text-muted-foreground">•</span>
                      </>
                    )}
                    {activity.priceLabel && (
                      <>
                        <span
                          className="font-amount text-xs font-semibold text-ink-900"
                          title="Effective fill price (USDC per ETH)"
                        >
                          {activity.priceLabel}
                        </span>
                        <span className="text-xs text-muted-foreground">•</span>
                      </>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatTimeAgo(activity.timestamp)}
                    </span>
                    {activity.txHash && (
                      <>
                        <span className="text-xs text-muted-foreground">•</span>
                        <a
                          href={`${explorer}/tx/${activity.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-brand-500 hover:text-brand-600 flex items-center gap-0.5"
                        >
                          View
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </>
                    )}
                  </div>
                </div>

                {/* Status icon */}
                <div className="shrink-0">
                  {getStatusIcon(activity.status)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
