"use client";

/**
 * BalancePanel Component
 * 
 * Left sidebar showing:
 * - Encrypted balances (ETH or USDC via dropdown selector)
 * - Quick actions (Deposit, Withdraw)
 * - Private balance decryption via "Reveal Balance" button
 */

import { useState } from "react";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { Lock, RefreshCw } from "lucide-react";
import { useContractAddresses } from "@/lib/wagmi";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatEth } from "@/lib/utils";
import { useBalanceDecryption } from "@/hooks/useBalanceDecryption";
import { NoctisVaultABI } from "@/lib/contracts/abi";
import { useNoctisVault } from "@/hooks";

// Polling interval for balance updates (10 seconds)
const BALANCE_POLL_INTERVAL = 10_000;

// Token configuration for dynamic display
type TokenType = "ETH" | "USDC";

// Official ETH logo (diamond shape)
function EthLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="16" cy="16" r="16" fill="#627EEA"/>
      <path d="M16.498 4v8.87l7.497 3.35L16.498 4z" fill="#fff" fillOpacity=".602"/>
      <path d="M16.498 4L9 16.22l7.498-3.35V4z" fill="#fff"/>
      <path d="M16.498 21.968v6.027L24 17.616l-7.502 4.352z" fill="#fff" fillOpacity=".602"/>
      <path d="M16.498 27.995v-6.028L9 17.616l7.498 10.379z" fill="#fff"/>
      <path d="M16.498 20.573l7.497-4.353-7.497-3.348v7.701z" fill="#fff" fillOpacity=".2"/>
      <path d="M9 16.22l7.498 4.353v-7.701L9 16.22z" fill="#fff" fillOpacity=".602"/>
    </svg>
  );
}

// Official USDC/Circle logo from Wikimedia Commons
function UsdcLogo({ className }: { className?: string }) {
  return (
    <img 
      src="https://upload.wikimedia.org/wikipedia/commons/4/4a/Circle_USDC_Logo.svg"
      alt="USDC"
      className={className}
      style={{ width: '1em', height: '1em' }}
    />
  );
}

const TOKEN_CONFIG: Record<TokenType, {
  symbol: string;
  decimals: number;
  Logo: React.FC<{ className?: string }>;
}> = {
  ETH: {
    symbol: "ETH",
    decimals: 4,
    Logo: EthLogo,
  },
  USDC: {
    symbol: "USDC",
    decimals: 2,
    Logo: UsdcLogo,
  },
};

interface BalancePanelProps {
  onDeposit: () => void;
  onWithdraw: () => void;
}

export function BalancePanel({ onDeposit, onWithdraw }: BalancePanelProps) {
  const { address, isConnected } = useAccount();
  const [selectedToken, setSelectedToken] = useState<TokenType>("ETH");
  const contracts = useContractAddresses();
  const { claimETH, isLoading: isClaimLoading } = useNoctisVault();
  const { decrypted, decryptBalance, canDecrypt } = useBalanceDecryption();

  // Handle refresh balance button click
  const handleRefreshBalance = async () => {
    await decryptBalance(selectedToken as "ETH" | "USDC");
  };
  
  // Get wallet ETH balance with automatic polling
  const { data: ethBalance, isLoading: isLoadingEth } = useBalance({
    address,
    query: {
      // Poll every 10 seconds for balance updates
      refetchInterval: BALANCE_POLL_INTERVAL,
      // Also refetch when window regains focus
      refetchOnWindowFocus: true,
    },
  });

  // Get wallet USDC (ERC-20) balance with automatic polling
  const { data: usdcBalance, isLoading: isLoadingUsdc } = useBalance({
    address,
    token: contracts?.usdtAddress as `0x${string}` | undefined,
    query: {
      enabled: !!contracts?.usdtAddress,
      refetchInterval: BALANCE_POLL_INTERVAL,
      refetchOnWindowFocus: true,
    },
  });

  // Get claimable ETH balance
  const { data: claimableETHData, refetch: refetchClaimable } = useReadContract({
    address: contracts?.vaultAddress as `0x${string}` | undefined,
    abi: NoctisVaultABI,
    functionName: "getMyClaimableETH",
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

  // Get config and values for selected token
  const tokenConfig = TOKEN_CONFIG[selectedToken];

  // Get REAL decrypted balances via ZAMA Relayer SDK (private decryption)
  const decryptedETH = decrypted.eth?.formatted;
  const decryptedUSDC = decrypted.usdt?.formatted; // Note: internal name still 'usdt' for compatibility

  // Display decrypted balance or loading/zero
  const displayBalance = selectedToken === "ETH" ? decryptedETH : decryptedUSDC;
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

        <div className="mt-6 flex gap-6 border-b border-ink-200/80">
          {(Object.keys(TOKEN_CONFIG) as TokenType[]).map((token) => (
            <button
              key={token}
              type="button"
              onClick={() => setSelectedToken(token)}
              className={cn(
                "font-display -mb-px pb-2.5 text-base font-bold tracking-[-0.03em] transition-colors",
                selectedToken === token
                  ? "border-b-2 border-ink-900 text-ink-900"
                  : "text-ink-300 hover:text-ink-600"
              )}
            >
              {token}
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
              {displayBalance || (selectedToken === "ETH" ? "0.0000" : "0.00")}
              <span className="font-display ml-2 text-xl font-bold tracking-[-0.04em] text-ink-400">
                {tokenConfig.symbol}
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
            disabled={!canDecrypt || isDecrypting}
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
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-ink-500">
              <EthLogo className="h-4 w-4" /> ETH
            </span>
            {isLoadingEth ? (
              <Skeleton className="h-4 w-16" />
            ) : (
              <span className="font-amount font-semibold text-ink-800">
                {formatEth(ethBalance?.value || 0n)}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-ink-500">
              <UsdcLogo className="h-4 w-4" /> USDC
            </span>
            {isLoadingUsdc ? (
              <Skeleton className="h-4 w-16" />
            ) : (
              <span className="font-amount font-semibold text-ink-800">
                {usdcBalance ? (Number(usdcBalance.value) / 1e6).toFixed(2) : "0.00"}
              </span>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
