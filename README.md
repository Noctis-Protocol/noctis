# Noctis

**Private Uniswap desk** — encrypted vault balances and swap intents ([ZAMA](https://www.zama.ai/) FHE), settlement against Uniswap V2, **0.05%** protocol fee.

> Live pilot: **Ethereum Sepolia**. Soft mainnet is prepared but not required to run the testnet desk.

## Features

- Deposit ETH / USDC → **encrypted** vault balances  
- Private market intents → relayer + FHE proofs → Uniswap fill  
- Withdraw via pull pattern  
- Desk UI: live pool mid/depth, private “Reveal trades”, activity feed  

**Honest privacy boundary:** vault balances and intents stay encrypted; the Uniswap fill size is public at settlement.

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
