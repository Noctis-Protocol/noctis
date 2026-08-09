import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { PILOT } from "@/lib/pilot";

export const metadata: Metadata = {
  title: "Documentation | Noctis",
  description:
    "Noctis private Uniswap desk: Sepolia pilot, architecture, privacy boundary, swap lifecycle, and how it complements confidential RFQ on Zama FHE.",
};

const toc = [
  { id: "try-the-pilot", label: "Try the pilot" },
  { id: "deployed-contracts", label: "Deployed contracts" },
  { id: "vs-confidential-rfq", label: "vs Confidential RFQ" },
  { id: "for-reviewers", label: "For reviewers" },
  { id: "overview", label: "Overview" },
  { id: "privacy-boundary", label: "Privacy boundary" },
  { id: "architecture", label: "Architecture" },
  { id: "swap-lifecycle", label: "Swap lifecycle" },
  { id: "deposits-withdrawals", label: "Deposits & withdrawals" },
  { id: "security", label: "Security model" },
  { id: "trust", label: "Trust model" },
  { id: "fees", label: "Fees" },
  { id: "stack", label: "Stack" },
];

const components = [
  {
    name: "NoctisVault",
    role: "Holds ETH and USDT. Stores balances as encrypted euint128 values with FHE access control. Handles deposit, withdraw, and claim.",
  },
  {
    name: "NoctisExchange",
    role: "Market swap path. Verifies relayer meta-transactions and decryption proofs, then swaps on Uniswap as a proxy with fee and slippage guards.",
  },
  {
    name: "Keeper relayer",
    role: "Verifies user EIP-712 signatures off-chain and submits transactions, so the user's wallet is not the transaction sender. Cannot decrypt user balances.",
  },
  {
    name: "Frontend FHE API",
    role: "Encrypts inputs and performs user-side decryption through the Zama relayer SDK. Runs as Next.js API routes.",
  },
  {
    name: "Zama Gateway",
    role: "Produces public decryption results with signatures that contracts verify on-chain before acting on any cleartext value.",
  },
  {
    name: "Subgraph",
    role: "Indexes vault and exchange events for the activity feed.",
  },
];

const pilotSteps = [
  {
    title: "Connect on Sepolia",
    body: "Open the desk, switch the header to Sepolia, and connect a wallet with test ETH and USDC.",
  },
  {
    title: "Deposit",
    body: "Deposit into the vault. The on-chain deposit tx is public; the resulting vault balance is an FHE ciphertext only you can userDecrypt.",
  },
  {
    title: "Private swap intent",
    body: "Sign an encrypted amount (EIP-712). The relayer submits the meta-tx; your wallet is not the Uniswap sender.",
  },
  {
    title: "Settle & withdraw",
    body: "After gateway decryption proofs, the exchange fills on Uniswap V2. Net output credits your encrypted balance — then withdraw via the pull path.",
  },
];

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="scroll-mt-24 font-display text-xl font-bold tracking-[-0.03em] text-ink-900 sm:text-2xl"
    >
      {children}
    </h2>
  );
}

function MonoLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-[0.8rem] text-brand-700 underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

export default function DocsPage() {
  const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

  return (
    <div className="relative flex min-h-screen flex-col">
      <Header />

      <main className="relative z-10 flex-1 px-5 pb-20 pt-12 sm:pt-14">
        <div className="mx-auto max-w-5xl">
          <div className="max-w-2xl animate-fade-up">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand-700">
              Live on {PILOT.network}
            </p>
            <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.04em] text-ink-900 sm:text-4xl">
              Technical documentation
            </h1>
            <p className="mt-4 leading-relaxed text-ink-500">
              How Noctis encrypts balances and swap intents, settles against
              Uniswap, and where the privacy boundary sits. Built on the Zama
              Protocol (fhEVM). Soft mainnet is prepared; Arbitrum is paused.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/"
                className="rounded-xl bg-brand-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-800 active:translate-y-px"
              >
                Open the desk
              </Link>
              <a
                href={PILOT.github}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl border border-border/80 bg-white/70 px-5 py-2.5 text-sm font-medium text-ink-800 transition hover:bg-white active:translate-y-px"
              >
                GitHub
              </a>
              <Link
                href="/about"
                className="rounded-xl border border-border/80 bg-white/70 px-5 py-2.5 text-sm font-medium text-ink-800 transition hover:bg-white active:translate-y-px"
              >
                Product story
              </Link>
            </div>
          </div>

          <div className="mt-12 grid gap-12 lg:grid-cols-[200px_minmax(0,1fr)]">
            <nav className="hidden lg:block" aria-label="Table of contents">
              <div className="sticky top-24">
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-ink-400">
                  Contents
                </p>
                <ul className="mt-4 space-y-2.5 border-l border-ink-200/80">
                  {toc.map((item) => (
                    <li key={item.id}>
                      <a
                        href={`#${item.id}`}
                        className="-ml-px block border-l border-transparent pl-4 text-sm text-ink-500 transition hover:border-brand-500 hover:text-ink-900"
                      >
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </nav>

            <article className="max-w-none animate-fade-up [animation-delay:80ms]">
              <section>
                <SectionHeading id="try-the-pilot">Try the pilot</SectionHeading>
                <p className="mt-4 max-w-[65ch] leading-relaxed text-ink-600">
                  End-to-end path on Sepolia: deposit → private intent → Uniswap
                  fill → withdraw. Pair: {PILOT.pair}. Protocol fee{" "}
                  {PILOT.feeLabel}.
                </p>
                <ol className="mt-6 max-w-[65ch] space-y-5">
                  {pilotSteps.map((step, i) => (
                    <li key={step.title} className="flex gap-4">
                      <span className="font-mono text-xs font-medium text-brand-700 [line-height:1.65rem]">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <p className="font-medium text-ink-800">{step.title}</p>
                        <p className="mt-1 text-sm leading-relaxed text-ink-500">
                          {step.body}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="mt-6 max-w-[65ch] text-sm leading-relaxed text-ink-500">
                  In the desk, use <em>Reveal trades</em> for private
                  userDecrypt of your history (browser-only cleartext). Activity
                  indexes orders without a public trader field.
                </p>
              </section>

              <section className="mt-16">
                <SectionHeading id="deployed-contracts">Deployed contracts</SectionHeading>
                <p className="mt-4 max-w-[65ch] leading-relaxed text-ink-600">
                  Single source of truth:{" "}
                  <code className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[0.85em] text-ink-800">
                    noctis-protocol/deployments/sepolia.json
                  </code>
                  . Addresses below match the live desk env.
                </p>
                <div className="mt-6 overflow-hidden rounded-2xl border border-border/80 bg-white/60">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-border/80 text-xs uppercase tracking-wide text-ink-400">
                        <th className="px-5 py-3 font-medium">Contract</th>
                        <th className="px-5 py-3 font-medium">Address</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60 text-ink-600">
                      <tr>
                        <td className="px-5 py-3.5 font-medium text-ink-800">NoctisVault</td>
                        <td className="px-5 py-3.5">
                          <MonoLink href={PILOT.explorerAddress(PILOT.vault)}>
                            {short(PILOT.vault)}
                          </MonoLink>
                          <span className="mt-1 block break-all font-mono text-[0.7rem] text-ink-400">
                            {PILOT.vault}
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td className="px-5 py-3.5 font-medium text-ink-800">NoctisExchange</td>
                        <td className="px-5 py-3.5">
                          <MonoLink href={PILOT.explorerAddress(PILOT.exchange)}>
                            {short(PILOT.exchange)}
                          </MonoLink>
                          <span className="mt-1 block break-all font-mono text-[0.7rem] text-ink-400">
                            {PILOT.exchange}
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td className="px-5 py-3.5 font-medium text-ink-800">USDC (quote token)</td>
                        <td className="px-5 py-3.5">
                          <MonoLink href={PILOT.explorerAddress(PILOT.usdc)}>
                            {short(PILOT.usdc)}
                          </MonoLink>
                        </td>
                      </tr>
                      <tr>
                        <td className="px-5 py-3.5 font-medium text-ink-800">Fee</td>
                        <td className="px-5 py-3.5">
                          {PILOT.feeBps} bps ({PILOT.feeLabel}) → Safe treasury
                        </td>
                      </tr>
                      <tr>
                        <td className="px-5 py-3.5 font-medium text-ink-800">Subgraph</td>
                        <td className="px-5 py-3.5">
                          <MonoLink href={PILOT.subgraph}>Studio query v0.8.0</MonoLink>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="mt-4 max-w-[65ch] text-sm leading-relaxed text-ink-500">
                  Ops: Safe admin, dedicated{" "}
                  <code className="font-mono text-[0.8rem]">RELAYER_ROLE</code>,
                  on-contract pause, TimelockController on sensitive exchange
                  params. External audit planned before uncapped mainnet TVL.
                </p>
              </section>

              <section className="mt-16">
                <SectionHeading id="vs-confidential-rfq">
                  Complementary to Confidential RFQ
                </SectionHeading>
                <p className="mt-4 max-w-[65ch] leading-relaxed text-ink-600">
                  Zama Confidential RFQ is a confidential swap <em>venue</em>.
                  Noctis is a <em>desk</em> that keeps vault balances and intents
                  encrypted, then settles against existing Uniswap V2 liquidity.
                  Same FHE stack; different product surface.
                </p>
                <div className="mt-6 overflow-hidden rounded-2xl border border-border/80 bg-white/60">
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
                        <td className="px-5 py-3.5 font-medium text-ink-800">Role</td>
                        <td className="px-5 py-3.5">Confidential venue</td>
                        <td className="px-5 py-3.5">Private AMM desk</td>
                      </tr>
                      <tr>
                        <td className="px-5 py-3.5 font-medium text-ink-800">Liquidity</td>
                        <td className="px-5 py-3.5">RFQ market makers</td>
                        <td className="px-5 py-3.5">Uniswap V2 pools</td>
                      </tr>
                      <tr>
                        <td className="px-5 py-3.5 font-medium text-ink-800">Encrypted</td>
                        <td className="px-5 py-3.5">Trade size &amp; direction</td>
                        <td className="px-5 py-3.5">Vault balances + intents</td>
                      </tr>
                      <tr>
                        <td className="px-5 py-3.5 font-medium text-ink-800">Clear at fill</td>
                        <td className="px-5 py-3.5">Per RFQ design</td>
                        <td className="px-5 py-3.5">Uniswap fill size (honest boundary)</td>
                      </tr>
                      <tr>
                        <td className="px-5 py-3.5 font-medium text-ink-800">Business</td>
                        <td className="px-5 py-3.5">Protocol venue</td>
                        <td className="px-5 py-3.5">{PILOT.feeLabel} desk fee · B2B desks</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="mt-4 max-w-[65ch] text-sm leading-relaxed text-ink-500">
                  One line: RFQ proves confidential execution; Noctis brings
                  confidential accounting to the Uniswap liquidity traders
                  already use.
                </p>
              </section>

              <section className="mt-16">
                <SectionHeading id="for-reviewers">For reviewers</SectionHeading>
                <p className="mt-4 max-w-[65ch] leading-relaxed text-ink-600">
                  Fast path if you are evaluating Noctis for the Zama ecosystem
                  (Startup / Builder tracks):
                </p>
                <ul className="mt-5 max-w-[65ch] space-y-3">
                  {[
                    "Run the desk walkthrough above on Sepolia (wallet + test funds).",
                    `Verify contracts on Etherscan: Vault ${short(PILOT.vault)}, Exchange ${short(PILOT.exchange)}.`,
                    "Read Privacy boundary — we document what is encrypted and what is not.",
                    `Source monorepo: ${PILOT.github} (protocol, frontend, keeper, subgraph).`,
                    "Security: CEI, ReentrancyGuard, SafeERC20, pull withdrawals, FHE.select sufficiency, gateway-signed cleartext, Safe + timelock ops.",
                  ].map((item) => (
                    <li key={item} className="flex gap-3 text-sm leading-relaxed text-ink-600">
                      <span className="mt-[0.55rem] h-px w-4 shrink-0 bg-brand-400" aria-hidden />
                      {item}
                    </li>
                  ))}
                </ul>
                <p className="mt-4 max-w-[65ch] text-sm leading-relaxed text-ink-500">
                  Contact via the Startup Track application or GitHub issues on
                  the public repo. We can run a live Sepolia office-hours demo
                  on request.
                </p>
              </section>

              <section className="mt-16">
                <SectionHeading id="overview">Overview</SectionHeading>
                <p className="mt-4 max-w-[65ch] leading-relaxed text-ink-600">
                  Noctis is a privacy layer on Uniswap: a vault contract, an
                  exchange contract, a single relayer, and this desk UI. Vault
                  balances are stored as FHE ciphertexts
                  (<code className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[0.85em] text-ink-800">euint128</code>),
                  orders are relayer-submitted so the trader address never
                  appears on-chain, and settlement runs through Uniswap with
                  the exchange contract as the pool counterparty. Pairs are
                  registered base tokens traded against USDC.
                </p>
                <p className="mt-4 max-w-[65ch] leading-relaxed text-ink-600">
                  Noctis is not a mixer, not an internal order-book matcher,
                  and not a multi-DEX aggregator. It does not claim complete
                  privacy: the boundary below is exact.
                </p>
              </section>

              <section className="mt-16">
                <SectionHeading id="privacy-boundary">Privacy boundary</SectionHeading>
                <div className="mt-6 overflow-hidden rounded-2xl border border-border/80 bg-white/60">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-border/80 text-xs uppercase tracking-wide text-ink-400">
                        <th className="px-5 py-3 font-medium">Encrypted</th>
                        <th className="px-5 py-3 font-medium">Clear at settlement</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60 text-ink-600">
                      <tr>
                        <td className="px-5 py-3.5">Vault balances</td>
                        <td className="px-5 py-3.5">Uniswap fill size</td>
                      </tr>
                      <tr>
                        <td className="px-5 py-3.5">
                          Order size, end to end (browser-encrypted FHE input —
                          opaque to the relayer and to calldata)
                        </td>
                        <td className="px-5 py-3.5">
                          Pair, direction and a one-time vaultId in relayed calldata
                        </td>
                      </tr>
                      <tr>
                        <td className="px-5 py-3.5">
                          Desk trade history (FHE userDecrypt — Reveal trades)
                        </td>
                        <td className="px-5 py-3.5">
                          Deposit and withdraw transactions, attributable on-chain
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="mt-4 max-w-[65ch] text-sm leading-relaxed text-ink-500">
                  Activity keeps swap sizes as 🔒 until you reveal them with a
                  wallet signature. That cleartext stays in your browser only.
                  Your trades appear in Recent activity via on-chain{" "}
                  <span className="font-mono text-xs">getMyOrder</span> (the
                  subgraph indexes orders anonymously — no trader field). Amount
                  ciphertexts sit on-chain as opaque FHE handles, not plaintext.
                  Flashbots reduces mempool MEV; it does not hide the Uniswap
                  fill after inclusion.
                </p>
                <p className="mt-3 max-w-[65ch] text-sm leading-relaxed text-ink-500">
                  <strong className="font-semibold text-ink-700">The order
                  size is encrypted end to end.</strong> Your browser encrypts
                  the amount with the Zama SDK (FHE ciphertext + ZK input
                  proof) before anything leaves the page: the relayer, the
                  transaction calldata and the on-chain order all carry an
                  opaque handle, never the plaintext. The size only becomes
                  public at settlement, where the Uniswap fill reveals it
                  anyway. The vaultId in calldata is a <strong
                  className="font-semibold text-ink-700">one-time
                  pseudonym</strong>: it rotates every time an order fills or
                  cancels, so your orders never cluster under one id.
                  Withdrawal payouts are batched into time windows to break
                  fill-to-payout timing, and support <strong
                  className="font-semibold text-ink-700">stealth
                  exits</strong>: the payout destination is encrypted in your
                  browser and revealed on-chain only when the payout executes,
                  so funds can land on a fresh address with no prior link to
                  you. Residual metadata: the pair and
                  direction stay visible in relayed calldata. The relayer can
                  censor or delay, but cannot read amounts, alter the
                  EIP-712-signed parameters, or decrypt vault balances.
                </p>
                <p className="mt-3 max-w-[65ch] text-sm leading-relaxed text-ink-500">
                  The desk market panel shows the selected pair&apos;s Uniswap V2
                  pool chart and <em>pool depth</em> (AMM{" "}
                  <span className="font-mono text-xs">getAmountsOut</span> ladder)
                  — not a central-limit order book. Your orders never appear on
                  that ladder.
                </p>
              </section>

              <section className="mt-16">
                <SectionHeading id="architecture">Architecture</SectionHeading>
                <p className="mt-4 max-w-[65ch] leading-relaxed text-ink-600">
                  Six components, one settlement path. The wallet talks to the
                  vault directly for deposits; swaps go through the relayer as
                  meta-transactions.
                </p>
                <div className="mt-6 space-y-0 divide-y divide-border/60 rounded-2xl border border-border/80 bg-white/60">
                  {components.map((c) => (
                    <div key={c.name} className="grid gap-1 px-5 py-4 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-6">
                      <span className="font-mono text-sm font-medium text-ink-800">{c.name}</span>
                      <span className="text-sm leading-relaxed text-ink-500">{c.role}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="mt-16">
                <SectionHeading id="swap-lifecycle">Swap lifecycle</SectionHeading>
                <p className="mt-4 max-w-[65ch] leading-relaxed text-ink-600">
                  The canonical private market swap, end to end:
                </p>
                <ol className="mt-6 max-w-[65ch] space-y-4">
                  {[
                    "The browser encrypts the order amount (Zama FHE input + ZK proof) and the user signs the resulting handle (EIP-712), including a gas refund amount quoted by the relayer. The relayer never sees the size.",
                    "The relayer verifies the signature off-chain and creates the order on the exchange contract.",
                    "The exchange requests decryption of the amount, and of balance sufficiency on sells, through the Zama Gateway.",
                    "With the decryption proof verified on-chain, the exchange swaps on Uniswap as a proxy.",
                    `At settlement, the ${PILOT.feeLabel} fee goes to the Safe treasury and the gas refund goes to the relayer wallet, both skimmed from the output.`,
                    "The net output is credited back to the user's encrypted vault balance.",
                  ].map((step, i) => (
                    <li key={step} className="flex gap-4 text-sm leading-relaxed text-ink-600">
                      <span className="font-mono text-xs font-medium text-brand-700 [line-height:1.65rem]">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {step}
                    </li>
                  ))}
                </ol>
                <p className="mt-6 max-w-[65ch] text-sm leading-relaxed text-ink-500">
                  Honest limit: the fill size is clear when Uniswap executes,
                  and the pool sees the exchange contract. Your Activity feed
                  can still show encrypted sizes until you reveal them privately
                  (ACL + userDecrypt). The relayer&apos;s gas is repaid in kind
                  from the swap output, capped on-chain; if the fee plus refund
                  would consume the output, settlement reverts.
                </p>
              </section>

              <section className="mt-16">
                <SectionHeading id="deposits-withdrawals">Deposits &amp; withdrawals</SectionHeading>
                <p className="mt-4 max-w-[65ch] leading-relaxed text-ink-600">
                  Deposits go straight from the wallet to the vault, no relayer
                  involved. The amount and sender are public; the resulting
                  vault balance is encrypted. Rate limit: one deposit per
                  block, per user, per asset.
                </p>
                <div className="mt-6 max-w-md overflow-hidden rounded-2xl border border-border/80 bg-white/60">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-border/80 text-xs uppercase tracking-wide text-ink-400">
                        <th className="px-5 py-3 font-medium">Asset</th>
                        <th className="px-5 py-3 font-medium">Min</th>
                        <th className="px-5 py-3 font-medium">Max</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60 font-mono text-ink-600">
                      <tr>
                        <td className="px-5 py-3 font-sans">ETH</td>
                        <td className="px-5 py-3">0.005</td>
                        <td className="px-5 py-3">100</td>
                      </tr>
                      <tr>
                        <td className="px-5 py-3 font-sans">USDT / USDC</td>
                        <td className="px-5 py-3">10</td>
                        <td className="px-5 py-3">1,000,000</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="mt-6 max-w-[65ch] leading-relaxed text-ink-600">
                  Withdrawals follow a two-step pattern: the user requests a
                  withdrawal through the encrypted debit path, and once
                  authorized, the payout executes in a separate transaction.
                  The destination can be an encrypted stealth address — hidden
                  on-chain until the payout itself — with ETH pushed directly
                  so the fresh address never needs gas to receive it.
                </p>
              </section>

              <section className="mt-16">
                <SectionHeading id="security">Security model</SectionHeading>
                <p className="mt-4 max-w-[65ch] leading-relaxed text-ink-600">
                  The contracts follow standard hardening patterns throughout:
                </p>
                <ul className="mt-5 max-w-[65ch] space-y-3">
                  {[
                    "Checks-Effects-Interactions ordering and reentrancy guards on every state-changing entrypoint.",
                    "Balance sufficiency enforced with FHE.select before any encrypted subtraction, so a failed check can never underflow a balance.",
                    "Gateway signatures verified on-chain before any cleartext deduction or withdrawal, with hard caps on amounts.",
                    "Chainlink oracle with deviation bounds and slippage floors on swaps.",
                    "Role-scoped access control (relayer, pauser, params) with a timelock on sensitive admin changes, and an emergency pause.",
                    "Pull-based claims for withdrawals rather than push transfers.",
                  ].map((item) => (
                    <li key={item} className="flex gap-3 text-sm leading-relaxed text-ink-600">
                      <span className="mt-[0.55rem] h-px w-4 shrink-0 bg-brand-400" aria-hidden />
                      {item}
                    </li>
                  ))}
                </ul>
              </section>

              <section className="mt-16">
                <SectionHeading id="trust">Trust model</SectionHeading>
                <p className="mt-4 max-w-[65ch] leading-relaxed text-ink-600">
                  Decryption relies on the Zama Gateway and its KMS. We do not
                  claim this is trustless. Defense in depth compensates:
                  deposit and withdrawal caps, on-chain balance checks,
                  emergency pause, suspicious-value events, and a timelock on
                  admin surfaces. The single relayer sees the trader identity,
                  pair and direction of the orders it relays — but not the
                  size (encrypted end to end). It can censor or delay, but
                  cannot decrypt balances or amounts, cannot alter signed
                  parameters, and cannot move funds outside the signed paths.
                </p>
                <p className="mt-3 max-w-[65ch] text-sm leading-relaxed text-ink-500">
                  Privacy hygiene (not mixer tech): avoid size-matching a deposit
                  to the next fill, hold vault inventory across swaps, prefer
                  partial withdraws.
                </p>
              </section>

              <section className="mt-16">
                <SectionHeading id="fees">Fees</SectionHeading>
                <p className="mt-4 max-w-[65ch] leading-relaxed text-ink-600">
                  The protocol fee is set on-chain at {PILOT.feeBps} basis points
                  ({PILOT.feeLabel}) at launch, capped at 30 basis points, and
                  changeable only through the params role behind the timelock.
                  Fees accrue to a Safe treasury. The relayer&apos;s gas is
                  repaid from the swap output at settlement, quoted before
                  signing and hard-capped on-chain.
                </p>
              </section>

              <section className="mt-16">
                <SectionHeading id="stack">Stack</SectionHeading>
                <div className="mt-6 max-w-xl overflow-hidden rounded-2xl border border-border/80 bg-white/60">
                  <table className="w-full text-left text-sm">
                    <tbody className="divide-y divide-border/60 text-ink-600">
                      {[
                        ["Network", "Sepolia live · Mainnet Phase D (switch in header)"],
                        ["FHE contracts", "@fhevm/solidity 0.11.1"],
                        ["Client SDK", "@zama-fhe/relayer-sdk 0.4.1"],
                        ["Hardhat plugin", "@fhevm/hardhat-plugin 0.4.2"],
                        ["Frontend", "Next.js, wagmi, Tailwind"],
                        ["Relayer", "Node / Express, Docker Compose"],
                        ["Indexing", "The Graph"],
                      ].map(([layer, value]) => (
                        <tr key={layer}>
                          <td className="px-5 py-3 font-medium text-ink-800">{layer}</td>
                          <td className="px-5 py-3 font-mono text-[0.8rem]">{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-8 max-w-[65ch] text-sm leading-relaxed text-ink-500">
                  For the product story and what Noctis protects in practice,
                  see the{" "}
                  <Link href="/about" className="font-medium text-brand-700 underline-offset-4 hover:underline">
                    about page
                  </Link>
                  .
                </p>
              </section>
            </article>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
