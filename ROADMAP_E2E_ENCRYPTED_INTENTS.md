# Roadmap — End-to-End Encrypted Intents

**Status:** Phase A SHIPPED (MVP, 2026-08-09) — `createEncryptedOrderViaRelayer`
(browser-side FHE input encryption, bounds enforced at settlement) and
pseudo-random vaultIds are live on Sepolia. Sections below kept for the
phase B / Year 2 tracks (one-time order keys, signature-based cancel,
withdrawal batching, stealth-address settlement, encrypted direction).
**Scope:** contracts (`NoctisExchangeV2`, `NoctisVaultV2`), keeper, frontend, subgraph
**Goal:** shrink the trust window on order size from *relayer + anyone parsing calldata* down to *settlement only* (where the size becomes public at the Uniswap fill anyway).

---

## 1. Why Year 1, not MVP

Per VISION.md scoping rules:

- It **does not prevent fund loss or DoS** — it is a privacy upgrade. Funds are safe today; only trade-size metadata leaks pre-settlement.
- It **requires reworking the decryption flow**: order-size validation (min/max, oracle sanity) currently runs in cleartext at creation and must move to settlement time.
- It **changes the griefing surface** (invalid orders are only detectable after gas is spent) and therefore interacts with the relayer economic policy.
- Estimated effort is **3–5 weeks** across all four components, including a re-audit of the FHE paths.

The MVP boundary stays as documented: encrypted balances, relayer trusted with order size, fill public at settlement.

---

## 2. Privacy audit — remaining critical spots (current V2)

Ranked by severity. "Observer" = anyone with an archive node / explorer, no special access.

### P0 — Order parameters are public in relayer calldata

`createMarketOrderViaRelayer(vaultId, baseToken, amountBase, isBuy, …)` puts the
**amount, direction, pair and vaultId in cleartext calldata** of a public
transaction. This is strictly worse than "the relayer sees it": *any observer*
sees it. The on-chain `FHE.asEuint128(amountBase)` encryption is cosmetic for
this path — the plaintext is one click away in the tx input data.

### P0 — vaultId is trivially linkable to the trader address

Two independent breaks:

1. **Sequential assignment**: `nextVaultId++` on first deposit. Deposits are
   public, attributable transactions — replaying deposit order recovers the
   `vaultId ↔ address` table with no storage access at all.
2. **`private` storage is not confidential**: `vaultOwners`, `userVaultId`,
   `orderTraders`, `orderVaultIds` are plaintext storage slots readable via
   `eth_getStorageAt`. Solidity `private` only removes the getter.

Combined with P0 above, a motivated observer fully deanonymizes the relayed
path today: **who, how much, which direction, when**. Current unlinkability
holds only against casual explorer users.

### P1 — vaultId links all orders of a user together

Even with an encrypted amount, a constant `vaultId` in calldata clusters every
order of the same trader (frequency, timing, pairs). Cross-order profiling.

### P2 — Deposit / withdrawal amounts and timing

Deposits and withdrawal claims are ordinary transactions from the user's own
address. Size-matching a deposit to the next fill (or a fill to the next
withdrawal) re-identifies trades. Documented as "privacy hygiene" today; no
protocol-level mitigation.

### P2 — Off-chain metadata (relayer + frontend API)

- The relayer HTTP endpoint sees the **client IP** next to the full intent.
- The Vercel API routes (`/api/fhevm/balance-handle?user=0x…`) log
  `user address ↔ IP ↔ token of interest` server-side.
- User `eth_call`s (`getMyVaultId`, `getMyOrder`) leak address ↔ interest to
  the public RPC operator.

### P3 — Settlement-time publicity (by design, disclosed)

`requestSwapExecution` makes the amount handle publicly decryptable via the
ZAMA gateway; the Uniswap fill then exposes size and direction. This is the
accepted, documented boundary — E2E intents do not (and cannot) change it.

---

## 3. Target design — encrypted intent, end to end

### 3.1 Flow

```
user (browser)                        relayer                       chain
--------------                        -------                       -----
SDK createEncryptedInput(
  exchange, userAddr)
  -> handle_amount + inputProof       sees: handle (opaque),
EIP-712 sign over                     pair, direction*, gasRefund,
  (handle, pair, direction,           IP — NOT the amount
   slippage, gasRefund, nonce) ────►  verify sig, policy check ──►  createEncryptedOrderViaRelayer(
                                                                      vaultId, baseToken,
                                                                      externalEuint128, proof, …)
                                                                    FHE.fromExternal -> euint128
                                                                    store; NO cleartext checks
…settlement unchanged: requestSwap -> gateway publicDecrypt -> executeSwap(amount public)
```

\* direction stays cleartext in phase A (see 3.4).

### 3.2 Contract changes (`NoctisExchangeV2` or V3)

- New entrypoint `createEncryptedOrderViaRelayer(uint256 vaultId, address baseToken,
  externalEuint128 encAmount, bytes inputProof, bool isBuy, uint16 slippageBPS,
  uint16 maxDevBPS, uint128 gasRefundWei)` using `FHE.fromExternal`.
  Input proofs are cryptographically bound to `(contract, user)` — the relayer
  cannot substitute a different amount without invalidating the proof.
- **Move cleartext validations to settlement.** `minOrderSize` / `maxOrderSize`
  / zero-amount checks cannot revert on an encrypted value at creation.
  The amount is already publicly decrypted at `requestSwapExecution` →
  `executeSwap`; enforce the bounds there and route violations to
  auto-cancel (refund path) instead of revert-and-strand.
  - Optional creation-time variant: compute `ebool valid = FHE.ge(amt, min) and FHE.le(amt, max)`
    and add it to the decryption handle set, so an out-of-bounds order is
    detected at the same decrypt step that already exists (no extra round-trip).
- Oracle reference price is still snapshotted at creation (public, fine);
  the deviation check against it runs at execution with the decrypted amount —
  unchanged from today.
- EIP-712 struct gains the `bytes32` amount handle (replaces `amountBase`).
- Keep the plaintext self-relay path (`createMarketOrder`) as-is: the user's
  own `tx.from` already deanonymizes it; encrypting the amount there adds cost
  for no benefit.

### 3.3 Keeper changes

- Relay endpoint accepts `{handle, inputProof}` instead of `amountBase`;
  signature verification binds the handle. The keeper never sees the size.
- **Relay policy is already compatible**: it meters gas spent vs. settled,
  not amounts. New failure mode — an order below `minOrderSize` is only
  discovered at settlement — is exactly what the settlement-ratio throttle
  and per-user in-flight cap were built for. Tune `RELAY_MIN_SETTLE_RATIO`
  after rollout.
- Scrub any remaining request-body logging on the relay endpoints.

### 3.4 What stays cleartext in phase A (and why)

| Field | Why it stays clear |
|---|---|
| `baseToken` (pair) | Needed to route validation/settlement; low entropy; public at fill anyway |
| `isBuy` (direction) | Needed for the SELL-lock vs BUY-quote branching at creation; public at fill. Encrypting it (ebool + dual-path select) is possible but doubles FHE cost — phase B candidate |
| `gasRefundWei` | Correlates with gas price, not order size |
| `vaultId` | Identity — addressed separately (see 4) |

### 3.5 Estimated effort (phase A)

| Work item | Estimate |
|---|---|
| Contract entrypoint + validation move + tests | 1.5 weeks |
| Keeper endpoint + EIP-712 + policy tuning | 0.5 week |
| Frontend SDK input encryption + signing flow | 0.5 week |
| Subgraph (no schema change expected) + E2E smoke | 0.5 week |
| FHE-path re-review (skill `fhe-solidity` checklist) | 0.5 week |

---

## 4. Solutions for the residual identity leaks

These are **not solved by encrypted intents** and need their own tracks.

### 4.1 vaultId linkability (P0/P1)

- **Short term (cheap, phase A):** assign vaultIds pseudo-randomly
  (`keccak256(user, salt)` truncated, collision-checked) instead of
  sequentially — kills the deposit-order replay attack. Storage-read
  linkage remains.
- **Medium term (phase B):** per-order one-time IDs: the user derives
  `orderKey = keccak256(sig(nonce))` and registers it via an encrypted
  binding in the vault; calldata carries only the one-time key, so orders
  from one trader no longer cluster. Requires a vault mapping keyed by
  one-time IDs with FHE-checked ownership at settlement credit.
- **Long term (Year 2):** stealth-address settlement — credit fills to
  one-time addresses derived from a user master key (ERC-5564-style),
  removing the plaintext `orderTraders` storage entirely. Heavy: changes
  cancellation auth, credit path, and the desk UX.

### 4.2 Plaintext identity storage (`orderTraders`, `vaultOwners`) (P0)

- Accept and **document** in phase A (storage reads require more effort than
  calldata parsing, but assume a capable adversary).
- Phase B: replace `orderTraders` auth with signature-based cancellation
  (user signs `cancel(orderId)`, contract verifies against the encrypted
  `eaddress` via gateway or against the one-time order key), letting the
  plaintext mapping be dropped.

### 4.3 Deposit/withdraw correlation (P2)

- UI nudges: suggest round deposit sizes, delayed withdrawals, partial
  withdraws (already in docs — make it interactive).
- Protocol option: withdrawal batching windows (all claims in a window settle
  together), which breaks 1:1 timing. Cheap to add to the pull pattern.

### 4.4 Off-chain metadata (P2)

- Relayer: strip client IP from logs, support submission through a proxy/CDN;
  document that a privacy-conscious user should use a VPN.
- Frontend API: stop passing `user` as a query param where possible
  (POST body, no-log), set `Cache-Control: no-store`.
- RPC: document private-RPC endpoints for balance/order view calls; the
  `balance-handle` route already proxies through our own RPC — extend the
  same pattern to `getMyOrder` polling.

---

## 5. Rollout order

1. **A0 (now, no code):** update docs to state the calldata reality — the
   relayed path's amount is public on-chain today, not merely relayer-visible.
2. **A1:** random vaultIds + encrypted-intent entrypoint + keeper/frontend
   support, behind a `tradeConfig` flag per pair. Old entrypoint stays for
   rollback.
3. **A2:** flip the desk default to encrypted intents; monitor settle-ratio
   and HCU costs for two weeks; then disable the plaintext relayer entrypoint.
4. **B:** one-time order keys + signature-based cancel + withdrawal batching.
5. **Year 2:** stealth-address settlement, encrypted direction.

## 6. Open questions

- HCU budget: `FHE.fromExternal` + optional validity `ebool` per order —
  measure against the per-tx HCU cap on Sepolia before committing to the
  creation-time validity variant.
- Auto-cancel on out-of-bounds amount: refund path must not become a free
  decrypt oracle for probing other users' balances (it does not today —
  sufficiency ebool only ever concerns the order's own trader — keep it so).
- Does ZAMA's input-proof registration (SDK → coprocessor) leak the plaintext
  to ZAMA's relayer service? Per SDK docs encryption is client-side and only
  ciphertext + proof leave the browser — verify against the current
  `@zama-fhe/relayer-sdk` version before claiming it in docs.
