#!/usr/bin/env ts-node
/**
 * @file Keeper + Relayer Service for Noctis Protocol
 * @description Privacy-first relay service + cleanup operations
 *
 * V2 (multi-token): targets NoctisExchangeV2/NoctisVaultV2 — orders are
 * baseToken/USDC pairs (address(0) = native ETH), EIP-712 domain version "2".
 * 
 * ARCHITECTURE:
 * =============
 * 1. Express HTTP server: Receives signed requests from frontend,
 *    verifies EIP-712 signatures OFF-CHAIN, and submits transactions
 *    on behalf of users (hiding their address from tx.from).
 * 
 * 2. Cleanup polling loop: Monitors for expired orders and swap requests.
 * 
 * PRIVACY GUARANTEES:
 * - User address NEVER appears as tx.from (relayer submits)
 * - VaultId (opaque uint256) used instead of address in calldata
 * - EIP-712 signatures verified OFF-CHAIN (no ecrecover on-chain)
 * - Keeper submits via Flashbots RPC (TX hidden from mempool)
 */

import { ethers, Contract, Wallet, formatEther, verifyTypedData } from 'ethers';
import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { loadPrivateKey } from './loadPrivateKey';
import { RelayPolicy, loadPolicyConfigFromEnv } from './relay-policy';

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * SSOT fallback: noctis-protocol/deployments/sepolia.json (keys
 * contracts.NoctisVault / contracts.NoctisExchange). At V2 cutover that file
 * points to the V2 contracts — addresses are never hardcoded here.
 */
function loadSsotAddresses(): { vault: string; exchange: string } {
  const ssotPath = path.join(
    __dirname,
    '..',
    '..',
    'noctis-protocol',
    'deployments',
    'sepolia.json'
  );
  try {
    const ssot = JSON.parse(fs.readFileSync(ssotPath, 'utf8'));
    return {
      vault: ssot.contracts?.NoctisVault || '',
      exchange: ssot.contracts?.NoctisExchange || '',
    };
  } catch {
    return { vault: '', exchange: '' };
  }
}

const SSOT_ADDRESSES = loadSsotAddresses();

const CONFIG = {
  // Use Flashbots RPC for MEV protection and pre-block privacy
  rpcUrl: process.env.RPC_URL || 'https://rpc-sepolia.flashbots.net',
  privateKey: '', // filled via loadPrivateKey() below
  // Env-first, then deployments SSOT
  vaultAddress: process.env.VAULT_ADDRESS || SSOT_ADDRESSES.vault,
  exchangeAddress: process.env.EXCHANGE_ADDRESS || SSOT_ADDRESSES.exchange,
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '15000'),
  relayerPort: parseInt(process.env.RELAYER_PORT || '3001'),
  gasLimit: 5_000_000n,
  chainId: 11155111, // Sepolia
  // Phase A: CORS allowlist (comma-separated). Empty = deny all browser origins except defaults in getCorsOrigins().
  corsOrigins: (process.env.CORS_ORIGINS ||
    'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  rateLimitPerMin: parseInt(process.env.RELAYER_RATE_LIMIT_PER_MIN || '60', 10),
  bodyLimit: process.env.RELAYER_BODY_LIMIT || '100kb',
};

try {
  CONFIG.privateKey = loadPrivateKey();
} catch (e: any) {
  console.error('Fatal: key load failed —', e.message);
  process.exit(1);
}

const TRUST_PROXY =
  process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

function clientIp(req: express.Request): string {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'] as string | undefined;
    if (xf) return xf.split(',')[0]?.trim() || 'unknown';
  }
  return req.socket.remoteAddress || 'unknown';
}

// K-1: Persisted used-nonce store (replay protection)
const USED_NONCES_PATH = path.join(__dirname, '..', 'logs', 'used-nonces.json');
const MAX_USED_NONCES = 50_000;
const usedNonces = new Map<string, number>(); // key → consumedAt ms

function ensureLogsDir(): void {
  fs.mkdirSync(path.dirname(USED_NONCES_PATH), { recursive: true });
}

function loadUsedNonces(): void {
  ensureLogsDir();
  try {
    if (!fs.existsSync(USED_NONCES_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(USED_NONCES_PATH, 'utf8')) as Record<
      string,
      number
    >;
    for (const [key, ts] of Object.entries(raw)) {
      usedNonces.set(key, ts);
    }
    console.log(`[NONCE] Loaded ${usedNonces.size} used nonce(s)`);
  } catch (e: any) {
    console.warn('[NONCE] Failed to load used-nonces.json:', e.message);
  }
}

function persistUsedNonces(): void {
  ensureLogsDir();
  const obj: Record<string, number> = {};
  for (const [key, ts] of usedNonces) obj[key] = ts;
  fs.writeFileSync(USED_NONCES_PATH, JSON.stringify(obj), 'utf8');
}

function pruneUsedNonces(): void {
  if (usedNonces.size <= MAX_USED_NONCES) return;
  // Drop oldest entries until under cap
  const sorted = [...usedNonces.entries()].sort((a, b) => a[1] - b[1]);
  const drop = usedNonces.size - MAX_USED_NONCES;
  for (let i = 0; i < drop; i++) {
    usedNonces.delete(sorted[i][0]);
  }
  console.warn(`[NONCE] Pruned ${drop} oldest nonce(s); store size=${usedNonces.size}`);
}

function consumeNonceOrReject(
  vaultId: string | number | bigint,
  nonce: string | number | bigint,
  res: express.Response
): boolean {
  // SECURITY [K-A]: Canonicalize before keying. vaultId/nonce arrive verbatim
  // from the request body while the EIP-712 signature check normalizes them via
  // BigInt(). Without this, "5", "05", "0x5" recover the SAME signer but produce
  // DIFFERENT keys, letting one signed request be replayed unlimited times by
  // re-encoding its numeric fields. Reject anything that isn't a valid integer.
  let key: string;
  try {
    key = `${BigInt(vaultId).toString()}:${BigInt(nonce).toString()}`;
  } catch {
    res.status(400).json({ error: 'Invalid vaultId or nonce' });
    return false;
  }
  if (usedNonces.has(key)) {
    res.status(409).json({ error: 'Nonce already used' });
    return false;
  }
  usedNonces.set(key, Date.now());
  pruneUsedNonces();
  persistUsedNonces();
  return true;
}

/** K-1: reject expired or far-future deadlines (max 1h window). */
const MAX_SIG_DEADLINE_SECS = 3600;

function validateDeadlineOrReject(
  deadline: string | number | bigint,
  res: express.Response
): boolean {
  const now = Math.floor(Date.now() / 1000);
  const dl = Number(deadline);
  if (now > dl) {
    res.status(400).json({ error: 'Signature expired' });
    return false;
  }
  if (dl > now + MAX_SIG_DEADLINE_SECS) {
    res.status(400).json({ error: 'Deadline too far in the future (max 1h)' });
    return false;
  }
  return true;
}

loadUsedNonces();

/** Simple sliding-window rate limiter (per IP). */
const rateBuckets = new Map<string, number[]>();

function rateLimitMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  // Only exempt shallow health (deep health must be rate-limited)
  if (req.path === '/api/relay/health' && !req.query.deep) {
    return next();
  }
  const ip = clientIp(req);
  const now = Date.now();
  const windowMs = 60_000;
  let stamps = rateBuckets.get(ip) || [];
  stamps = stamps.filter((t) => now - t < windowMs);
  if (stamps.length >= CONFIG.rateLimitPerMin) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  stamps.push(now);
  rateBuckets.set(ip, stamps);
  next();
}

// ═══════════════════════════════════════════════════════════════════════════
// EIP-712 DOMAIN & TYPES (must match contract)
// ═══════════════════════════════════════════════════════════════════════════

const EIP712_DOMAIN = {
  name: 'NoctisExchange',
  version: '2',
  chainId: CONFIG.chainId,
  verifyingContract: CONFIG.exchangeAddress,
};

const EIP712_TYPES = {
  CreateOrder: [
    { name: 'vaultId', type: 'uint256' },
    { name: 'baseToken', type: 'address' },
    { name: 'amountBase', type: 'uint128' },
    { name: 'isBuy', type: 'bool' },
    { name: 'slippageToleranceBPS', type: 'uint16' },
    { name: 'maxPriceDeviationBPS', type: 'uint16' },
    { name: 'gasRefundWei', type: 'uint128' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
  SwapRequest: [
    { name: 'orderId', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
  // V2: poolFee removed (executeSwapViaRelayer no longer takes it)
  SwapExecution: [
    { name: 'orderId', type: 'uint256' },
    { name: 'amount', type: 'uint128' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
  CancelOrder: [
    { name: 'orderId', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// ABIs
// ═══════════════════════════════════════════════════════════════════════════

// NoctisVaultV2: the keeper set was dropped (no isKeeper/initializeKeepers/
// getKeeperCount) and there is no cleanupExpiredWithdrawal — withdrawal
// retry/cancel are user-only (retryWithdrawalExecution / cancelWithdrawal).
const VAULT_ABI = [
  'function paused() view returns (bool)',
  'function getAddressByVaultId(uint256 vaultId) view returns (address)',
];

const EXCHANGE_ABI = [
  // Events (V2: baseToken replaces orderType — all orders are market orders)
  'event OrderCreated(uint256 indexed orderId, address indexed baseToken, bool isBuy, uint256 timestamp)',
  'event OrderFilledSimple(uint256 indexed orderId, uint256 timestamp)',
  'event SwapDecryptionReady(uint256 indexed orderId, bytes32[] handles)',
  'event BuySufficiencyReady(uint256 indexed orderId, bytes32 sufficiencyHandle, uint256 usdcNeeded)',
  'event OrderCancelled(uint256 indexed orderId, uint256 timestamp)',

  // View functions
  'function paused() view returns (bool)',
  'function swapExecutionRequested(uint256 orderId) view returns (bool)',
  'function swapExecutionRequestTime(uint256 orderId) view returns (uint256)',
  'function SWAP_EXECUTION_TIMEOUT() view returns (uint256)',
  'function feeBps() view returns (uint16)',
  'function MAX_FEE_BPS() view returns (uint16)',
  'function feeRecipient() view returns (address)',
  'function gasRecipient() view returns (address)',
  'function RELAYER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function getOrderPublic(uint256 orderId) view returns (bool exists, address baseToken, bool isBuy, uint8 status, uint256 timestamp)',
  'event ProtocolFeeCollected(uint256 indexed orderId, address indexed token, uint256 feeAmount, address indexed recipient)',

  // Relayer functions (PRIVACY: user address NOT in calldata)
  // BUY: executeSwapViaRelayer only prepares sufficiency — user must call finalizeBuySwap
  'function createMarketOrderViaRelayer(uint256 vaultId, address baseToken, uint128 amountBase, bool isBuy, uint16 slippageToleranceBPS, uint16 maxPriceDeviationBPS, uint128 gasRefundWei) external returns (uint256)',
  'function maxGasRefundWei() view returns (uint128)',
  'event GasRefundCollected(uint256 indexed orderId, address indexed token, uint256 refundAmount)',
  'function requestSwapExecutionViaRelayer(uint256 orderId) external',
  'function executeSwapViaRelayer(uint256 orderId, uint128 amount, uint256 minAmountOut, bytes calldata cleartexts, bytes calldata decryptionProof) external',
  'function cancelOrderViaRelayer(uint256 orderId) external',
  'function cancelSwapExecutionViaRelayer(uint256 orderId) external',

];

// ═══════════════════════════════════════════════════════════════════════════
// KEEPER + RELAYER SERVICE
// ═══════════════════════════════════════════════════════════════════════════

class KeeperRelayerService {
  private provider: ethers.JsonRpcProvider;
  private wallet: Wallet;
  private vault: Contract;
  /** Provider-connected vault instance for reads with a `from` override. */
  private vaultReader: Contract;
  private exchange: Contract;
  private isRunning = false;
  private lastProcessedBlock = 0;
  private app: express.Application;
  // Economic anti-grief policy: gas refunds are only collected at settlement,
  // so relayed create/cancel loops are bounded off-chain (privacy-neutral).
  private policy: RelayPolicy;

  constructor() {
    if (!CONFIG.privateKey) {
      throw new Error('Fatal: KEEPER_PRIVATE_KEY or PRIVATE_KEY not set');
    }
    if (!CONFIG.exchangeAddress || !CONFIG.vaultAddress) {
      throw new Error(
        'Fatal: VAULT_ADDRESS / EXCHANGE_ADDRESS not set and no SSOT fallback ' +
          '(noctis-protocol/deployments/sepolia.json contracts.NoctisVault/.NoctisExchange)'
      );
    }

    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
    this.wallet = new Wallet(CONFIG.privateKey, this.provider);
    this.vault = new Contract(CONFIG.vaultAddress, VAULT_ABI, this.wallet);
    this.vaultReader = new Contract(CONFIG.vaultAddress, VAULT_ABI, this.provider);
    this.exchange = new Contract(CONFIG.exchangeAddress, EXCHANGE_ABI, this.wallet);
    this.policy = new RelayPolicy(
      loadPolicyConfigFromEnv(path.join(__dirname, '..', 'logs'))
    );

    // Express server — Phase A: CORS allowlist + body cap + rate limit
    this.app = express();
    this.app.use(
      cors({
        origin: (origin, cb) => {
          // Non-browser / healthchecks (no Origin): allow
          if (!origin) return cb(null, true);
          if (CONFIG.corsOrigins.includes(origin)) return cb(null, true);
          console.warn(`[CORS] blocked origin=${origin}`);
          return cb(null, false);
        },
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        maxAge: 86400,
      })
    );
    this.app.use(express.json({ limit: CONFIG.bodyLimit }));
    this.app.use(rateLimitMiddleware);
    this.setupRoutes();
  }

  /**
   * Resolve a vaultId to its owner address (off-chain signature check).
   * VaultV2 getAddressByVaultId is onlyExchange, so the eth_call impersonates
   * the exchange via a `from` override (read-only, requires no on-chain grant).
   * Must go through the provider-connected instance: a signer runner would
   * reject the `from` mismatch.
   */
  private async resolveVaultOwner(vaultId: string | number | bigint): Promise<string> {
    return (await this.vaultReader.getAddressByVaultId.staticCall(vaultId, {
      from: CONFIG.exchangeAddress,
    })) as string;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EXPRESS HTTP ROUTES
  // ═══════════════════════════════════════════════════════════════════════

  private setupRoutes(): void {
    // Health check — ?deep=1 adds on-chain role/pause/feeRecipient/balance
    this.app.get('/api/relay/health', async (req, res) => {
      const base = {
        status: 'ok' as 'ok' | 'degraded' | 'error',
        relayer: this.wallet.address,
        vault: CONFIG.vaultAddress,
        exchange: CONFIG.exchangeAddress,
        chainId: CONFIG.chainId,
        rpc: CONFIG.rpcUrl.includes('flashbots') ? 'flashbots' : 'standard',
        ts: new Date().toISOString(),
      };

      if (req.query.deep !== '1' && req.query.deep !== 'true') {
        return res.json(base);
      }

      const expectedFee =
        process.env.EXPECTED_FEE_RECIPIENT || process.env.FEE_RECIPIENT || '';
      const minEth = ethers.parseEther(process.env.MIN_KEEPER_ETH || '0.01');
      const checks: Record<string, unknown> = {};
      const failures: string[] = [];

      try {
        // Sequential reads — Flashbots / some RPCs reject large eth batches
        // V2: vault has no keeper set — the isKeeper check was dropped.
        const paused = (await this.exchange.paused()) as boolean;
        const vaultPaused = (await this.vault.paused()) as boolean;
        const role = (await this.exchange.RELAYER_ROLE()) as string;
        const hasRelayer = (await this.exchange.hasRole(
          role,
          this.wallet.address
        )) as boolean;
        const feeRecipient = (await this.exchange.feeRecipient()) as string;
        // V2: gasRecipient receives gas-in-kind refunds at settlement
        // (relayer float wallet) — reported for ops visibility.
        const gasRecipient = (await this.exchange.gasRecipient()) as string;
        const balance = await this.provider.getBalance(this.wallet.address);

        checks.exchangePaused = paused;
        checks.vaultPaused = vaultPaused;
        checks.hasRelayerRole = hasRelayer;
        checks.feeRecipient = feeRecipient;
        checks.gasRecipient = gasRecipient;
        checks.keeperEth = formatEther(balance);

        if (paused) failures.push('exchange_paused');
        if (vaultPaused) failures.push('vault_paused');
        if (!hasRelayer) failures.push('missing_relayer_role');
        if (balance < minEth) failures.push('low_keeper_eth');
        if (
          expectedFee &&
          feeRecipient.toLowerCase() !== expectedFee.toLowerCase()
        ) {
          failures.push('fee_recipient_mismatch');
          checks.expectedFeeRecipient = expectedFee;
        }
      } catch (e: any) {
        failures.push('onchain_read_failed');
        checks.error = e.shortMessage || e.message || String(e);
      }

      base.status = failures.length === 0 ? 'ok' : 'degraded';
      const body = { ...base, checks, failures, policy: this.policy.stats() };
      return res.status(failures.length === 0 ? 200 : 503).json(body);
    });

    // Aggregate anti-grief policy stats (no vaultIds/orderIds — privacy-safe).
    // Consumed by the ops monitor to alert on budget burn / low settle ratio.
    this.app.get('/api/relay/policyStats', (_req, res) => {
      res.json({ ...this.policy.stats(), ts: new Date().toISOString() });
    });

    // Gas refund quote: suggested flat gas-in-kind refund (wei) for one relayed swap.
    // The user signs this value in the CreateOrder intent; it is skimmed from the
    // swap output at settlement so the relayer gas float is reimbursed by the treasury.
    this.app.get('/api/relay/gasQuote', async (_req, res) => {
      try {
        const feeData = await this.provider.getFeeData();
        const gasPrice = feeData.gasPrice ?? 1_000_000_000n; // 1 gwei fallback
        // Full relayed path: create + request + execute (FHE ops dominate)
        const gasUnits = BigInt(process.env.GAS_UNITS_PER_SWAP || '2500000');
        const margin = 110n; // +10% buffer for gas price drift between quote and execution
        let quote = (gasUnits * gasPrice * margin) / 100n;

        // Never quote above the on-chain hard cap (order creation would revert)
        const onChainCap = (await this.exchange.maxGasRefundWei()) as bigint;
        if (quote > onChainCap) quote = onChainCap;

        res.json({
          gasRefundWei: quote.toString(),
          gasPriceWei: gasPrice.toString(),
          maxGasRefundWei: onChainCap.toString(),
        });
      } catch (error: any) {
        console.error('[RELAY] gasQuote error:', error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // Create order via relayer (V2: multi-token — baseToken/USDC pair)
    this.app.post('/api/relay/createOrder', async (req, res) => {
      try {
        const { vaultId, baseToken, amountBase, isBuy, slippageBPS, maxDeviationBPS, gasRefundWei, deadline, nonce, signature } = req.body;

        // Validate required fields
        if (!vaultId || baseToken === undefined || !amountBase || slippageBPS === undefined || !deadline || nonce === undefined || !signature) {
          return res.status(400).json({ error: 'Missing required fields' });
        }

        // baseToken must be a valid address (address(0) = native ETH is allowed)
        if (typeof baseToken !== 'string' || !ethers.isAddress(baseToken)) {
          return res.status(400).json({ error: 'Invalid baseToken address' });
        }

        if (!validateDeadlineOrReject(deadline, res)) return;

        // Economic policy: in-flight cap, settle-ratio throttle, gas budget
        let vaultKey: string;
        try {
          vaultKey = BigInt(vaultId).toString();
        } catch {
          return res.status(400).json({ error: 'Invalid vaultId' });
        }
        const decision = this.policy.checkCreate(vaultKey);
        if (!decision.allowed) {
          console.warn(`[POLICY] createOrder refused: ${decision.reason}`);
          return res
            .status(decision.httpStatus || 429)
            .json({ error: decision.hint, reason: decision.reason });
        }

        // Gas-in-kind refund: default 0 (no refund) if the client omits it
        const refundWei = BigInt(gasRefundWei || '0');

        // Verify EIP-712 signature OFF-CHAIN
        const message = {
          vaultId: BigInt(vaultId),
          baseToken: ethers.getAddress(baseToken),
          amountBase: BigInt(amountBase),
          isBuy: Boolean(isBuy),
          slippageToleranceBPS: Number(slippageBPS),
          maxPriceDeviationBPS: Number(maxDeviationBPS),
          gasRefundWei: refundWei,
          deadline: BigInt(deadline),
          nonce: BigInt(nonce),
        };

        const recoveredSigner = verifyTypedData(EIP712_DOMAIN, { CreateOrder: EIP712_TYPES.CreateOrder }, message, signature);

        // Verify signer owns the vaultId
        const vaultOwner = await this.resolveVaultOwner(vaultId);
        if (recoveredSigner.toLowerCase() !== vaultOwner.toLowerCase()) {
          return res.status(403).json({ error: 'Signer does not own this vaultId' });
        }

        if (!consumeNonceOrReject(vaultId, nonce, res)) return;

        console.log(`[RELAY] createOrder: vaultId=${vaultId}, baseToken=${baseToken}, amountBase=${amountBase}, isBuy=${isBuy}, gasRefundWei=${refundWei}`);

        // Submit transaction (relayer is tx.from, NOT the user)
        const tx = await this.exchange.createMarketOrderViaRelayer(
          vaultId,
          baseToken,
          amountBase,
          isBuy,
          slippageBPS,
          maxDeviationBPS,
          refundWei,
          { gasLimit: CONFIG.gasLimit }
        );

        const receipt = await tx.wait();
        this.recordGas(receipt);

        // Extract orderId from OrderCreated event
        let orderId: string | null = null;
        for (const log of receipt.logs) {
          try {
            const parsed = this.exchange.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === 'OrderCreated') {
              orderId = parsed.args.orderId.toString();
            }
          } catch { /* skip non-matching logs */ }
        }

        if (orderId) this.policy.noteCreated(vaultKey, orderId);
        console.log(`[RELAY] Order created: orderId=${orderId}, tx=${tx.hash}`);
        res.json({ orderId, txHash: tx.hash });
      } catch (error: any) {
        console.error('[RELAY] createOrder error:', error.reason || error.message);
        res.status(500).json({ error: error.reason || error.message });
      }
    });

    // Request swap execution via relayer
    this.app.post('/api/relay/requestSwap', async (req, res) => {
      try {
        const { orderId, deadline, nonce, signature, vaultId } = req.body;

        if (!orderId || !deadline || nonce === undefined || !signature || !vaultId) {
          return res.status(400).json({ error: 'Missing required fields' });
        }
        if (!validateDeadlineOrReject(deadline, res)) return;

        // Verify EIP-712 signature
        const message = {
          orderId: BigInt(orderId),
          deadline: BigInt(deadline),
          nonce: BigInt(nonce),
        };

        const recoveredSigner = verifyTypedData(EIP712_DOMAIN, { SwapRequest: EIP712_TYPES.SwapRequest }, message, signature);

        // Verify signer owns the vaultId
        const vaultOwner = await this.resolveVaultOwner(vaultId);
        if (recoveredSigner.toLowerCase() !== vaultOwner.toLowerCase()) {
          return res.status(403).json({ error: 'Signer does not own this vaultId' });
        }

        if (!consumeNonceOrReject(vaultId, nonce, res)) return;

        console.log(`[RELAY] requestSwap: orderId=${orderId}`);

        const tx = await this.exchange.requestSwapExecutionViaRelayer(orderId, { gasLimit: CONFIG.gasLimit });
        const receipt = await tx.wait();
        this.recordGas(receipt);

        // Extract handles from SwapDecryptionReady event
        let handles: string[] = [];
        for (const log of receipt.logs) {
          try {
            const parsed = this.exchange.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === 'SwapDecryptionReady') {
              handles = parsed.args.handles.map((h: string) => h);
            }
          } catch { /* skip */ }
        }

        console.log(`[RELAY] Swap requested: orderId=${orderId}, handles=${handles.length}, tx=${tx.hash}`);
        res.json({ txHash: tx.hash, handles });
      } catch (error: any) {
        console.error('[RELAY] requestSwap error:', error.reason || error.message);
        res.status(500).json({ error: error.reason || error.message });
      }
    });

    // Execute swap via relayer (with FHE decryption proof).
    // V2: poolFee removed — the exchange routes via its own pair registry.
    this.app.post('/api/relay/executeSwap', async (req, res) => {
      try {
        const { orderId, amount, minAmountOut, cleartexts, decryptionProof, deadline, nonce, signature, vaultId } = req.body;

        if (!orderId || !amount || minAmountOut === undefined || !cleartexts || !decryptionProof || !deadline || nonce === undefined || !signature || !vaultId) {
          return res.status(400).json({ error: 'Missing required fields' });
        }
        if (!validateDeadlineOrReject(deadline, res)) return;

        // Verify EIP-712 signature
        const message = {
          orderId: BigInt(orderId),
          amount: BigInt(amount),
          minAmountOut: BigInt(minAmountOut),
          deadline: BigInt(deadline),
          nonce: BigInt(nonce),
        };

        const recoveredSigner = verifyTypedData(EIP712_DOMAIN, { SwapExecution: EIP712_TYPES.SwapExecution }, message, signature);

        const vaultOwner = await this.resolveVaultOwner(vaultId);
        if (recoveredSigner.toLowerCase() !== vaultOwner.toLowerCase()) {
          return res.status(403).json({ error: 'Signer does not own this vaultId' });
        }

        if (!consumeNonceOrReject(vaultId, nonce, res)) return;

        console.log(`[RELAY] executeSwap: orderId=${orderId}, amount=${amount}`);

        const tx = await this.exchange.executeSwapViaRelayer(
          orderId,
          amount,
          minAmountOut,
          cleartexts,
          decryptionProof,
          { gasLimit: CONFIG.gasLimit }
        );

        const receipt = await tx.wait();
        this.recordGas(receipt);
        // Terminal for policy purposes: SELL settles here (refund skimmed);
        // BUY refund is skimmed in the user-paid finalizeBuySwap.
        this.policy.noteSettled(String(orderId));
        // BUY: this call only prepares USDC sufficiency; UI must call finalizeBuySwap as the user
        let buySufficiencyHandle: string | undefined;
        let usdcNeeded: string | undefined;
        for (const log of receipt.logs) {
          try {
            const parsed = this.exchange.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === 'BuySufficiencyReady') {
              buySufficiencyHandle = parsed.args.sufficiencyHandle;
              usdcNeeded = parsed.args.usdcNeeded?.toString?.();
            }
          } catch { /* skip */ }
        }

        console.log(`[RELAY] Swap executed: orderId=${orderId}, tx=${tx.hash}`, buySufficiencyHandle ? '(BUY prepare only)' : '');
        res.json({
          txHash: tx.hash,
          buyPrepared: Boolean(buySufficiencyHandle),
          sufficiencyHandle: buySufficiencyHandle,
          usdcNeeded,
          note: buySufficiencyHandle
            ? 'BUY step1 done — user must call finalizeBuySwap'
            : undefined,
        });
      } catch (error: any) {
        console.error('[RELAY] executeSwap error:', error.reason || error.message);
        res.status(500).json({ error: error.reason || error.message });
      }
    });

    // Cancel order via relayer
    this.app.post('/api/relay/cancelOrder', async (req, res) => {
      try {
        const { orderId, deadline, nonce, signature, vaultId } = req.body;

        if (!orderId || !deadline || nonce === undefined || !signature || !vaultId) {
          return res.status(400).json({ error: 'Missing required fields' });
        }
        if (!validateDeadlineOrReject(deadline, res)) return;

        // Verify EIP-712 signature
        const message = {
          orderId: BigInt(orderId),
          deadline: BigInt(deadline),
          nonce: BigInt(nonce),
        };

        const recoveredSigner = verifyTypedData(EIP712_DOMAIN, { CancelOrder: EIP712_TYPES.CancelOrder }, message, signature);

        const vaultOwner = await this.resolveVaultOwner(vaultId);
        if (recoveredSigner.toLowerCase() !== vaultOwner.toLowerCase()) {
          return res.status(403).json({ error: 'Signer does not own this vaultId' });
        }

        if (!consumeNonceOrReject(vaultId, nonce, res)) return;

        // Budget gate only — a cancel restores locked funds, so it stays
        // allowed per-vault, but it burns unrecoverable relayer gas.
        const decision = this.policy.checkCancel();
        if (!decision.allowed) {
          console.warn(`[POLICY] cancelOrder refused: ${decision.reason}`);
          return res
            .status(decision.httpStatus || 503)
            .json({ error: decision.hint, reason: decision.reason });
        }

        console.log(`[RELAY] cancelOrder: orderId=${orderId}`);

        const tx = await this.exchange.cancelOrderViaRelayer(orderId, { gasLimit: CONFIG.gasLimit });
        const receipt = await tx.wait();
        this.recordGas(receipt);
        this.policy.noteWasted(String(orderId));

        console.log(`[RELAY] Order cancelled: orderId=${orderId}, tx=${tx.hash}`);
        res.json({ txHash: tx.hash });
      } catch (error: any) {
        console.error('[RELAY] cancelOrder error:', error.reason || error.message);
        res.status(500).json({ error: error.reason || error.message });
      }
    });

    // Cancel swap execution via relayer
    this.app.post('/api/relay/cancelSwap', async (req, res) => {
      try {
        const { orderId, deadline, nonce, signature, vaultId } = req.body;

        if (!orderId || !deadline || nonce === undefined || !signature || !vaultId) {
          return res.status(400).json({ error: 'Missing required fields' });
        }
        if (!validateDeadlineOrReject(deadline, res)) return;

        const message = {
          orderId: BigInt(orderId),
          deadline: BigInt(deadline),
          nonce: BigInt(nonce),
        };

        const recoveredSigner = verifyTypedData(EIP712_DOMAIN, { CancelOrder: EIP712_TYPES.CancelOrder }, message, signature);

        const vaultOwner = await this.resolveVaultOwner(vaultId);
        if (recoveredSigner.toLowerCase() !== vaultOwner.toLowerCase()) {
          return res.status(403).json({ error: 'Signer does not own this vaultId' });
        }

        if (!consumeNonceOrReject(vaultId, nonce, res)) return;

        const decision = this.policy.checkCancel();
        if (!decision.allowed) {
          console.warn(`[POLICY] cancelSwap refused: ${decision.reason}`);
          return res
            .status(decision.httpStatus || 503)
            .json({ error: decision.hint, reason: decision.reason });
        }

        const tx = await this.exchange.cancelSwapExecutionViaRelayer(orderId, { gasLimit: CONFIG.gasLimit });
        const receipt = await tx.wait();
        this.recordGas(receipt);
        // Order returns to pending after a cancelled execution — not terminal.

        console.log(`[RELAY] Swap cancelled: orderId=${orderId}, tx=${tx.hash}`);
        res.json({ txHash: tx.hash });
      } catch (error: any) {
        console.error('[RELAY] cancelSwap error:', error.reason || error.message);
        res.status(500).json({ error: error.reason || error.message });
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  async initialize(): Promise<void> {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🌙 NOCTIS KEEPER + RELAYER SERVICE');
    console.log('');
    console.log('   🔒 RELAYER: Privacy-preserving transaction relay');
    console.log('   🧹 CLEANUP: Expired orders & requests');
    console.log('   🛡️  FLASHBOTS: MEV protection + mempool privacy');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');

    const network = await this.provider.getNetwork();
    console.log(`📡 Network:       ${network.name} (Chain ID: ${network.chainId})`);
    console.log(`📡 RPC:           ${CONFIG.rpcUrl.includes('flashbots') ? '🛡️ Flashbots' : '⚠️ Standard'}`);
    console.log(`📋 Vault:         ${CONFIG.vaultAddress}`);
    console.log(`📈 Exchange:      ${CONFIG.exchangeAddress}`);
    console.log(`🔑 Relayer:       ${this.wallet.address}`);

    const balance = await this.provider.getBalance(this.wallet.address);
    console.log(`💰 Balance:       ${formatEther(balance)} ETH`);

    if (balance === 0n) {
      console.warn('\n⚠️  WARNING: Relayer has zero balance! Add ETH for gas.');
    }

    // Check RELAYER_ROLE (required for ViaRelayer txs)
    try {
      const role = await this.exchange.RELAYER_ROLE();
      const hasRelayer = await this.exchange.hasRole(role, this.wallet.address);
      console.log(`✅ RELAYER_ROLE:  ${hasRelayer ? 'YES' : 'NO — grantRole before testing'}`);
    } catch {
      console.log(`⚠️  RELAYER_ROLE:  Unable to verify`);
    }

    this.lastProcessedBlock = await this.provider.getBlockNumber();
    console.log(`📍 Start Block:   ${this.lastProcessedBlock}`);
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // START (Express + Cleanup Loop)
  // ═══════════════════════════════════════════════════════════════════════

  async start(): Promise<void> {
    this.isRunning = true;

    // Start Express server
    this.app.listen(CONFIG.relayerPort, () => {
      console.log(`🚀 Relayer HTTP server listening on port ${CONFIG.relayerPort}`);
      console.log(`   POST /api/relay/createOrder`);
      console.log(`   POST /api/relay/requestSwap`);
      console.log(`   POST /api/relay/executeSwap`);
      console.log(`   POST /api/relay/cancelOrder`);
      console.log(`   POST /api/relay/cancelSwap`);
      console.log(`   GET  /api/relay/health`);
      console.log(`   GET  /api/relay/policyStats`);
      console.log('');
    });

    // Start cleanup polling loop
    console.log(`🔄 Cleanup polling every ${CONFIG.pollIntervalMs / 1000}s`);
    console.log('');
    console.log('Press Ctrl+C to stop');
    console.log('─'.repeat(67));
    console.log('');

    this.pollForEvents();

    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLEANUP POLLING LOOP
  // ═══════════════════════════════════════════════════════════════════════

  private async pollForEvents(): Promise<void> {
    while (this.isRunning) {
      try {
        const currentBlock = await this.provider.getBlockNumber();

        if (currentBlock > this.lastProcessedBlock) {
          const fromBlock = this.lastProcessedBlock + 1;
          const toBlock = currentBlock;
          await this.processExchangeEvents(fromBlock, toBlock);
          this.lastProcessedBlock = currentBlock;
        }

        await this.sleep(CONFIG.pollIntervalMs);
      } catch (error: any) {
        console.error('❌ Polling error:', error.message?.slice(0, 100) || error);
        await this.sleep(5000);
      }
    }
  }

  private async processExchangeEvents(fromBlock: number, toBlock: number): Promise<void> {
    try {
      // Monitor new orders (logging only)
      const orderEvents = await this.exchange.queryFilter('OrderCreated', fromBlock, toBlock);
      for (const event of orderEvents) {
        if (!(event instanceof ethers.EventLog)) continue;
        // V2: no orderType (market-only); baseToken identifies the pair
        const { orderId, baseToken, isBuy } = event.args;
        console.log(`[${this.ts()}] 📊 New Order #${orderId} (${isBuy ? 'BUY' : 'SELL'} ${baseToken}/USDC)`);
      }

      // Monitor swap decryption requests
      const swapReadyEvents = await this.exchange.queryFilter('SwapDecryptionReady', fromBlock, toBlock);
      for (const event of swapReadyEvents) {
        if (!(event instanceof ethers.EventLog)) continue;
        const { orderId } = event.args;
        console.log(`[${this.ts()}] 🔓 Swap Request #${orderId} - decrypting...`);
      }

      // Monitor completed swaps — also settle policy accounting for orders
      // that reached settlement outside the relay endpoints (e.g. BUY
      // finalizeBuySwap paid by the user).
      const filledEvents = await this.exchange.queryFilter('OrderFilledSimple', fromBlock, toBlock);
      for (const event of filledEvents) {
        if (!(event instanceof ethers.EventLog)) continue;
        const { orderId } = event.args;
        this.policy.noteSettled(orderId.toString());
        console.log(`[${this.ts()}] ✅ Order #${orderId} filled`);
      }

      // Cancellations settle policy accounting as wasted gas (covers direct,
      // self-paid cancels of orders that we relayed at creation).
      const cancelledEvents = await this.exchange.queryFilter('OrderCancelled', fromBlock, toBlock);
      for (const event of cancelledEvents) {
        if (!(event instanceof ethers.EventLog)) continue;
        const { orderId } = event.args;
        this.policy.noteWasted(orderId.toString());
      }
    } catch (error: any) {
      if (!error.message?.includes('not a function')) {
        console.error('Exchange event processing error:', error.message?.slice(0, 50));
      }
    }
  }

  /** Record the actual gas fee burned by a relayed transaction. */
  private recordGas(receipt: ethers.TransactionReceipt | null): void {
    if (!receipt) return;
    try {
      const price = receipt.gasPrice ?? 0n;
      this.policy.noteGasSpent(receipt.gasUsed * price);
    } catch {
      // Accounting must never break relaying.
    }
  }

  stop(): void {
    console.log('\n🛑 Stopping keeper + relayer service...');
    this.isRunning = false;
    process.exit(0);
  }

  private ts(): string {
    return new Date().toISOString().slice(11, 19);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const service = new KeeperRelayerService();
  await service.initialize();
  await service.start();
  await new Promise(() => {}); // Keep alive
}

main().catch((error) => {
  console.error('❌ Fatal error:', error.message);
  process.exit(1);
});
