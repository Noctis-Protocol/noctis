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
- **Unlinkability against casual observers, not determined ones.** Relayed
  orders are submitted by the relayer: `tx.from` is the relayer and the trader
  address appears in no event or public getter. However, the relayed
  transaction's **calldata carries the order amount, direction and an opaque
  vaultId in cleartext**, and vaultIds can be correlated back to addresses
  with effort (deposit ordering, raw storage reads). End-to-end encrypted
  intents that close this are roadmapped —
  see `ROADMAP_E2E_ENCRYPTED_INTENTS.md`.
- **Trusted relayer for order size.** The signed intent carries the amount in
  cleartext, so the relayer sees *who trades how much* before submitting (the
  size becomes public anyway at Uniswap settlement). The relayer never has
  custody and cannot alter the order (EIP-712-signed parameters). Self-relayed
  orders remove this third party at the cost of gas + `tx.from` exposure.
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
