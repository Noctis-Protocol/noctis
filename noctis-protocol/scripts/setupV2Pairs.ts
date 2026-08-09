import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * V2 pair setup (Sepolia pilot):
 *  1. Grant RELAYER_ROLE to the relayer EOA on NoctisExchangeV2
 *  2. Deploy 4 mintable pilot tokens (open mint() = testnet faucet)
 *  3. Seed direct token/USDC Uniswap V2 pools at the Chainlink oracle price
 *  4. Register tokens in NoctisVaultV2 (deposits) and NoctisExchangeV2 (trading)
 *  5. Update deployments/sepolia.v2.json SSOT
 *
 * Idempotent: token deployments and completed steps are recorded in the SSOT
 * and skipped on re-run.
 */

const RELAYER = "0xB63063402eD60d4630bc575dEC5458CDB94d16D6";

// Chainlink Sepolia feeds (8 decimals) — validated at runtime before use
const PILOT_TOKENS: {
  key: string;
  name: string;
  symbol: string;
  decimals: number;
  feed: string;
  poolUsdc: number; // USDC (whole units) to seed the pool with
}[] = [
  { key: "nWBTC", name: "Noctis Test Wrapped BTC", symbol: "nWBTC", decimals: 8,
    feed: "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43", poolUsdc: 3000 }, // BTC/USD
  { key: "nLINK", name: "Noctis Test Chainlink", symbol: "nLINK", decimals: 18,
    feed: "0xc59E3633BAAC79493d908e63626716e204A45EdF", poolUsdc: 1500 }, // LINK/USD
  { key: "nDAI", name: "Noctis Test DAI", symbol: "nDAI", decimals: 18,
    feed: "0x14866185B1962B63C3Ea9E03Bc1da838bab34C19", poolUsdc: 1500 }, // DAI/USD
  { key: "nEUR", name: "Noctis Test Euro", symbol: "nEUR", decimals: 6,
    feed: "0x1a81afB8146aeFfCFc5E50e8479e826E7D55b910", poolUsdc: 1500 }, // EUR/USD
];

const FEED_ABI = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function description() view returns (string)",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const ssotPath = path.join(__dirname, "../deployments/sepolia.v2.json");
  const ssot = JSON.parse(fs.readFileSync(ssotPath, "utf8"));
  const c = ssot.contracts;
  const save = () => fs.writeFileSync(ssotPath, JSON.stringify(ssot, null, 2) + "\n");

  const vault = await ethers.getContractAt("NoctisVaultV2", c.NoctisVaultV2);
  const exchange = await ethers.getContractAt("NoctisExchangeV2", c.NoctisExchangeV2);
  const usdc = await ethers.getContractAt("MockERC20", c.USDC); // IERC20 surface is enough
  // Repo interface lacks addLiquidity — use a minimal manual ABI
  const router = new ethers.Contract(
    c.UniswapV2Router,
    [
      "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)",
    ],
    deployer
  );

  ssot.tokens = ssot.tokens ?? {};
  ssot.ops = ssot.ops ?? {};

  console.log("Deployer:", deployer.address);

  // ---- 1. RELAYER_ROLE ----
  const relayerRole = await exchange.RELAYER_ROLE();
  if (await exchange.hasRole(relayerRole, RELAYER)) {
    console.log("RELAYER_ROLE: already granted");
  } else {
    const tx = await exchange.grantRole(relayerRole, RELAYER);
    await tx.wait();
    console.log("RELAYER_ROLE granted to", RELAYER, "tx:", tx.hash);
  }
  ssot.ops.relayer = RELAYER;
  save();

  // ---- 2..4 per token ----
  for (const t of PILOT_TOKENS) {
    console.log(`\n=== ${t.symbol} ===`);
    const rec = (ssot.tokens[t.key] = ssot.tokens[t.key] ?? {});

    // Validate feed first
    const feed = new ethers.Contract(t.feed, FEED_ABI, ethers.provider);
    const [, answer, , updatedAt] = await feed.latestRoundData();
    const price = BigInt(answer); // 8 decimals
    const ageH = (Date.now() / 1000 - Number(updatedAt)) / 3600;
    if (price <= 0n) throw new Error(`${t.symbol}: feed returned non-positive price`);
    console.log(`feed ${await feed.description()}: $${ethers.formatUnits(price, 8)} (updated ${ageH.toFixed(1)}h ago)`);
    if (ageH > 48) console.warn(`WARNING: ${t.symbol} feed is stale (${ageH.toFixed(1)}h)`);

    // 2. Deploy token
    let token;
    if (rec.address) {
      token = await ethers.getContractAt("MockERC20", rec.address);
      console.log("token: already deployed at", rec.address);
    } else {
      const F = await ethers.getContractFactory("MockERC20");
      token = await F.deploy(t.name, t.symbol, t.decimals);
      await token.waitForDeployment();
      rec.address = await token.getAddress();
      rec.symbol = t.symbol;
      rec.decimals = t.decimals;
      rec.feed = t.feed;
      rec.note = "Pilot token, open mint() = public testnet faucet";
      save();
      console.log("token deployed:", rec.address);
    }
    const tokenAddr = rec.address as string;

    // 3. Seed pool at oracle price: tokenAmount = poolUsdc / price
    if (rec.poolSeeded) {
      console.log("pool: already seeded");
    } else {
      const usdcAmount = ethers.parseUnits(String(t.poolUsdc), 6);
      // token units = usd * 1e8/price * 10^dec  (usd = poolUsdc)
      const tokenAmount =
        (BigInt(t.poolUsdc) * 10n ** 8n * 10n ** BigInt(t.decimals)) / price;
      // Mint liquidity + a faucet reserve for manual testing
      await (await token.mint(deployer.address, tokenAmount * 10n)).wait();
      await (await token.approve(c.UniswapV2Router, tokenAmount)).wait();
      await (await usdc.approve(c.UniswapV2Router, usdcAmount)).wait();
      const deadline = Math.floor(Date.now() / 1000) + 1200;
      const tx = await router.addLiquidity(
        tokenAddr, c.USDC, tokenAmount, usdcAmount,
        (tokenAmount * 99n) / 100n, (usdcAmount * 99n) / 100n,
        deployer.address, deadline
      );
      await tx.wait();
      rec.poolSeeded = true;
      rec.poolUsdc = t.poolUsdc;
      rec.poolSeedTx = tx.hash;
      save();
      console.log(`pool seeded: ${ethers.formatUnits(tokenAmount, t.decimals)} ${t.symbol} / ${t.poolUsdc} USDC, tx: ${tx.hash}`);
    }

    // 4a. Vault registry
    if (rec.vaultConfigured) {
      console.log("vault: already configured");
    } else {
      // Deposit limits: min $1 worth, max $5000 worth; withdrawal caps $2500 / $10000 daily
      const usdToUnits = (usd: bigint) =>
        (usd * 10n ** 8n * 10n ** BigInt(t.decimals)) / price;
      const minDeposit = maxBig(usdToUnits(1n), 1n);
      const tx = await vault.configureToken(
        tokenAddr, t.decimals,
        minDeposit, usdToUnits(5000n), usdToUnits(2500n), usdToUnits(10000n)
      );
      await tx.wait();
      rec.vaultConfigured = true;
      save();
      console.log("vault token configured, tx:", tx.hash);
    }

    // 4b. Exchange registry — direct token/USDC pool, order caps sized for pool depth
    if (rec.exchangeConfigured) {
      console.log("exchange: already configured");
    } else {
      const usdToUnits = (usd: bigint) =>
        (usd * 10n ** 8n * 10n ** BigInt(t.decimals)) / price;
      const minOrder = maxBig(usdToUnits(1n), 1n);
      const maxOrder = usdToUnits(60n); // ~2% price impact on the seeded pools
      const minPriceUsd = price / 5n;   // circuit breaker: 20%..500% of current
      const maxPriceUsd = price * 5n;
      const tx = await exchange.configureTradableToken(
        tokenAddr, t.feed, t.decimals, false,
        minOrder, maxOrder, minPriceUsd, maxPriceUsd
      );
      await tx.wait();
      rec.exchangeConfigured = true;
      rec.minOrderBase = minOrder.toString();
      rec.maxOrderBase = maxOrder.toString();
      save();
      console.log("exchange pair configured, tx:", tx.hash);
    }
  }

  ssot.updatedAt = new Date().toISOString().slice(0, 10);
  save();
  console.log("\nDone. SSOT updated:", ssotPath);
  console.log("Tradable tokens:", await exchange.getTradableTokens());
  console.log("Supported tokens:", await vault.getSupportedTokens());
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
