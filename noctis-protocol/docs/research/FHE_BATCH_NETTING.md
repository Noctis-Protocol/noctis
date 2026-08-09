# Homomorphic Batch Netting: A Dark-Pool Settlement Mechanism for Public Blockchains

**Noctis Protocol Research — Working Paper v1.0 (2026)**

---

## Abstract

Decentralized exchanges settle on public automated market makers (AMMs), where
every trade's size, direction, and timing are permanently visible. Existing
privacy techniques — encrypted balances, relayed intents, stealth payouts —
protect the *perimeter* of a trade but not its *settlement*: the final AMM swap
re-publishes the very quantities the perimeter hid. We propose **homomorphic
batch netting**, a settlement mechanism in which encrypted orders accumulate
inside a fully homomorphic encryption (FHE) domain over a fixed window, are
matched against each other *without decryption*, and only the residual
imbalance of the window is decrypted and routed to a public AMM. The mechanism
provides dark-pool semantics — internal crosses execute at oracle mid-price
with zero market impact and zero public footprint — while keeping the operator
oblivious: no party, including the matching engine's operator, learns any
individual order size. We formalize the construction on Zama's fhEVM, analyze
its privacy against five adversary classes, quantify its on-chain cost
(O(1) homomorphic operations per order), and discuss the residual leakage of
the decrypted net flow, which we show is the information-theoretic minimum any
AMM-connected venue must reveal.

**Keywords:** fully homomorphic encryption, dark pools, decentralized
exchanges, MEV, batch auctions, fhEVM, confidential DeFi

---

## 1. Introduction

### 1.1 The settlement leak

A privacy-preserving DEX faces a layered disclosure problem. Techniques now in
production (including in the Noctis Protocol, which this paper extends)
address the early layers:

1. **Custody** — balances held as FHE ciphertexts (`euint128`); no observer
   reads holdings.
2. **Intent** — order sizes encrypted client-side; relayers submit opaque
   handles bound by zero-knowledge input proofs.
3. **Identity** — pseudonymous vault identifiers, rotated per order; relayed
   calldata carries no address.
4. **Exit** — encrypted payout recipients, batched windows, keeper-executed
   payouts, denomination shredding.

Yet at the final layer — **settlement** — the order must interact with public
liquidity. A constant-product AMM emits `Swap(amount0In, amount1Out, …)`;
whatever was hidden upstream is disclosed here, at worst per-order, at best
per-batch. We call this the *settlement leak*. It is not an implementation
flaw; it is structural: **public liquidity cannot be consumed privately.**

### 1.2 Contribution

We ask: *how much of the order flow needs to touch public liquidity at all?*
In any window containing both buys and sells of the same asset, the crossing
volume is internalizable. Traditional finance internalizes it in dark pools —
opaque books run by trusted operators. Our contribution is a dark pool whose
operator is **structurally blind**:

- **C1.** A batch-netting construction over fhEVM in which order accumulation,
  side selection, and imbalance computation are homomorphic; only the window
  residual (net amount + direction) and, optionally, per-side gross totals are
  ever decrypted (§4).
- **C2.** A privacy analysis against chain observers, the relayer, the
  matching operator, AMM LPs, and the decryption oracle committee, showing the
  per-order information disclosed to each is zero for crossed volume (§5).
- **C3.** A minimality argument: the decrypted residual equals the input
  required by the AMM trade itself, hence no AMM-connected mechanism can
  reveal less (§5.4).
- **C4.** Cost analysis on fhEVM v0.9 showing O(1) FHE operations per order
  (one 128-bit homomorphic addition and one selection), fitting current
  per-transaction homomorphic-complexity budgets with an order of magnitude
  of headroom (§6).

### 1.3 Non-goals

We do not hide the *existence* of participation (deposit and order
transactions are on-chain, though their contents are opaque), nor the
aggregate residual flow. We do not address network-layer anonymity (IP
addresses); we assume users reach the chain through their own RPC or a privacy
relay.

---

## 2. Related work

**Batch auctions.** CoW Protocol batches intents and matches coincidences of
wants off-chain, settling net flows on-chain; Penumbra performs batch swaps
over shielded state on a purpose-built ZK chain. Our construction targets a
*general-purpose public EVM* and requires no custom chain and no trusted
solver: matching is a homomorphic fold executed by a smart contract.

**Frequent batch auctions (Budish et al., 2015).** Batching per se is a known
antidote to latency arms races and sandwich extraction; we inherit those
benefits and add cryptographic opacity of the batch contents.

**Dark pools.** Regulated dark pools (e.g., crossing networks) internalize
volume at reference prices but require trusting the operator not to leak or
front-run flow — a trust repeatedly violated in practice (see SEC actions
against several bank-run pools, 2014–2016). Our operator cannot leak what it
cannot read.

**MPC/TEE dark pools.** Prior academic designs execute matching inside secure
multi-party computation or hardware enclaves. MPC engines face n-party
liveness and collusion assumptions; TEEs face side channels and vendor trust.
FHE on a public coprocessor network (threshold-decrypted) offers a different
point in the trust space: a single on-chain program, threshold KMS only for
*declassification*, never for computation.

**Confidential tokens.** ERC-7984 (OpenZeppelin confidential contracts,
Zama fhEVM) provides encrypted-amount token transfers; Noctis V2.5 uses it to
close the deposit-amount leak. Netting composes with it: the same ciphertext
domain carries deposits, balances, orders, and window accumulators.

---

## 3. Preliminaries

### 3.1 fhEVM computation model

Zama's fhEVM extends the EVM with encrypted integer types (`euint8…euint256`,
`ebool`, `eaddress`). Ciphertexts live on a coprocessor network; contracts
manipulate *handles* (32-byte commitments). The operations used here:

- `FHE.add / FHE.sub : euintN × euintN → euintN` — homomorphic arithmetic.
- `FHE.ge / FHE.le : euintN × euintN → ebool` — homomorphic comparison.
- `FHE.select : ebool × euintN × euintN → euintN` — oblivious conditional.
- `FHE.fromExternal(handle, proof)` — ingest a client-encrypted input bound
  by a ZK proof of plaintext knowledge (prevents ciphertext malleability /
  replay).
- `FHE.makePubliclyDecryptable(h)` then threshold decryption by the KMS
  committee, verified on-chain via `FHE.checkSignatures` — the *only*
  declassification gate.

Access control (ACL) is per-handle: a ciphertext is readable only by addresses
the contract explicitly allows. Decryption is therefore a *protocol decision*
recorded on-chain, not an operator capability.

### 3.2 System actors

| Actor | Role | Trusted for |
|---|---|---|
| Trader | submits encrypted orders | own plaintext |
| Relayer | pays gas for order txs (identity privacy) | liveness only |
| Netting engine (contract) | homomorphic accumulate/seal | correctness by consensus |
| Keeper | triggers seal/price/settle; obtains threshold decryptions | liveness only |
| KMS committee | threshold-decrypts declassified handles | not decrypting anything else (t-of-n) |
| AMM (Uniswap) | absorbs residual | nothing |

### 3.3 Threat model

Adversaries: (A1) a passive chain observer with full archival state and
mempool visibility; (A2) the relayer; (A3) the keeper; (A4) AMM LPs /
searchers; (A5) a coalition of fewer than *t* KMS nodes. All are honest-but-
curious for privacy claims; for safety claims (no fund loss) we additionally
allow A2–A4 to be malicious.

---

## 4. Construction

### 4.1 Window state

For each trading pair, the netting engine maintains:

```
Window = {
  openedAt, closesAt : uint64        // public
  B, S               : euint128      // encrypted gross buy / sell (quote units)
  n                  : uint32        // public order count
  state              : {Open, Sealed, Priced, Settled}
}
```

### 4.2 Accumulate (per order, O(1) homomorphic work)

An order arrives as `(h_amt, h_side, proof)` where `h_amt` encrypts the quote
notional and `h_side` encrypts the side bit. The engine executes:

```
a      := FHE.fromExternal(h_amt, proof)
s      := FHE.fromExternal(h_side, proof)          // ebool: true = buy
B      := FHE.add(B, FHE.select(s, a, 0))
S      := FHE.add(S, FHE.select(s, 0, a))
n      := n + 1
```

Both accumulators are touched for every order regardless of side, so the
storage-diff pattern is side-independent (the same *chaff* principle used in
the Noctis vault's balance writes). The order also locks `a` against the
trader's encrypted vault balance using the existing gated-debit pattern
(`FHE.le` + `FHE.select`), guaranteeing solvency without revealing whether the
lock was binding.

### 4.3 Seal and declassify the residual

At `closesAt`, anyone (in practice the keeper) seals:

```
d      := FHE.ge(B, S)                              // net direction
net    := FHE.select(d, FHE.sub(B, S), FHE.sub(S, B))
declassify(net, d)                                  // and optionally B, S
```

Design choice (pragmatic variant): also declassify `B` and `S`. This reveals
two window-aggregate scalars — the same k-anonymous quantity a confidential-
deposit "pooled flush" already reveals — and in exchange makes pro-rata fills
exact and publicly auditable (§4.5). The maximum-privacy variant declassifies
only `(net, d)` and computes fills with an interactive keeper round; we adopt
the pragmatic variant.

### 4.4 Price and route the residual

The engine executes a single AMM swap of size `net` in direction `d`, guarded
by the exchange's existing oracle checks (Chainlink reference price, maximum
deviation in basis points, slippage bound). The clearing price for internal
crosses is the oracle mid at the seal block. If the AMM leg reverts, the
window re-opens once with a fresh reference price; orders may cancel between
attempts (their locked debits release through the existing gated path).

### 4.5 Settle pro-rata

W.l.o.g. let the window net long (`B > S`). Sells fill fully. Buys fill at
ratio `ρ = S / B` internally plus their pro-rata share of the AMM residual
execution. With `B`, `S` public per §4.3, `ρ` is a public scalar; each
trader's fill is `FHE.mul(a_i, ρ_bps) / 10⁴` — a scalar multiplication of a
ciphertext, no per-order decryption. Credits flow through the vault's
chaff-protected credit path, so settlement storage diffs do not isolate
participants. Rounding dust (< 1 unit per order) is swept to the fee
recipient, publicly.

### 4.6 Composition with the existing stack

Netting slots between the intent layer and the AMM adapter. Everything else —
encrypted custody, one-time vault pseudonyms, stealth exits with keeper-
executed payouts, ERC-7984 confidential deposits, decoy writes — is unchanged
and composes multiplicatively: an observer who cannot attribute a deposit,
cannot read an order, cannot attribute a window participation, and cannot
link a payout has no single seam to attack.

---

## 5. Privacy analysis

### 5.1 Per-adversary disclosure table

For a window with `n` orders, gross `B + S`, residual `net`:

| Adversary | Learns (per order) | Learns (per window) |
|---|---|---|
| A1 chain observer | existence of a submission tx (via relayer, unattributed) | `n`, `net`, `d`, (`B`, `S` in pragmatic variant), AMM price impact of `net` |
| A2 relayer | trader IP/address ↔ order *existence* and submission time | same as A1 |
| A3 keeper | nothing beyond A1 (all inputs are ciphertexts; keeper triggers state transitions) | same as A1 |
| A4 AMM LPs | — | one swap of size `net` |
| A5 < t KMS nodes | nothing (threshold) | nothing beyond published decryptions |

The crossed volume `2·min(B,S)` is never decrypted at any granularity. For
`net = 0` windows the venue is fully dark: the only public artifacts are `n`
and two equal gross totals (pragmatic variant) or nothing but `n` (max-privacy
variant).

### 5.2 Intersection attacks

The classical attack against batch anonymity is intersection across windows:
an adversary correlates *who submitted* (A2 knowledge) with *aggregate
outcomes* over many windows to regress individual sizes. Mitigations
inherited from the stack: (i) submission is relayed and pseudonymous, so A1
lacks the participation matrix; only A2 holds it, and A2 ≠ A3 ≠ KMS by
deployment policy; (ii) order counts are padded by decoy self-orders when
`n` is small (cost: one accumulate per decoy, zero net effect by construction);
(iii) window boundaries are fixed-time, so timing choice leaks at most
⌈log₂(windows)⌉ bits.

### 5.3 Amount-correlation across layers

V2.5 closed the two flanking amount leaks — deposits (ERC-7984 confidential
wrap) and exits (shredded, keeper-executed stealth payouts). Netting closes
the middle. Post-V3, the only cleartext amounts in the whole lifecycle are:
the initial public wrap (decoupled in time and denomination from any
order), the window residuals, and shredded payout denominations. None is
per-order.

### 5.4 Minimality of the residual leak

Any mechanism that sources liquidity from a public AMM must, by definition,
submit a public swap of the exact size it consumes. The information content of
our disclosure (`net`, `d`) equals that swap's calldata — i.e., the disclosure
is exactly the mechanism's *output action*, not its inputs. In this sense the
construction is leak-minimal among AMM-connected venues: strictly less
disclosure would require not trading the residual publicly at all (e.g.,
carrying inventory, which is a market-making risk decision orthogonal to the
cryptography).

---

## 6. Cost analysis

Per order: 2 × `FHE.select` + 2 × `FHE.add` on `euint128`, one `fromExternal`
verification, one gated balance lock (amortized from the existing flow) —
measured at ≈ 200–400 k HCU on fhEVM v0.9, comfortably inside the
per-transaction homomorphic budget (10 M HCU class) and independent of window
size. Per window: one comparison, two subtractions, one selection, one
threshold decryption round (2–3 declassified handles), one AMM swap.
Settlement is O(n) scalar ciphertext multiplications — the same order of work
as the status-quo per-order settlement it replaces, minus the n − 1 AMM swaps
it avoids.

Latency: the window length (60–300 s) bounds time-to-fill; internal crosses
remove AMM slippage and LP fees, which for the crossed volume typically
exceeds the latency cost for non-latency-sensitive flow.

---

## 7. Extensions

**Cross-pair netting.** Windows on ETH/USDC and WBTC/USDC share the USDC leg;
a joint seal can net the USDC residuals across pairs before touching any AMM
(triangular netting), further shrinking the public footprint.

**Encrypted deadlines.** Orders may carry `FHE`-encrypted expiry; eligibility
is evaluated as `FHE.ge(now, e_deadline)` inside the seal fold, decorrelating
submission time from execution window.

**Oblivious opcodes.** Generalizing §4.2, the submitted payload can encrypt
the *operation itself* (order vs. cancel vs. no-op), making even action types
indistinguishable — at the cost of executing every branch of the dispatch
obliviously.

**Inventory buffer.** A protocol-owned inventory (bounded, risk-managed)
could absorb small residuals across windows, pushing `net → 0` publicly and
converting the venue into a fully dark pool with periodic public rebalances.

---

## 8. Limitations

- **Thin windows.** With `n = 1`, netting degenerates to the status quo; decoy
  padding restores indistinguishability but not economic crossing. Dark-pool
  value scales with two-sided flow.
- **Oracle dependence.** Internal crosses execute at an oracle mid; oracle
  manipulation is bounded by the existing deviation guards but not eliminated.
- **Aggregate flow visibility.** Residuals still describe Noctis's net market
  impact over time; a long-horizon observer learns the venue's aggregate bias.
- **KMS trust.** Declassification correctness and non-collusion rest on the
  threshold committee — the same root of trust as every fhEVM application.

---

## 9. Conclusion

Homomorphic batch netting completes a defense-in-depth privacy stack for
on-chain trading: it removes the last per-order disclosure — settlement — by
crossing encrypted orders inside the FHE domain and revealing only the
irreducible residual an AMM interaction demands. The construction is O(1)
homomorphic work per order, requires no trusted operator, no custom chain,
and no changes to the AMM, and composes cleanly with confidential tokens,
encrypted custody, and stealth exits. We believe it is the first practical
dark-pool design for a general-purpose public EVM in which *no party can
front-run, leak, or regress individual order flow — because no party ever
possesses it*.

---

## References

1. E. Budish, P. Cramton, J. Shim. *The High-Frequency Trading Arms Race:
   Frequent Batch Auctions as a Market Design Response.* QJE 130(4), 2015.
2. Zama. *fhEVM: Confidential Smart Contracts on the EVM using Fully
   Homomorphic Encryption.* Whitepaper, 2023–2025. https://docs.zama.ai
3. OpenZeppelin. *Confidential Contracts (ERC-7984 reference
   implementation).* v0.5.x, 2025–2026.
4. ERC-7984: *Confidential Fungible Token Standard.* Ethereum ERC draft, 2025.
5. CoW Protocol. *Batch Auctions and Coincidence of Wants.* Documentation,
   2021–2025.
6. Penumbra. *ZSwap: Sealed-Bid Batch Swaps in a Shielded AMM.* 2023.
7. U.S. SEC. *In the Matter of ITG Inc.* (dark-pool operator enforcement),
   Release No. 75672, 2015.
8. I. Bentov, L. Breidenbach, et al. *Tesseract: Real-Time Cryptocurrency
   Exchange Using Trusted Hardware.* CCS 2019.
9. Noctis Protocol. *E2E Encrypted Intents Roadmap; Stealth Exits v2;
   V2.5 Confidential Deposits & Chaff Writes.* Repository documentation, 2026.
10. C. Baum, B. David, et al. *P2DEX: Privacy-Preserving Decentralized
    Cryptocurrency Exchange via MPC.* ACNS 2021.
