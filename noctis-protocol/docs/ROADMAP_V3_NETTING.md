# ROADMAP — Noctis V3: FHE Batch Netting (Dark-Pool Settlement)

> Status: **DESIGN** (Year 1 / V3 milestone — not MVP)
> Companion research paper: [`docs/research/FHE_BATCH_NETTING.md`](./research/FHE_BATCH_NETTING.md)
> Prerequisites: V2.5 shipped (confidential deposits, chaff writes, stealth exits v2, shredding)

## 1. Problem statement

After V2.5, the last structural privacy leak in Noctis is the **settlement route
itself**: every order — whatever we hide about its owner and size before
settlement — ends as a public Uniswap swap. The swap's `amountIn`, direction,
and timing are visible in the pool's `Swap` event, and every settlement window
leaks the *aggregate* of what Noctis traded.

| What leaks at settlement today | Via |
|---|---|
| Exact per-order size | Uniswap `Swap` event amounts |
| Direction (buy/sell) | Swap token ordering |
| Timing | Block number of the settlement tx |
| Noctis aggregate flow | All swaps originate from the exchange contract |

Chaff writes hide *whose vault balance* moved; they cannot hide *what the
exchange bought or sold on a public AMM*.

## 2. Core idea

**Match orders against each other inside the FHE domain, and only route the
residual imbalance to Uniswap.**

Within a netting window (e.g. 60–300 s), BUY and SELL orders on the same pair
partially cancel out. If the window contains 40 000 USDC of buys and
34 000 USDC of sells, only the **net 6 000 USDC** touches Uniswap. The 34 000
USDC that crossed internally never appears on any public venue — those orders
settle peer-to-peer at the oracle mid-price with **zero slippage, zero LP fee,
and zero public footprint**.

This is exactly what a traditional dark pool does; the novelty is doing the
aggregation **homomorphically**, so not even the operator (keeper) learns
individual order sizes — only the final net residual is ever decrypted.

```text
        window W (encrypted)                       public chain
  ┌────────────────────────────┐
  │ buy  e(12 000)             │
  │ sell e(9 000)              │      FHE sum      ┌──────────────────┐
  │ buy  e(28 000)   ──────────┼──► e(net = 6 000) │ 1 Uniswap swap:  │
  │ sell e(25 000)             │   publicDecrypt   │ BUY 6 000 USDC   │
  └────────────────────────────┘   (net only)      └──────────────────┘
   4 orders, 74 000 USDC gross                     observer sees 6 000
```

## 3. Architecture

### 3.1 New contract: `NoctisNettingEngine`

Separate contract (EIP-170: vault has 67 bytes headroom, exchange 482 — no
room in either). The engine owns the window lifecycle:

```solidity
struct Window {
    uint64  openedAt;
    uint64  closesAt;
    euint128 buyTotal;    // homomorphic accumulator, USDC terms
    euint128 sellTotal;   // homomorphic accumulator, USDC terms
    uint32  orderCount;   // public count (k-anonymity indicator)
    WindowState state;    // Open -> Sealed -> Priced -> Settled
}
```

Flow per pair:

1. **Accumulate** — `submitToWindow(orderId, encryptedUsdcNotional)`:
   `buyTotal = FHE.add(buyTotal, amt)` or `sellTotal += amt` via
   `FHE.select(isBuy, ...)` so even the side can be encrypted (oblivious
   dispatch option, §6).
2. **Seal** — at `closesAt`, the keeper seals the window. The engine computes
   `netIsBuy = FHE.ge(buyTotal, sellTotal)` and
   `netAmount = FHE.select(netIsBuy, buyTotal - sellTotal, sellTotal - buyTotal)`,
   then `FHE.makePubliclyDecryptable(netAmount)` + `netIsBuy`.
   **Only the residual ever leaves the FHE domain.**
3. **Price** — keeper submits the decrypt proof; the engine executes ONE
   Uniswap swap for `netAmount` (existing exchange slippage/deviation guards
   apply). Execution price for internal crosses = oracle mid (Chainlink) at
   seal block, bounded by `maxPriceDeviationBPS`.
4. **Settle** — per-order payouts happen through the existing
   `creditBalanceByVaultId` path **with chaff writes**, so the storage diff of
   the settlement loop does not reveal which vaults participated. Pro-rata
   fills: if the window nets long, sells fill 100%, buys fill
   `sellTotal/buyTotal` pro-rata plus their share of the Uniswap residual.

### 3.2 Pro-rata math under FHE

Division is not available homomorphically at acceptable cost. Approach:
decrypt only the two **totals-derived public scalars** needed for pro-rata:
`fillRatioBPS = min(10000, 10000 * oppositeTotal / sideTotal)` — computed from
the same publicly-decrypted `netAmount` (the totals themselves stay encrypted;
`sideTotal - oppositeTotal = ±netAmount` gives the ratio only if one total is
also revealed).

Two options, trading privacy vs precision:

| Option | Reveals | Per-order fill |
|---|---|---|
| A (max privacy) | net only | keeper distributes per-order fills via FHE mul-by-public-scalar `FHE.mul(orderAmt, ratioBPS) / 10000` — ratio derived off-chain from its own order flow knowledge? **No — keeper doesn't know totals.** Requires revealing one total. |
| B (pragmatic) | net + gross per side (2 scalars/window) | exact pro-rata on-chain with public ratio |

**Decision: Option B.** Revealing the per-side gross of a whole window is the
k-anonymous aggregate (the same quantity the confidential-deposit flush
already reveals) — acceptable, and it makes fills exact and auditable.

### 3.3 Keeper changes

- Window scheduler: seal → decrypt(net, grossBuy, grossSell) → price → settle.
- Failure handling: if the Uniswap leg reverts (slippage), the window re-opens
  for one retry with a fresh oracle price; orders can cancel between windows.
- All settlement txs already run with the private-tx RPC option (V2.5).

### 3.4 What changes for the user

Nothing in the happy path: same order form. Latency rises from ~30 s to the
window length (60–300 s). Internal crosses get **better** execution (no
slippage, no LP fee — mid-price). Fee split: internal crosses still pay the
protocol fee (that is the dark-pool product).

## 4. Privacy gained

| Leak (V2.5) | After V3 netting |
|---|---|
| Per-order size in Uniswap event | Gone for the crossed volume; only the window residual is visible |
| Per-order direction | Gone (residual direction is the *aggregate* imbalance) |
| Per-order timing | Quantized to window boundaries |
| Noctis aggregate flow | Only residuals — gross internal volume invisible |

With balanced two-sided flow, the residual → 0 and Noctis becomes a **true
dark pool**: no public venue sees anything at all.

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Thin windows (1 order) = no netting, degenerate to V2.5 | publish `orderCount` per window; UI shows "dark liquidity" indicator; min window occupancy before internal crossing activates (else route 100% to Uniswap as today) |
| Oracle mid manipulation for internal crosses | Chainlink + `maxPriceDeviationBPS` vs Uniswap TWAP double-check (already in exchange) |
| Keeper censorship of window orders | orders carry deadlines; unfilled orders auto-refund via existing cancel path; keeper reputation is observable (missed-window metrics page) |
| HCU limits on accumulate loop | accumulation is O(1) FHE ops per order (one add + one select), amortized per order — measured at ~200k HCU, well under limits |
| Pro-rata rounding dust | round down per order, sweep dust to the fee recipient (public, auditable) |

## 6. Extensions (design options, post-V3)

- **Oblivious dispatch**: encrypt the buy/sell side itself (`ebool isBuy`
  inside the FHE accumulate). Calldata then reveals only "an order exists".
- **Encrypted deadlines**: FHE-gated windowing per order
  (`FHE.ge(now, encDeadline)`) to decorrelate submission from execution time.
- **Cross-pair netting**: net ETH/USDC buys against WBTC/USDC sells through
  the shared USDC leg (triangular netting — see research paper §7).

## 7. Milestones

| # | Deliverable | Est. |
|---|---|---|
| M1 | `NoctisNettingEngine` accumulate/seal/price/settle + unit tests (mock mode) | 2 w |
| M2 | Keeper window scheduler + failure/retry paths | 1 w |
| M3 | Exchange integration (route orders through engine when window occupancy ≥ N) | 1 w |
| M4 | Sepolia deploy + E2E smokes (crossed window, one-sided window, revert-retry) | 1 w |
| M5 | Frontend: window countdown, dark-liquidity indicator, fill breakdown | 1 w |

Total ≈ 6 weeks. Gate for mainnet: ≥ 2 weeks of Sepolia windows without a
settlement incident.
