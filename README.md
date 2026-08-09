# Noctis

**Private Uniswap desk** — encrypted vault balances and unlinkable, relayer-submitted orders ([ZAMA](https://www.zama.ai/) FHE), settlement against Uniswap V2, **0.05%** protocol fee.

> Live pilot: **Ethereum Sepolia**. Soft mainnet is prepared but not required to run the testnet desk.

## Features

- Deposit ETH / USDC / listed tokens → **encrypted** vault balances  
- Gasless market orders → relayer + FHE proofs → Uniswap fill  
- Withdraw via pull pattern  
- Desk UI: live pool mid/depth, private “Reveal trades”, activity feed  

## Privacy model (honest boundary)

What stays private, from whom:

- **Vault balances — encrypted end-to-end.** Holdings live as FHE ciphertexts;
  the decryption ACL is granted to the owner only. Nobody — relayer included —
  can read a position or reconstruct balances before/after a trade.
- **End-to-end encrypted order size.** The amount is encrypted in the browser
  (ZAMA FHE input + ZK proof); the relayer and the public calldata only ever
  carry an opaque handle. Nobody — relayer included — learns the size before
  settlement. Order bounds are enforced on the KMS-proven cleartext at
  execution time.
- **Unlinkability with known limits.** `tx.from` is the relayer and the trader
  appears in no event or getter; vaultIds are pseudo-random AND one-time — the
  vault rotates a trader's pseudonym every time a relayed order fills or
  cancels, so sequential orders never share an id in calldata. Withdrawal
  payouts are quantized to batching windows to break fill→payout timing, and
  **stealth exits** let funds leave to a browser-encrypted destination that is
  revealed only when the payout executes — a fresh address with no prior
  on-chain link to the requester (ETH is pushed directly, no gas needed).
  The payout itself is **unlinkable**: the request event is anonymous (no
  requestId, no requester), request ids are pseudo-random, and the keeper —
  not the requester's wallet — signs the execution at the window boundary,
  so calldata/event observers have no join key between request and payout.
  Residual: raw storage reads (`eth_getStorageAt`) can still link a live
  pseudonym or balance slot to its address — removing that entirely needs a
  shielded-pool design, out of scope for this contract generation
  (`ROADMAP_E2E_ENCRYPTED_INTENTS.md`).
- **Trusted relayer for liveness only.** The relayer can censor or delay, but
  cannot read amounts, decrypt balances, alter EIP-712-signed parameters, or
  move funds outside the signed paths.
- **Fill size is public at settlement** — inherent to settling on Uniswap.

## Monorepo

```
noctis/
├── noctis-protocol/   # Solidity (Vault, Exchange, Timelock) + Hardhat
├── frontend/          # Next.js desk + FHE API routes
├── keeper/            # Relayer (Express) + ops monitor
└── subgraph/          # The Graph indexer
```

**Address SSOT:** `noctis-protocol/deployments/<network>.json`  
After every deploy, sync `frontend/.env.local` and `keeper/.env` from that file.

## Branches

| Branch | Role |
|--------|------|
| `dev` | Active development |
| `uat` | Staging / Sepolia pilot |
| `prod` | Release candidate / production |

Flow: **dev → uat → prod** (PRs). CI runs on all three.

## Requirements

- Node.js **24** (CI) / **22+** recommended (`@zama-fhe/relayer-sdk`)
- npm **10+**
- For contracts: see `noctis-protocol/package.json` (Hardhat + `@fhevm/*`)

## Quick start

```bash
git clone https://github.com/Noctis-Protocol/noctis.git
cd noctis
npm install

# Contracts
npm run protocol:compile
npm run protocol:test

# Desk (Sepolia)
cp frontend/.env.example frontend/.env.local
# Fill NEXT_PUBLIC_* from noctis-protocol/deployments/sepolia.json
cd frontend && npm install && npm run dev

# Relayer (separate terminal)
cp keeper/.env.example keeper/.env
# Fill VAULT_ADDRESS / EXCHANGE_ADDRESS / KEEPER_PRIVATE_KEY
cd keeper && npm install && npm start
```

Sepolia SSOT (current pilot):

```bash
cat noctis-protocol/deployments/sepolia.json
```

## Scripts (root)

| Script | Description |
|--------|-------------|
| `npm run protocol:compile` | Compile Solidity |
| `npm run protocol:test` | Contract tests |
| `npm run frontend:dev` | Next.js desk |
| `npm run frontend:build` | Production frontend build |
| `npm run keeper:dev` | Relayer in watch mode |
| `npm run keeper:start` | Relayer |

## Environment

Copy examples — never commit secrets:

- `frontend/.env.example` → `frontend/.env.local`
- `keeper/.env.example` → `keeper/.env`
- `noctis-protocol/.env.example` → `noctis-protocol/.env` (deploy keys)

## CI

GitHub Actions (`.github/workflows/ci.yml`):

- **protocol** — compile + test  
- **frontend** — lint + build (stub env)  
- **keeper** — TypeScript check  

Triggered on push/PR to `dev`, `uat`, `prod`.

## Security

- Report vulnerabilities privately to the maintainers (do not open a public issue with exploit details).  
- Protocol roles: Safe admin, dedicated `RELAYER_ROLE`, on-chain pause.  
- External audit is planned before uncapped mainnet TVL.

## License

[MIT](./LICENSE)
