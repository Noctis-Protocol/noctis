"use client";

/**
 * Noctis desk — one composition: brand + swap + compact vault actions.
 * Activity sits below the fold (not a three-column dashboard).
 */

import { useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { sepolia } from "wagmi/chains";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { BalancePanel } from "@/components/layout/BalancePanel";
import { ActivityFeed } from "@/components/layout/ActivityFeed";
import { SwapCard } from "@/components/swap/SwapCard";
import { PairMarketPanel } from "@/components/market/PairMarketPanel";
import { DepositModal } from "@/components/vault/DepositModal";
import { WithdrawModal } from "@/components/vault/WithdrawModal";
import { UniswapPairLiveProvider } from "@/hooks/useUniswapPairLive";
import { getDeskNetwork } from "@/lib/networks";
import { useContractAddresses } from "@/lib/wagmi";

export default function Home() {
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const contracts = useContractAddresses();
  const deskNet = getDeskNetwork(chainId);
  const wrongOrUnready =
    isConnected &&
    (!deskNet || !deskNet.live || !contracts.configured);

  return (
    <div className="relative flex min-h-screen flex-col">
      <Header />

      <main className="relative z-10 flex-1 px-5 pb-16 pt-10 sm:pt-14">
        <div className="mx-auto max-w-6xl">
          {wrongOrUnready && (
            <div className="mb-8 rounded-2xl border border-amber-200 bg-amber-50/90 px-5 py-4 text-sm text-amber-950 animate-fade-up">
              {!deskNet ? (
                <p>
                  Unsupported network. Switch to{" "}
                  <button
                    type="button"
                    className="font-semibold underline underline-offset-2"
                    onClick={() => switchChain?.({ chainId: sepolia.id })}
                  >
                    Sepolia
                  </button>{" "}
                  to use the live desk.
                </p>
              ) : !deskNet.live || !contracts.configured ? (
                <p>
                  <span className="font-display font-bold">{deskNet.label}</span>{" "}
                  is not live yet
                  {deskNet.comingSoonNote ? ` — ${deskNet.comingSoonNote}` : ""}.
                  Use{" "}
                  <button
                    type="button"
                    className="font-semibold underline underline-offset-2"
                    onClick={() => switchChain?.({ chainId: sepolia.id })}
                  >
                    Sepolia
                  </button>{" "}
                  for the testnet desk.
                </p>
              ) : null}
            </div>
          )}

          {/* Hero: brand is the signal */}
          <section className="mb-8 max-w-xl animate-fade-up sm:mb-10">
            <h1 className="font-display text-[clamp(2.4rem,6vw,3.5rem)] font-bold leading-[0.95] tracking-[-0.045em] text-ink-900">
              Noctis
            </h1>
            <p className="mt-4 max-w-md text-[1.05rem] leading-relaxed text-ink-500">
              Private Uniswap desk. Vault balances stay encrypted; settlement size is clear on the
              pool.
            </p>
          </section>

          <UniswapPairLiveProvider>
            <PairMarketPanel />

            {/* Primary interaction: swap + vault side panel */}
            <section className="mt-10 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-10">
              <div className="mx-auto w-full max-w-md animate-fade-up [animation-delay:80ms] lg:mx-0 lg:max-w-none">
                <SwapCard />
                <div className="mt-4 flex gap-3 lg:hidden">
                  <button
                    type="button"
                    className="flex-1 rounded-xl border border-border/80 bg-white/70 py-3 text-center text-sm font-medium text-ink-800 transition hover:bg-white"
                    onClick={() => setDepositOpen(true)}
                  >
                    Deposit
                  </button>
                  <button
                    type="button"
                    className="flex-1 rounded-xl border border-border/80 bg-white/70 py-3 text-center text-sm font-medium text-ink-800 transition hover:bg-white"
                    onClick={() => setWithdrawOpen(true)}
                  >
                    Withdraw
                  </button>
                </div>
              </div>

              <aside className="hidden animate-fade-up [animation-delay:140ms] lg:block">
                <BalancePanel
                  onDeposit={() => setDepositOpen(true)}
                  onWithdraw={() => setWithdrawOpen(true)}
                />
              </aside>
            </section>
          </UniswapPairLiveProvider>

          {/* Secondary: activity */}
          <section className="mt-14 animate-fade-in [animation-delay:220ms]">
            <div className="mb-4 flex items-end justify-between gap-4">
              <h2 className="font-display text-xl font-bold tracking-[-0.035em] text-ink-800">
                Recent activity
              </h2>
              <p className="text-xs text-ink-400">On-chain events for this session</p>
            </div>
            <div className="border-t border-ink-200/70 pt-2">
              <ActivityFeed />
            </div>
          </section>
        </div>
      </main>

      <Footer />

      <DepositModal open={depositOpen} onOpenChange={setDepositOpen} />
      <WithdrawModal open={withdrawOpen} onOpenChange={setWithdrawOpen} />
    </div>
  );
}
