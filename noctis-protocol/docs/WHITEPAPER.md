# The Noctis Protocol — Whitepaper

**Confidential trading on a public blockchain, explained from first principles.**

Version 1.0 — 2026 · [Version française / French version](./WHITEPAPER_FR.md)

> This document is written to be read at two speeds. Every chapter opens with
> a **plain-language explanation a beginner can follow**, then goes into the
> **precise technical mechanism** for readers who want the full depth. Boxes
> marked 🔍 are the technical deep dives; boxes marked 💡 are intuitions.
> Nothing essential lives only in a box.

---

## Table of contents

1. [Why privacy in trading matters](#1-why-privacy-in-trading-matters)
2. [Background: the transparent blockchain problem](#2-background-the-transparent-blockchain-problem)
3. [The key technology: Fully Homomorphic Encryption (FHE)](#3-the-key-technology-fully-homomorphic-encryption-fhe)
4. [Architecture: the pieces of Noctis](#4-architecture-the-pieces-of-noctis)
5. [The life of a trade, step by step](#5-the-life-of-a-trade-step-by-step)
   - [Step 1 — Depositing funds](#step-1--depositing-funds)
   - [Step 2 — Holding an encrypted balance](#step-2--holding-an-encrypted-balance)
   - [Step 3 — Placing an order](#step-3--placing-an-order)
   - [Step 4 — Settlement](#step-4--settlement)
   - [Step 5 — Withdrawing](#step-5--withdrawing)
6. [The privacy toolbox, technique by technique](#6-the-privacy-toolbox-technique-by-technique)
7. [What Noctis does NOT hide — the honest trust model](#7-what-noctis-does-not-hide--the-honest-trust-model)
8. [Security engineering](#8-security-engineering)
9. [Protocol economics](#9-protocol-economics)
10. [Roadmap: toward a fully dark pool (V3 netting)](#10-roadmap-toward-a-fully-dark-pool-v3-netting)
11. [Glossary](#11-glossary)

---

## 1. Why privacy in trading matters

💡 **Imagine playing poker with your cards face-up.** That is what trading on
a normal blockchain is like. Everyone can see how much money you have, what
you are buying, how much of it, and when. Professional observers exploit this
in seconds:

- **Front-running:** a bot sees your pending buy order and buys *before* you,
  then sells to you at a higher price. This is called **MEV** (Maximal
  Extractable Value) and it extracts hundreds of millions of dollars per year
  from ordinary users.
- **Copy-trading and profiling:** anyone can watch a successful wallet and
  mirror or anticipate its every move.
- **Commercial exposure:** a fund accumulating a position telegraphs its
  strategy to the entire market, moving the price against itself.
- **Personal safety:** a visible large balance makes its owner a target.

Traditional finance solved parts of this with **dark pools** — private
matching venues where orders are hidden until execution. But dark pools
require trusting an operator, and operators have repeatedly abused that trust
(several bank-run dark pools were sanctioned for leaking or front-running
client flow).

**Noctis's goal:** the confidentiality of a dark pool, on a public
blockchain, **without trusting any operator** — because the operator
mathematically *cannot* read the data it processes.

---

## 2. Background: the transparent blockchain problem

💡 **A blockchain is a public spreadsheet.** Ethereum's power comes from the
fact that thousands of computers verify every transaction. But to verify, they
must *see*. Three kinds of data are visible to absolutely everyone, forever:

1. **Calldata** — the content of every transaction (function called,
   arguments: amounts, addresses…).
2. **State** — every account balance and every contract storage slot.
3. **Events (logs)** — the notifications contracts emit, used by apps and
   indexers.

Additionally, two *side channels* leak information even when data is
encrypted:

4. **Storage-access patterns** — *which* storage slot changed can identify
   *whose* data changed, even if the value is ciphertext.
5. **Timing and transaction graph** — who sent a transaction, when, and which
   events happened in the same block.

A serious privacy protocol must address all five. Noctis does — each one is
treated in §5 and §6.

---

## 3. The key technology: Fully Homomorphic Encryption (FHE)

### 3.1 For beginners

💡 **A locked box you can work through.** Normal encryption is a safe: to do
anything with the contents you must open it (decrypt), and while it is open,
anyone nearby can look. **Fully Homomorphic Encryption is a sealed glovebox:**
you can manipulate what is inside — add numbers, compare them — *through the
gloves*, without ever opening the box. The result of your work is itself
locked in a new box, and only the person with the key can look at it.

Concretely, with FHE a smart contract can compute:

- "add this encrypted deposit to this encrypted balance" ✅
- "check whether the encrypted balance is at least the encrypted order size" ✅
- "if yes subtract the amount, if no subtract zero — without revealing which
  happened" ✅

…while nobody — not the miners, not the protocol team, not the contract
itself — ever sees a single number in clear.

### 3.2 🔍 The fhEVM in precise terms

Noctis is built on **Zama's fhEVM v0.9** (Sepolia today, Ethereum mainnet via
the coprocessor architecture):

- **Encrypted types.** `euint8 … euint256`, `ebool`, `eaddress`. Noctis uses
  `euint128` for balances and order amounts, `euint64` for confidential token
  transfers (ERC-7984), `ebool` for conditions, `eaddress` for hidden payout
  recipients.
- **Handles.** On-chain, a ciphertext is referenced by a 32-byte **handle**.
  The actual ciphertext lives on Zama's coprocessor network. Contract code
  manipulates handles; the coprocessors perform the homomorphic math.
- **Operations.** `FHE.add`, `FHE.sub`, `FHE.mul` (arithmetic), `FHE.le`,
  `FHE.ge`, `FHE.eq` (comparison → `ebool`), and the crucial
  `FHE.select(cond, a, b)` — an **oblivious if/else**: it returns `a` or `b`
  as a fresh ciphertext without revealing which branch was taken.
- **Client-side encryption with proofs.** When a user encrypts a value in
  their browser, they produce `(handle, inputProof)`. The **ZK input proof**
  guarantees the user knows the plaintext and binds the ciphertext to one
  specific `(contract, sender)` pair — it cannot be replayed elsewhere.
  On-chain, `FHE.fromExternal(handle, proof)` verifies this.
- **Access control (ACL).** Every handle has an access list. Only addresses
  the contract explicitly allows (`FHE.allow`, `FHE.allowThis`,
  `FHE.allowTransient`) can ever decrypt it. A user's balance handle is
  readable by exactly two parties: the vault contract (to compute on it) and
  the user (to display it).
- **Declassification — the only door out.** To make a value public, the
  contract must call `FHE.makePubliclyDecryptable(handle)`. A **threshold
  committee** (Zama's KMS: *t-of-n* nodes; no single node can decrypt alone)
  produces the plaintext plus a signature bundle; the contract verifies it
  with `FHE.checkSignatures` before acting on it. **Decryption is a protocol
  decision recorded on-chain, never an operator capability.**

### 3.3 💡 What this buys, in one sentence

> The chain can *enforce rules about numbers it cannot read*, and the set of
> numbers that ever become public is an explicit, auditable, minimal list.

---

## 4. Architecture: the pieces of Noctis

```text
        Browser (Next.js)                      Ethereum (Sepolia)
 ┌─────────────────────────────┐   ┌────────────────────────────────────────┐
 │ FHE encryption (WASM, ZAMA  │   │  NoctisVaultV2      encrypted custody  │
 │ relayer-sdk) — plaintext    │   │   · euint128 balances                  │
 │ never leaves the page       │   │   · vaultId pseudonyms                 │
 │ EIP-712 intent signing      │   │   · stealth withdrawals               │
 └──────────────┬──────────────┘   │   · chaff decoy writes                │
                │ encrypted        │  NoctisExchangeV2   trading engine     │
                ▼ intents          │   · relayed encrypted orders           │
 ┌─────────────────────────────┐   │   · Uniswap adapter + oracle guards    │
 │ Keeper / Relayer (Node.js)  │──►│  NoctisConfidentialToken (cUSDC)       │
 │ · pays gas (identity shield)│   │   · ERC-7984 encrypted-amount token    │
 │ · decrypt-proof courier     │   │  GatewayCaller      decrypt plumbing   │
 │ · withdrawal executor       │   └────────────────────────────────────────┘
 │ · confidential-buffer flush │              │ threshold decryption
 │ · private-tx RPC (Flashbots)│              ▼
 └─────────────────────────────┘   ┌────────────────────────────────────────┐
                                   │ ZAMA coprocessors + KMS (t-of-n)       │
 ┌─────────────────────────────┐   └────────────────────────────────────────┘
 │ Subgraph (The Graph)        │     Uniswap V2 (public liquidity)
 │ indexes only public events  │     Chainlink (reference prices)
 └─────────────────────────────┘
```

Six components, one principle: **plaintext exists only in the user's browser
and — for the minimal declassified set — in the threshold committee's output.**

| Component | Role | Sees plaintext amounts? |
|---|---|---|
| Frontend | encrypt inputs, sign intents, decrypt own balance | only the user's own |
| Vault | custody, encrypted balances, withdrawals | **never** |
| Exchange | orders, settlement, Uniswap routing | only declassified settlement scalars |
| cUSDC wrapper | confidential deposit denomination | never (encrypted transfers) |
| Keeper/relayer | gas payer, decrypt courier, executor | only declassified scalars |
| Subgraph | analytics on public events | only public aggregates |

---

## 5. The life of a trade, step by step

This chapter walks through everything that happens from funding a wallet to
withdrawing profits. For **each step** we state: *what happens*, *what an
outside observer sees*, *what stays private*, and *which technology makes it
so*.

---

### Step 1 — Depositing funds

**What happens (beginner).** You move tokens from your wallet into the Noctis
vault. From that moment your money is held as an *encrypted balance* — think
of pouring your coins into an opaque vault where even the vault keeper cannot
count them.

Noctis offers **two deposit paths**:

**a) Standard deposit (ETH or any listed token).** You call
`depositETH()`/`depositToken()`. Like any blockchain transfer, **the deposited
amount and your address are public** for this one transaction — that is
physics of public chains, not a Noctis choice. The amount is immediately
converted into an encrypted balance (`euint128`), and everything that follows
is private.

**b) Confidential deposit (USDC, V2.5).** To hide even the deposit amount:

1. You **wrap** USDC into **cUSDC** — a confidential token following the
   **ERC-7984** standard (OpenZeppelin's audited implementation). The wrap
   amount is the last public number of your journey, and it is *decoupled*
   from everything that follows.
2. You transfer cUSDC into the vault with
   `confidentialTransferAndCall(vault, encryptedAmount, proof)`. The amount
   is **encrypted in your browser**; on-chain it is an opaque handle. You can
   wrap 10 000 once and later deposit 1 234, then 566, then 4 200 — nobody
   can see those numbers, or even that they differ.
3. The vault credits your encrypted balance homomorphically and enforces the
   per-token deposit cap **without decrypting**: it computes
   `ok = FHE.le(amount, maxDeposit)` and credits
   `FHE.select(ok, amount, 0)`; if `ok` is (encrypted) false, the ERC-7984
   token automatically refunds the transfer. Even the *rejection* of a
   deposit is invisible.
4. Periodically, the keeper "flushes" the vault's pooled cUSDC buffer back to
   public USDC so settlements can be paid. **Only the pooled sum** of the
   window's deposits is decrypted (k-anonymity) — never any individual amount.

| | Standard deposit | Confidential deposit |
|---|---|---|
| Observer sees | your address, token, exact amount, time | your address, token, time, an opaque handle |
| Stays private | everything afterwards | **the amount itself**, forever |
| Technology | euint128 conversion at credit | ERC-7984, browser FHE encryption, ZK input proof, homomorphic cap + FHE-gated refund, pooled k-anonymous flush |

**Also at this step:** your address is silently assigned a **vaultId** — a
pseudo-random 256-bit pseudonym (drawn from `keccak(user, prevrandao, nonce)`,
no event emitted). All relayed trading later refers to this number, never to
your address. It is the identity mask used in Step 3.

---

### Step 2 — Holding an encrypted balance

**What happens (beginner).** Your balance sits in the vault as a locked
number. You can see it in the app (your browser holds the key); nobody else
can. When the app shows "1 250 USDC", it decrypted that figure *locally, for
your eyes only*.

**🔍 Mechanism.**

- Storage: `mapping(token => mapping(user => euint128)) balances` — the slot
  content is a handle to ciphertext, useless to a reader.
- ACL: after every write the vault calls `FHE.allowThis(newBalance)` (so it
  can keep computing) and `FHE.allow(newBalance, user)` (so *you* can
  decrypt). Nobody else is ever allowed — there is no "admin read" anywhere
  in the protocol.
- Reading your own balance: the browser requests **user decryption** through
  the ZAMA relayer SDK — an EIP-712-signed request that the KMS verifies
  against the on-chain ACL. Your balance travels re-encrypted *to your key*;
  the API route that assists this is `POST`-only with `Cache-Control:
  no-store`, so no address/handle pair lands in server or proxy logs.
- **Decoy writes (chaff, V2.5).** Whenever *anyone's* balance is modified by
  a settlement, the vault also rewrites K other users' balances with
  `FHE.add(balance, 0)` — a homomorphic "+0" that produces a **fresh,
  indistinguishable ciphertext** without changing the value. An observer
  diffing storage sees K+1 balances change and cannot tell which one really
  moved. This is the defense against side channel #4 from §2.

---

### Step 3 — Placing an order

**What happens (beginner).** You decide "buy 0.5 ETH with USDC". Your browser
locks that number in an FHE box, signs a permission slip, and hands the box to
a courier (the **relayer**) who pays the gas. The chain sees that *the courier*
delivered *someone's* sealed order — not whose, not how big.

**🔍 Mechanism, leak by leak.**

1. **Amount confidentiality — end-to-end encrypted intents.** The order size
   is encrypted in the browser (`euint128` + ZK input proof bound to the
   exchange contract and the relayer-sender). The plaintext never reaches
   Noctis servers, the relayer, calldata, or logs. *Nobody but you knows the
   size — not even the protocol.*
2. **Identity confidentiality — relaying + pseudonyms.** You sign an EIP-712
   `CreateOrder` intent (typed, replay-protected: nonce + deadline + chainId).
   The relayer submits `createEncryptedOrderViaRelayer(vaultId, …)`:
   `tx.from` is the relayer, calldata carries your *vaultId*, not your
   address. To a chain observer, all Noctis users collapse into one sender.
3. **Unlinkability across orders — vaultId rotation.** When a relayed order
   reaches a terminal state (filled/cancelled), the vault **rotates** the
   vaultId: the old pseudonym dies, a fresh random one is bound (no event, no
   return value; only you can query yours via `getMyVaultId()`). Successive
   orders do not cluster under one identifier — each order is a *one-time
   pseudonym*.
4. **Event hygiene.** `OrderCreated(orderId, baseToken, isBuy, timestamp)` —
   no address, no amount, no vaultId in any event.
5. **Authorization without identity.** The keeper keeps a persisted, private
   `orderId → owner` map (from the signed intents) so only the true owner can
   cancel — cancellation authority without on-chain identity exposure.
6. **Anti-grief economics (privacy-neutral).** Gas refunds are collected
   in-kind at settlement only; the relayer's off-chain policy bounds
   create/cancel loops without ever seeing amounts.

| Observer | Sees | Does NOT see |
|---|---|---|
| Chain | relayer address, pair, side, timestamp, opaque handle | your address, the amount |
| Relayer | your IP/signature (existence of an order), pair, side | **the amount** (FHE handle only) |
| Protocol team | same as chain | amounts, identities behind vaultIds |

---

### Step 4 — Settlement

**What happens (beginner).** The protocol checks — still through the FHE
gloves — that your locked balance covers the order, then executes the trade on
Uniswap and credits your encrypted balance with the proceeds. Only the number
strictly needed to trade on the public market is ever unlocked.

**🔍 Mechanism.**

1. **Solvency without disclosure — the gated debit.** The vault computes
   `sufficient = FHE.le(orderAmount, balance)` and then
   `debit = FHE.select(sufficient, orderAmount, 0)`, applying
   `balance := FHE.sub(balance, debit)`. Insufficient orders debit zero —
   and the *storage write happens either way*, so no observer learns which.
   Only the boolean `sufficient` is declassified (threshold-decrypted,
   verified on-chain with `FHE.checkSignatures`) — one bit, not the balance.
2. **Minimal declassification.** To swap on Uniswap, the executed amount must
   become public — that is the AMM's physics (see §7 and the V3 roadmap for
   how netting shrinks it). The declassified set per trade is exactly:
   `{sufficiency bit, executed amount}`.
3. **Oracle guards.** The swap is bounded by Chainlink reference price ±
   `maxPriceDeviationBPS` and user slippage tolerance — manipulation
   containment for the public leg.
4. **Chaff on every balance write.** The settlement credit
   (`creditBalanceByVaultId`) and the debit lock both trigger K decoy
   rewrites (§ Step 2), so the storage diff of a settlement block does not
   single out the trader.
5. **Calldata hygiene.** Settlement calls reference `vaultId`, never an
   address; the vault resolves the owner internally.
6. **Fees and refunds, transparently.** Protocol fee (5 bps at launch,
   hard-capped at 30) goes to the treasury Safe; the relayer's gas is
   refunded in-kind from the traded token at settlement — both amounts are
   public *protocol* revenue, not user data.
7. **MEV shielding.** Keeper transactions can route through a private-tx RPC
   (Flashbots Protect on mainnet) so pending settlements never sit in the
   public mempool: no sandwiching, no pre-confirmation timing analysis.

---

### Step 5 — Withdrawing

**What happens (beginner).** You ask for your money back — to your wallet, or
to a **brand-new address that has no link to you**. The request goes into a
box (amount *and* destination encrypted). A few minutes later, the protocol's
keeper — not you — sends the payout. Because *someone else* pushes the money
to a *hidden destination*, an observer cannot connect "you asked" to "this
address got paid".

**🔍 Mechanism — "stealth exits v2", the most layered flow in Noctis.**

1. **Encrypted intent.** `requestWithdrawalPrivate(token, encAmount,
   encRecipient, proof)` — amount (`euint128`) *and* recipient (`eaddress`)
   are encrypted in your browser. The recipient is typically a fresh, empty
   address.
2. **Pseudo-random request ids.** Ids are drawn as
   `keccak(requester, prevrandao, nonce)` — non-sequential, so an observer
   cannot replay the public ordering of requests to rebuild who-is-who.
3. **Anonymous event.** `WithdrawalRequested(token, timestamp)` — no
   requester, no id, no amount in the log.
4. **Batch windows (k-anonymity in time).** Requests execute only at window
   boundaries (300 s on Sepolia). All requests in a window become
   temporally indistinguishable.
5. **Keeper-executed payout — breaking the `tx.from` link.** At the window
   boundary, the *keeper* (or anyone — the function is permissionless)
   triggers execution. Your wallet signs nothing at payout time. The
   threshold committee decrypts `{amount, sufficiency, recipient}` — the
   protocol's third and final declassification point — and the vault pays
   the recipient: ERC-20 by direct transfer, ETH by push-with-fallback
   (a fresh address has no gas, so ETH is *pushed*; if a contract recipient
   rejects, the payout becomes claimable — pull-over-push safety).
6. **Shredding (V2.5).** The UI can split one logical withdrawal into up to
   **8 tranches to different stealth addresses** across windows. An adversary
   trying to match "deposit of X" to "payouts summing to X" now faces a
   combinatorial subset-sum problem across many users and windows.
7. **Limits stay on the requester.** Daily caps, per-request caps, and
   pending-count caps are all keyed on the *requester*, so the privacy
   features cannot be used to evade risk controls.

| Observer sees | Does NOT see |
|---|---|
| an anonymous "someone requested a withdrawal of token T" event | who, how much, to where |
| keeper-sent payout transactions at window boundaries | which request they correspond to (random ids, batch) |
| payout amounts (chain transfer physics) | their link to any deposit or trader — especially when shredded |

---

## 6. The privacy toolbox, technique by technique

A reference table of every technique in the protocol, the leak it closes, and
where it acts:

| # | Technique | Closes | Layer |
|---|---|---|---|
| 1 | `euint128` encrypted balances + strict ACL | balance disclosure | state |
| 2 | Browser-side FHE encryption + ZK input proofs | amount in calldata/servers | intent |
| 3 | EIP-712 relayed intents (relayer = sender) | trader address in `tx.from` | identity |
| 4 | Pseudo-random vaultIds, silent assignment | address↔id mapping replay | identity |
| 5 | One-time vaultId rotation per terminal order | order clustering | unlinkability |
| 6 | Gated debit (`FHE.le` + `FHE.select`) | solvency oracle | state |
| 7 | Minimal declassification + `FHE.checkSignatures` | over-disclosure | decryption |
| 8 | Anonymous events (token+timestamp only) | log analytics | events |
| 9 | ERC-7984 confidential deposits (cUSDC) | deposit amount | ingress |
| 10 | Pooled buffer flush (sum-only decrypt) | per-deposit amounts at unwrap | ingress |
| 11 | Homomorphic deposit cap + FHE-gated refund | limit-check side channel | ingress |
| 12 | Chaff decoy writes (`FHE.add(b,0)`, K decoys) | storage-diff attribution | side channel |
| 13 | Encrypted recipients (`eaddress`) | payout destination | egress |
| 14 | Pseudo-random withdrawal ids + anonymous request event | request↔payout join | egress |
| 15 | Batch windows (300 s) | timing correlation | egress |
| 16 | Keeper-executed payouts (permissionless) | `tx.from` link at payout | egress |
| 17 | Withdrawal shredding (≤ 8 tranches, stealth addresses) | amount correlation | egress |
| 18 | ETH push-with-fallback | gasless fresh addresses | egress |
| 19 | POST + `no-store` API routes; scrubbed keeper logs | web/ops metadata | off-chain |
| 20 | Private-tx RPC option (Flashbots Protect) | mempool/MEV exposure | network |

---

## 7. What Noctis does NOT hide — the honest trust model

A privacy protocol that overstates its guarantees is a trap. Here is the
complete list of what remains visible or trusted, and why.

**Visible by design (public-chain physics):**

1. **Standard deposit amounts** — one public transfer at ingress. *Mitigation:
   use the confidential cUSDC path (deposit amounts encrypted).*
2. **The public wrap amount** when entering cUSDC — decoupled from all
   subsequent activity, but visible once.
3. **Settlement swap sizes on Uniswap** — the executed amount of each trade's
   public leg. *Mitigation today: batch timing + MEV-protected submission.
   Structural fix: V3 netting (§10) reduces this to window residuals.*
4. **Payout transfer amounts** — chain transfers are public; shredding makes
   them hard to correlate but not invisible.
5. **Participation** — that *some* address interacted with Noctis contracts.
   Noctis is pseudonymous within its flows, not an anonymity mixer.

**Trusted parties (and for what):**

| Party | Trusted for | NOT able to |
|---|---|---|
| ZAMA KMS committee (t-of-n) | decrypting *only* declassified handles, correctly | read balances/orders at will (ACL + threshold) |
| Relayer/keeper (Noctis-operated) | liveness; not logging IP↔order metadata | see amounts (FHE), steal funds (no custody), forge payouts (proof-verified) |
| RPC provider | not profiling your `eth_call` patterns | reading encrypted content |
| Chainlink oracles | honest reference prices (bounded by deviation guards) | touching custody |
| OpenZeppelin/Zama code | correctness of audited primitives | — |

**Explicit non-goals:** network-layer anonymity (use your own RPC/VPN/Tor if
your threat model requires it); hiding *that* you use Noctis; regulatory
anonymity (the protocol is pseudonymous, deposits/exits have public
endpoints).

---

## 8. Security engineering

Privacy without safety is worthless. The protocol carries over battle-tested
patterns, each verified by its test suite (213 passing tests as of V2.5) and
an internal full-stack audit:

- **Gated arithmetic everywhere.** Every `FHE.sub` on a balance is preceded by
  `FHE.le` + `FHE.select` — encrypted underflow is impossible by construction.
- **No transfer before proof.** Physical funds move only after
  `FHE.checkSignatures` verifies the threshold decryption (the "deduct-auth"
  two-phase pattern).
- **Checks-Effects-Interactions + ReentrancyGuard** on all state-changing
  entry points; SafeERC20 for token motion; fee-on-transfer measured at
  deposit.
- **Pull-over-push** for ETH payouts with claimable fallback.
- **Circuit breakers.** Per-token daily withdrawal caps auto-pause the token;
  per-user pattern monitoring; per-request caps bound the blast radius of any
  KMS compromise.
- **Governance timelock** on parameter changes; guardian role is pause-only;
  fee recipient is a Safe; `MAX_FEE_BPS` hard cap in code.
- **EIP-170 discipline.** Vault and exchange sit near the 24 576-byte limit;
  compiler composition is pinned and the size is asserted in tests.
- **Bounded privacy costs.** Chaff K is owner-tunable (default 2, max 8) so
  the gas overhead of decoys is explicit and capped.

---

## 9. Protocol economics

- **Protocol fee:** 5 bps (0.05 %) per executed trade at launch, paid from
  settlement proceeds to the treasury Safe. Hard cap `MAX_FEE_BPS = 30`.
- **Gas refunds:** the relayer fronts gas for privacy; it is refunded in-kind
  from the traded token at settlement (`gasRecipient` = relayer float wallet,
  distinct from the treasury — no Safe round-trips). Cancelled orders cost the
  relayer; an off-chain policy bounds this griefing without touching privacy.
- **No token, no ponzinomics.** Revenue = fees. Privacy features (chaff,
  batching) have transparent, bounded gas costs borne by the flows that use
  them.

---

## 10. Roadmap: toward a fully dark pool (V3 netting)

Today, each trade's public Uniswap leg reveals its executed size (§7.3). The
V3 milestone — **homomorphic batch netting** — removes this last per-order
disclosure:

> Orders accumulate *encrypted* in fixed windows. Buys and sells on the same
> pair cancel each other *inside the FHE domain*. Only the window's **net
> residual** is decrypted and swapped on Uniswap. Crossed volume settles
> internally at oracle mid-price — zero slippage, zero LP fee, zero public
> footprint. With balanced flow the residual tends to zero and Noctis becomes
> a true dark pool whose operator cannot read the book.

The full design is specified in
[`ROADMAP_V3_NETTING.md`](./ROADMAP_V3_NETTING.md) and formalized in the
research paper
[`research/FHE_BATCH_NETTING.md`](./research/FHE_BATCH_NETTING.md), which
also proves the residual disclosure is the information-theoretic minimum for
any AMM-connected venue.

---

## 11. Glossary

| Term | Meaning |
|---|---|
| **FHE** | Fully Homomorphic Encryption — computing on encrypted data without decrypting it |
| **fhEVM** | Zama's extension of the EVM with FHE types and operations |
| **Handle** | 32-byte on-chain reference to a ciphertext stored on the coprocessor network |
| **ACL** | Access-control list deciding who may decrypt a given handle |
| **Input proof** | ZK proof that a client-encrypted value is well-formed and bound to one contract+sender |
| **Declassification** | The explicit, on-chain-verified act of making one encrypted value public |
| **KMS / threshold committee** | t-of-n nodes that jointly decrypt declassified values; no single node can |
| **euint128 / ebool / eaddress** | Encrypted integer / boolean / address types |
| **`FHE.select`** | Encrypted if/else — picks between two ciphertexts without revealing which |
| **Gated debit** | Subtracting `select(sufficient, amount, 0)` so failures are invisible |
| **VaultId** | Pseudo-random pseudonym replacing the user's address in relayed flows |
| **Relayer** | Service that submits users' transactions so `tx.from` never exposes them |
| **Keeper** | Service that triggers time-based protocol steps (settlement, payouts, flushes) |
| **ERC-7984** | Confidential fungible token standard (encrypted amounts) |
| **cUSDC** | Noctis's ERC-7984 wrapper around USDC |
| **Chaff / decoy writes** | Dummy `+0` balance rewrites masking which balance really changed |
| **Stealth exit** | Withdrawal to an encrypted, previously unlinked recipient |
| **Shredding** | Splitting a withdrawal into several tranches to distinct stealth addresses |
| **Batch window** | Fixed period grouping requests so they execute indistinguishably |
| **k-anonymity** | Being indistinguishable within a set of k participants |
| **MEV** | Maximal Extractable Value — profits extracted by reordering/front-running transactions |
| **Dark pool** | Trading venue whose order book is hidden until execution |
| **Netting** | Cancelling opposite flows internally so only the net difference trades publicly |
| **Subset-sum problem** | The (hard) puzzle an observer faces matching shredded payouts to a withdrawal |

---

*Noctis Protocol — 2026. This whitepaper describes protocol version V2.5
(Sepolia). Contracts, tests, and operational documentation live in the
protocol repository. The French edition of this document is
[WHITEPAPER_FR.md](./WHITEPAPER_FR.md).*
