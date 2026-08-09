"use client";

/**
 * BalancePanel Component (V2 — multi-token)
 *
 * Left sidebar showing:
 * - Encrypted vault balances for every registered token (dynamic tabs)
 * - Quick actions (Deposit, Withdraw)
 * - Private balance decryption via "Reveal / refresh" button
 * - Wallet balances for the registered tokens
 */

import { useState } from "react";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { Lock, RefreshCw } from "lucide-react";
import { useContractAddresses } from "@/lib/wagmi";
import { Skeleton } from "@/components/ui/skeleton";
import { TokenLogo } from "@/components/ui/TokenSelector";
import { cn, formatEth } from "@/lib/utils";
import { useBalanceDecryption } from "@/hooks/useBalanceDecryption";
import {
  useTokenRegistry,
  formatTokenAmount,
  displayDecimalsFor,
  type TokenInfo,
} from "@/hooks/useTokenRegistry";
import { NoctisVaultABI } from "@/lib/contracts/abi";
import { useNoctisVault } from "@/hooks";

// Polling interval for balance updates (10 seconds)
const BALANCE_POLL_INTERVAL = 10_000;

interface BalancePanelProps {
  onDeposit: () => void;
  onWithdraw: () => void;
}

/** Wallet balance row (native or ERC-20) for a registered token. */
function WalletBalanceRow({ token }: { token: TokenInfo }) {
  const { address } = useAccount();
  const { data, isLoading } = useBalance({
    address,
    token: token.isNative ? undefined : token.address,
    query: {
      refetchInterval: BALANCE_POLL_INTERVAL,
      refetchOnWindowFocus: true,
    },
  });

  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-ink-500">
        <TokenLogo symbol={token.symbol} className="h-4 w-4" /> {token.symbol}
      </span>
      {isLoading ? (
        <Skeleton className="h-4 w-16" />
      ) : (
        <span className="font-amount font-semibold text-ink-800">
          {token.isNative
            ? formatEth(data?.value || 0n)
            : formatTokenAmount(data?.value ?? 0n, token.decimals, displayDecimalsFor(token))}
        </span>
      )}
    </div>
  );
}

export function BalancePanel({ onDeposit, onWithdraw }: BalancePanelProps) {
  const { address, isConnected } = useAccount();
  const contracts = useContractAddresses();
  const { supportedTokens } = useTokenRegistry();
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const { claimETH, isLoading: isClaimLoading } = useNoctisVault();
  const { decrypted, decryptBalance, balanceFor, canDecrypt } = useBalanceDecryption();

  // Default to the first registered token (native ETH sorts first)
  const selectedToken =
    supportedTokens.find(
      (t) => t.address.toLowerCase() === selectedAddress?.toLowerCase()
    ) ?? supportedTokens[0] ?? null;

  // Handle refresh balance button click
  const handleRefreshBalance = async () => {
    if (selectedToken) await decryptBalance(selectedToken);
  };

  // Get claimable ETH balance
  const { data: claimableETHData, refetch: refetchClaimable } = useReadContract({
    address: contracts?.vaultAddress as `0x${string}` | undefined,
    abi: NoctisVaultABI,
    functionName: "getMyClaimableETH",
    account: address,
    query: {
      enabled: !!address && !!contracts?.vaultAddress,
      refetchInterval: 10_000, // Poll every 10 seconds
    },
  });

  const claimableETH = claimableETHData ? Number(claimableETHData) / 1e18 : 0;

  // Handle claim ETH
  const handleClaimETH = async () => {
    const success = await claimETH();
    if (success) {
      // Refetch claimable balance after successful claim
      refetchClaimable();
    }
  };

  // Get REAL decrypted balance via ZAMA Relayer SDK (private decryption)
  const displayBalance = selectedToken
    ? balanceFor(selectedToken.address)?.formatted
    : undefined;
  const zeroPlaceholder = selectedToken
    ? (0).toFixed(displayDecimalsFor(selectedToken))
    : "0.00";
  const isDecrypting = decrypted.isDecrypting;
  const isSyncing = decrypted.isSyncing;
  const isNewDeposit = decrypted.isNewDeposit;

  if (!isConnected) {
    return (
      <aside className="py-8">
        <p className="font-display text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-ink-400">
          Vault
        </p>
        <p className="font-sans mt-4 text-sm text-ink-500">
          Connect wallet to view balances
        </p>
      </aside>
    );
  }

  return (
    <aside className="space-y-8">
      <div>
        <p className="font-display text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-ink-400">
          Vault
        </p>
        <h2 className="font-display mt-2 text-[clamp(1.75rem,3vw,2.1rem)] font-bold leading-[0.95] tracking-[-0.045em] text-ink-900">
          Balance
        </h2>

        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-1 border-b border-ink-200/80">
          {supportedTokens.map((token) => (
            <button
              key={token.address}
              type="button"
              onClick={() => setSelectedAddress(token.address)}
              className={cn(
                "font-display -mb-px pb-2.5 text-base font-bold tracking-[-0.03em] transition-colors",
                selectedToken?.address === token.address
                  ? "border-b-2 border-ink-900 text-ink-900"
                  : "text-ink-300 hover:text-ink-600"
              )}
            >
              {token.symbol}
            </button>
          ))}
        </div>

        <div className="mt-6">
          {isDecrypting ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-40" />
              <p className="font-sans text-xs text-ink-400">Decrypting…</p>
            </div>
          ) : (
            <p className="font-amount text-[2.5rem] leading-none text-ink-900 sm:text-[2.75rem]">
              {displayBalance || zeroPlaceholder}
              <span className="font-display ml-2 text-xl font-bold tracking-[-0.04em] text-ink-400">
                {selectedToken?.symbol ?? ""}
              </span>
            </p>
          )}
          {isSyncing && (
            <p className="mt-2 font-sans text-xs text-amber-600">
              {isNewDeposit ? "Indexing new deposit…" : "Syncing gateway…"}
            </p>
          )}
          {decrypted.error && !isDecrypting && !isSyncing && (
            <p className="mt-2 font-sans text-xs text-red-600">
              {decrypted.error}
            </p>
          )}
          <button
            type="button"
            onClick={handleRefreshBalance}
            disabled={!canDecrypt || isDecrypting || !selectedToken}
            className="mt-4 inline-flex items-center gap-2 font-sans text-xs text-ink-500 underline-offset-4 hover:text-ink-800 hover:underline disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isDecrypting ? "animate-spin" : ""}`} />
            Reveal / refresh
          </button>
          <p className="mt-3 flex items-center gap-1.5 font-sans text-[0.7rem] text-ink-400">
            <Lock className="h-3 w-3" />
            Encrypted with FHE
          </p>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onDeposit}
          className="font-display flex-1 rounded-2xl bg-ink-900 py-3 text-sm font-bold tracking-tight text-white transition hover:bg-ink-800"
        >
          Deposit
        </button>
        <button
          type="button"
          onClick={onWithdraw}
          className="font-display flex-1 rounded-2xl border border-ink-200 bg-transparent py-3 text-sm font-bold tracking-tight text-ink-800 transition hover:border-ink-400"
        >
          Withdraw
        </button>
      </div>

      {claimableETH > 0 && (
        <div className="border-t border-ink-200/70 pt-6">
          <p className="font-display text-sm font-bold text-brand-700">Ready to claim</p>
          <p className="font-amount mt-2 text-2xl font-bold text-ink-900">
            {claimableETH.toFixed(4)} ETH
          </p>
          <button
            type="button"
            onClick={handleClaimETH}
            disabled={isClaimLoading}
            className="mt-3 font-display text-sm font-bold text-brand-700 underline-offset-4 hover:underline disabled:opacity-50"
          >
            {isClaimLoading ? "Claiming…" : "Claim ETH"}
          </button>
        </div>
      )}

      <div className="border-t border-ink-200/70 pt-6">
        <p className="font-display text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-ink-400">
          Wallet
        </p>
        <div className="mt-3 space-y-2 font-sans text-sm">
          {supportedTokens.map((token) => (
            <WalletBalanceRow key={token.address} token={token} />
          ))}
        </div>
      </div>
    </aside>
  );
}
