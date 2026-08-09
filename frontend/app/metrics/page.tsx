import type { Metadata } from "next";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { MetricsDashboard } from "@/components/metrics/MetricsDashboard";
import { PILOT } from "@/lib/pilot";

export const metadata: Metadata = {
  title: "Metrics | Noctis",
  description:
    "Public metrics for the Noctis Sepolia pilot: order lifecycle, vault balances and deposit flows. Order sizes and trader identities stay encrypted.",
};

const publicData = [
  "Order lifecycle: created, filled, cancelled — with timestamps",
  "Aggregate vault balances (ETH and USDC held by the contract)",
  "Deposit and withdrawal transactions, attributable to their wallets",
];

const encryptedData = [
  "Order sizes and directions of intent, stored as FHE ciphertexts",
  "Per-user vault balances — only the owner can decrypt them",
  "Trader identity behind each order",
];

export default function MetricsPage() {
  const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

  return (
    <div className="relative flex min-h-screen flex-col">
      <Header />

      <main className="relative z-10 flex-1 px-5 pb-20 pt-12 sm:pt-16">
        <div className="mx-auto max-w-5xl">
          <section className="max-w-2xl animate-fade-up">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand-700">
              Public metrics · {PILOT.network} pilot
            </p>
            <h1 className="mt-3 font-display text-[clamp(2.2rem,5.5vw,3.4rem)] font-bold leading-[1.02] tracking-[-0.045em] text-ink-900">
              What the chain can see.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-500">
              Every number on this page comes from public data: indexed events
              and on-chain reads. What Noctis encrypts — order sizes, trader
              identity, per-user balances — is not here, because nobody can
              read it.
            </p>
          </section>

          <section className="mt-12 animate-fade-up [animation-delay:40ms]">
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-2xl border border-border/80 bg-white/60 p-7">
                <h2 className="font-display text-lg font-bold tracking-[-0.02em] text-ink-700">
                  Public, shown below
                </h2>
                <ul className="mt-4 space-y-3">
                  {publicData.map((item) => (
                    <li
                      key={item}
                      className="flex gap-3 text-sm leading-relaxed text-ink-500"
                    >
                      <span
                        className="mt-[0.55rem] h-px w-4 shrink-0 bg-ink-300"
                        aria-hidden
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-2xl border border-brand-200 bg-brand-50/80 p-7">
                <h2 className="font-display text-lg font-bold tracking-[-0.02em] text-brand-800">
                  Encrypted, never shown
                </h2>
                <ul className="mt-4 space-y-3">
                  {encryptedData.map((item) => (
                    <li
                      key={item}
                      className="flex gap-3 text-sm leading-relaxed text-ink-700"
                    >
                      <span
                        className="mt-[0.55rem] h-px w-4 shrink-0 bg-brand-400"
                        aria-hidden
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          <section className="mt-14 animate-fade-up [animation-delay:80ms]">
            <MetricsDashboard />
          </section>

          <section className="mt-14 animate-fade-in [animation-delay:120ms]">
            <div className="overflow-hidden rounded-2xl border border-border/80 bg-white/60">
              <div className="border-b border-border/60 px-5 py-3 text-xs font-medium uppercase tracking-[0.14em] text-ink-400">
                Verify these numbers yourself
              </div>
              <div className="grid gap-0 sm:grid-cols-2">
                <div className="px-5 py-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
                    Vault
                  </p>
                  <a
                    href={PILOT.explorerAddress(PILOT.vault)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1.5 block font-mono text-sm text-brand-700 underline-offset-2 hover:underline"
                    title={PILOT.vault}
                  >
                    {short(PILOT.vault)}
                  </a>
                </div>
                <div className="border-t border-border/60 px-5 py-4 sm:border-l sm:border-t-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
                    Exchange
                  </p>
                  <a
                    href={PILOT.explorerAddress(PILOT.exchange)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1.5 block font-mono text-sm text-brand-700 underline-offset-2 hover:underline"
                    title={PILOT.exchange}
                  >
                    {short(PILOT.exchange)}
                  </a>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
