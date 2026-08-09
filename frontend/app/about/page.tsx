import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { PILOT } from "@/lib/pilot";

export const metadata: Metadata = {
  title: "About | Noctis",
  description:
    "Private Uniswap desk on Zama FHE: encrypted vault balances and unlinkable orders, settled against Uniswap V2. Live Sepolia pilot. Protocol fee 0.05%.",
};

const steps = [
  {
    title: "Deposit",
    body: "Move ETH or USDT into the vault. Your balance is stored as an encrypted value that only you can decrypt.",
  },
  {
    title: "Sign an intent",
    body: "Your swap amount is encrypted client-side and signed. Nobody watching the chain can read your order.",
  },
  {
    title: "Settle on Uniswap",
    body: "After a decryption proof, the Noctis contract swaps against Uniswap as a proxy. The pool never sees your wallet.",
  },
  {
    title: "Withdraw",
    body: "Pull your funds whenever you want. Output from swaps is credited back to your encrypted balance.",
  },
];

const encrypted = [
  "Vault balances, stored as FHE ciphertexts",
  "Pre-trade swap intents and amounts",
  "Your identity toward the pool: Uniswap sees the Noctis contract, not your wallet",
];

const clear = [
  "The fill size when Uniswap executes (AMMs need numbers)",
  "Deposit and withdrawal transactions, attributable to your address",
  "The Noctis contract as the pool counterparty",
];

export default function AboutPage() {
  const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

  return (
    <div className="relative flex min-h-screen flex-col">
      <Header />

      <main className="relative z-10 flex-1 px-5 pb-20 pt-12 sm:pt-16">
        <div className="mx-auto max-w-5xl">
          <section className="max-w-2xl animate-fade-up">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand-700">
              Private Uniswap desk · Powered by Zama FHE
            </p>
            <h1 className="mt-3 font-display text-[clamp(2.2rem,5.5vw,3.4rem)] font-bold leading-[1.02] tracking-[-0.045em] text-ink-900">
              Trade Uniswap without showing your size.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-500">
              Encrypted balances and unlinkable orders on the Zama Protocol, settled
              against Uniswap liquidity. Protocol fee {PILOT.feeLabel}. Live
              pilot on {PILOT.network}.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/"
                className="rounded-xl bg-brand-700 px-6 py-3 text-sm font-semibold text-white transition hover:bg-brand-800 active:translate-y-px"
              >
                Open the desk
              </Link>
              <Link
                href="/docs#try-the-pilot"
                className="rounded-xl border border-border/80 bg-white/70 px-6 py-3 text-sm font-medium text-ink-800 transition hover:bg-white active:translate-y-px"
              >
                Pilot walkthrough
              </Link>
              <Link
                href="/docs"
                className="rounded-xl border border-border/80 bg-white/70 px-6 py-3 text-sm font-medium text-ink-800 transition hover:bg-white active:translate-y-px"
              >
                Docs
              </Link>
            </div>
          </section>

          <section className="mt-14 animate-fade-up [animation-delay:40ms]">
            <div className="overflow-hidden rounded-2xl border border-border/80 bg-white/60">
              <div className="border-b border-border/60 px-5 py-3 text-xs font-medium uppercase tracking-[0.14em] text-ink-400">
                Sepolia pilot · verify on-chain
              </div>
              <div className="grid gap-0 sm:grid-cols-3">
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
                <div className="border-t border-border/60 px-5 py-4 sm:border-l sm:border-t-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
                    Fee
                  </p>
                  <Link
                    href="/docs#fees"
                    className="mt-1.5 block font-mono text-sm text-ink-800 hover:text-brand-700"
                  >
                    {PILOT.feeLabel} · Safe treasury
                  </Link>
                </div>
              </div>
            </div>
          </section>

          <section className="mt-24 max-w-2xl animate-fade-up [animation-delay:80ms]">
            <h2 className="font-display text-2xl font-bold tracking-[-0.035em] text-ink-900 sm:text-3xl">
              Mempool privacy isn&apos;t balance privacy.
            </h2>
            <p className="mt-4 leading-relaxed text-ink-500">
              Private RPCs hide a transaction for a moment. They don&apos;t hide
              your wallet balance or your trade history. Large clips still
              paint a target for copy-traders and wallet-clustering tools.
              Noctis moves the sensitive part, your book and your intent, into
              encrypted state before the trade ever reaches the pool.
            </p>
          </section>

          <section className="mt-24">
            <h2 className="font-display text-2xl font-bold tracking-[-0.035em] text-ink-900 sm:text-3xl">
              Private intent. Public liquidity.
            </h2>
            <div className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {steps.map((step) => (
                <div key={step.title} className="border-t border-ink-200/80 pt-5">
                  <h3 className="font-display text-lg font-bold tracking-[-0.02em] text-ink-800">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-500">{step.body}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-24">
            <h2 className="font-display text-2xl font-bold tracking-[-0.035em] text-ink-900 sm:text-3xl">
              What stays private, honestly.
            </h2>
            <p className="mt-4 max-w-xl leading-relaxed text-ink-500">
              We pair every privacy claim with its limit. Noctis is a privacy
              layer, not a mixer, and we say exactly where the boundary sits.
            </p>
            <div className="mt-10 grid gap-6 lg:grid-cols-2">
              <div className="rounded-2xl border border-brand-200 bg-brand-50/80 p-7">
                <h3 className="font-display text-lg font-bold tracking-[-0.02em] text-brand-800">
                  Encrypted
                </h3>
                <ul className="mt-4 space-y-3">
                  {encrypted.map((item) => (
                    <li key={item} className="flex gap-3 text-sm leading-relaxed text-ink-700">
                      <span className="mt-[0.55rem] h-px w-4 shrink-0 bg-brand-400" aria-hidden />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-2xl border border-border/80 bg-white/60 p-7">
                <h3 className="font-display text-lg font-bold tracking-[-0.02em] text-ink-700">
                  Clear at settlement
                </h3>
                <ul className="mt-4 space-y-3">
                  {clear.map((item) => (
                    <li key={item} className="flex gap-3 text-sm leading-relaxed text-ink-500">
                      <span className="mt-[0.55rem] h-px w-4 shrink-0 bg-ink-300" aria-hidden />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          <section className="mt-24 max-w-3xl">
            <h2 className="font-display text-2xl font-bold tracking-[-0.035em] text-ink-900 sm:text-3xl">
              Complementary to Confidential RFQ
            </h2>
            <p className="mt-4 max-w-xl leading-relaxed text-ink-500">
              Confidential RFQ is a confidential swap venue. Noctis is a desk
              on top of Uniswap depth: encrypted vault accounting and
              unlinkable order flow, same Zama FHE stack, different job.
            </p>
            <div className="mt-8 overflow-hidden rounded-2xl border border-border/80 bg-white/60">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border/80 text-xs uppercase tracking-wide text-ink-400">
                    <th className="px-5 py-3 font-medium"> </th>
                    <th className="px-5 py-3 font-medium">Confidential RFQ</th>
                    <th className="px-5 py-3 font-medium">Noctis</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60 text-ink-600">
                  <tr>
                    <td className="px-5 py-3.5 font-medium text-ink-800">Job</td>
                    <td className="px-5 py-3.5">Confidential venue</td>
                    <td className="px-5 py-3.5">Private AMM desk</td>
                  </tr>
                  <tr>
                    <td className="px-5 py-3.5 font-medium text-ink-800">Liquidity</td>
                    <td className="px-5 py-3.5">RFQ makers</td>
                    <td className="px-5 py-3.5">Uniswap V2</td>
                  </tr>
                  <tr className="bg-brand-50/50">
                    <td className="px-5 py-3.5 font-medium text-brand-800">FHE focus</td>
                    <td className="px-5 py-3.5">Size &amp; direction in venue</td>
                    <td className="px-5 py-3.5">Balances + intents → AMM fill</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-ink-500">
              Full comparison:{" "}
              <Link
                href="/docs#vs-confidential-rfq"
                className="font-medium text-brand-700 underline-offset-4 hover:underline"
              >
                docs → vs Confidential RFQ
              </Link>
              .
            </p>
          </section>

          <section className="mt-24 max-w-3xl">
            <h2 className="font-display text-2xl font-bold tracking-[-0.035em] text-ink-900 sm:text-3xl">
              Where Noctis fits
            </h2>
            <p className="mt-4 max-w-xl leading-relaxed text-ink-500">
              Mempool tools and ZK shields solve adjacent problems. Noctis owns
              one square: FHE-encrypted balances and unlinkable orders,
              settled on Uniswap.
            </p>
            <div className="mt-8 overflow-hidden rounded-2xl border border-border/80 bg-white/60">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border/80 text-xs uppercase tracking-wide text-ink-400">
                    <th className="px-5 py-3 font-medium">Approach</th>
                    <th className="px-5 py-3 font-medium">What it protects</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60 text-ink-600">
                  <tr>
                    <td className="px-5 py-4 font-medium text-ink-800">Private RPCs (Protect)</td>
                    <td className="px-5 py-4">The mempool moment. Balances and history stay public.</td>
                  </tr>
                  <tr>
                    <td className="px-5 py-4 font-medium text-ink-800">CoW Swap</td>
                    <td className="px-5 py-4">Strong MEV design via solvers. No encrypted balances.</td>
                  </tr>
                  <tr>
                    <td className="px-5 py-4 font-medium text-ink-800">Railgun</td>
                    <td className="px-5 py-4">ZK shielding. A different stack and trust model.</td>
                  </tr>
                  <tr className="bg-brand-50/60">
                    <td className="px-5 py-4 font-medium text-brand-800">Noctis</td>
                    <td className="px-5 py-4">
                      FHE balances and intents, plus proxy identity, on top of Uniswap depth.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-24">
            <div className="desk-panel flex flex-col items-start gap-8 p-8 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="font-amount text-5xl font-bold text-ink-900">{PILOT.feeLabel}</p>
                <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-500">
                  Protocol fee on swaps at launch, collected on-chain to a Safe
                  treasury. No token required. Design partners may get a
                  temporary discount.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Link
                  href="/"
                  className="shrink-0 rounded-xl bg-brand-700 px-6 py-3 text-sm font-semibold text-white transition hover:bg-brand-800 active:translate-y-px"
                >
                  Open the desk
                </Link>
                <a
                  href={PILOT.github}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 rounded-xl border border-border/80 bg-white/80 px-6 py-3 text-sm font-medium text-ink-800 transition hover:bg-white active:translate-y-px"
                >
                  GitHub
                </a>
              </div>
            </div>
            <p className="mt-8 max-w-3xl text-xs leading-relaxed text-ink-400">
              Noctis provides tools for confidential trading mechanics. It is
              not designed to evade sanctions or launder assets. Deposits and
              withdrawals remain attributable; settlement amounts on Uniswap
              are visible at execution.
            </p>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
