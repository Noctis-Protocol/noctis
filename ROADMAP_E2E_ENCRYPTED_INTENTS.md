# Roadmap — End-to-End Encrypted Intents

**Status:** Phases A, B, Year 2 (stealth exits), stealth exits v2 (unlinkable payouts) **and V2.5 (confidential deposits + chaff + shredding)** SHIPPED (2026-08-09).

- **Phase A** — `createEncryptedOrderViaRelayer` (browser-side FHE input
  encryption, bounds enforced at settlement) and pseudo-random vaultIds.
- **Phase B** — live on Sepolia (V2.2):
  - **One-time vaultIds (rotation):** the vault rotates a trader's vaultId
    whenever a relayed order reaches a terminal state (fill or cancel), so
    relayed-order calldata never shows the same pseudonym across sequential
    orders — orders stop clustering by id. This supersedes the originally
    sketched "one-time order keys with encrypted binding": any on-chain
    verifiable key↔user binding is publicly computable without ZK, whereas
    rotation delivers the same calldata-unlinkability with one storage
    rotation per settlement. Keeper authorizes post-creation steps against a
    persisted `orderId → owner` map (the creation pseudonym is dead by then);
    the economic policy is keyed by owner address so rotation cannot bypass
    per-user caps.
  - **Withdrawal batching windows:** `requestWithdrawalExecution` is quantized
    to `withdrawalBatchWindow` boundaries (300s on Sepolia, owner-tunable,
    capped at 1h) — payouts land together, breaking 1:1 fill→payout timing.
  - **Off-chain metadata hardening:** browser-side FHE encryption for private
    withdrawals too (the `/api/fhevm/encrypt` server route that received
    plaintext amounts is deleted), `Cache-Control: no-store` on the relayer
    and on `balance-handle`, no IP persisted in relay logs.
- **Year 2 — stealth exits** — live on Sepolia (V2.3):
  - **Encrypted withdrawal recipients (`eaddress`):** `requestWithdrawalPrivate`
    now takes a browser-encrypted `(amount, recipient)` pair. The payout
    destination is an opaque FHE handle on-chain from request until the payout
    executes (quantized to the batch window), so post-trade funds land on a
    **fresh address with no prior on-chain link** to the requester. ETH is
    pushed directly (fresh EOAs have no gas to pull; claimable fallback if the
    transfer is rejected); limits and pending counts stay keyed on the
    requester so stealth destinations cannot evade per-user caps.
  - This closes the useful half of "stealth-address settlement". The exit —
    the moment funds return to a spendable wallet — is where unlinkability
    pays; the lifecycle is now: attributable deposit → encrypted sizes +
    one-time pseudonyms while trading → stealth exit.
- **Stealth exits v2 — unlinkable payouts** — live on Sepolia (V2.4):
  the audit of V2.3 found the stealth exit leaked the requester↔recipient
  link three ways: the shared `requestId` joined `WithdrawalRequested` to
  `WithdrawalExecuted`; sequential request ids were reconstructible; and the
  requester's own wallet signed the execution txs (`tx.from`). Fixes:
  - **Anonymous request event:** `WithdrawalRequested(token, timestamp)` —
    no requestId, no requester. The requester recovers its ids via the
    caller-scoped `getMyWithdrawalRequestIds()`; the subgraph only counts.
  - **Pseudo-random requestIds:** keccak draws (same scheme as vaultIds), so
    payout-side ids cannot be replayed into an ordering.
  - **Keeper-executed payouts:** `requestWithdrawalExecution` is now
    permissionless after the batch window; the keeper polls
    `getDueWithdrawals()` and runs decrypt + callback from ITS wallet.
    The requester signs nothing after the request tx — no `tx.from` join.
    (A third party starting decryption only delays cancel by the bounded
    decryption timeout; payout gas is borne by the keeper — testnet-fine,
    fee line item later.)
  - **Metadata:** `balance-handle` moved GET→POST (no user address in access
    logs); vaultId scrubbed from relayer request logs.
  - Residual: archive-node storage replay (`withdrawalRequests[id].requester`)
    still reveals the link — same accepted storage-read boundary as
    `vaultOwners`; and cancellation intentionally re-links (no payout ever).
- **V2.5 — confidential deposits, chaff, shredding** — live on Sepolia
  (2026-08-09):
  - **ERC-7984 confidential USDC deposits:** `NoctisConfidentialToken` (cUSDC,
    OpenZeppelin confidential-contracts wrapper) + a vault
    `onConfidentialTransferReceived` hook. Deposit amounts are encrypted
    end-to-end (browser euint64 → vault euint128 credit); the per-token
    maxDeposit cap is enforced HOMOMORPHICALLY with an FHE-gated automatic
    refund (over-limit deposits credit 0 and bounce, invisibly). The keeper
    flushes the vault's pooled cUSDC buffer per window — only the SUM of a
    window's deposits is ever decrypted (k-anonymity), never individual
    amounts. This closes the deposit-amount correlation leak for USDC.
  - **Chaff decoy writes:** every settlement balance write (credit, deduct
    lock, withdrawal debit) also rewrites K decoy balances with
    `FHE.add(balance, 0)` — fresh, indistinguishable handles. A settlement
    tx's storage diff now touches K+1 balances, breaking the "which balance
    moved" side channel that made `vaultOwners` scrubbing moot.
    Owner-tunable `setChaffWrites` (default 2, hard cap 8).
  - **Withdrawal shredding:** `MAX_PENDING_WITHDRAWALS_PER_USER` raised 1→8;
    the withdraw UI splits one logical withdrawal into up to 8 equal tranches
    to distinct stealth recipients — payout-amount correlation becomes a
    subset-sum problem.
  - **Keeper private-tx option:** `PRIVATE_TX_RPC_URL` routes keeper-sent txs
    through a private relay (Flashbots Protect on mainnet); reads stay on the
    standard RPC.
  - Docs: bilingual whitepaper (`noctis-protocol/docs/WHITEPAPER{,_FR}.md`),
    V3 netting design (`docs/ROADMAP_V3_NETTING.md`), research paper
    (`docs/research/FHE_BATCH_NETTING.md`).
- **Explicitly out of scope (V3+, with rationale):**
  - **Removing `orderTraders`/`vaultOwners` plaintext storage entirely:**
    cryptographically blocked on fhEVM — the settlement credit path must index
    `balances[token][address]` with a plaintext key (mappings cannot be
    indexed by ciphertext), and storage-diffing the settlement tx reveals
    which funding balance was debited regardless of what the mappings say.
    True unlinkable balances need a shielded-pool design (ZK nullifiers),
    which is a different protocol, not a patch.
  - **Encrypted direction (`isBuy`):** feasible only by unifying SELL into
    the BUY-style two-leg flow (direction joins the existing public-decrypt
    handle set; the lock/sufficiency prepare moves post-decrypt). That is a
    settlement-machine rewrite with the exchange at **63 bytes** under the
    EIP-170 limit, for a field that becomes public at the Uniswap fill
    seconds later. Deliberately deferred to a V3 contract split.
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

1. ~~**A0/A1/A2:** encrypted-intent entrypoint, random vaultIds, keeper +
   frontend support.~~ **SHIPPED** (V2.1, 2026-08-09).
2. ~~**B:** one-time vaultIds (rotation at terminal states), withdrawal
   batching windows, off-chain metadata hardening.~~ **SHIPPED**
   (V2.2, 2026-08-09). Signature-based cancel is effectively live through the
   relayed EIP-712 path; dropping the plaintext `orderTraders` mapping is
   blocked on the settlement credit path (needs a plaintext address) and moves
   to the stealth-address track.
3. ~~**Year 2:** stealth exits — encrypted withdrawal recipients revealed only
   at payout, ETH push-with-fallback for fresh addresses.~~ **SHIPPED**
   (V2.3, 2026-08-09).
4. **V3+ (deliberate non-goals for this contract generation):** full removal
   of plaintext identity storage (needs a shielded-pool/ZK design — see
   scope note above) and encrypted direction (needs a settlement-flow
   unification + contract split to clear EIP-170).

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
