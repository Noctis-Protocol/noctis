/**
 * @notice Deploy NoctisVaultV2 + NoctisExchangeV2 (multi-token architecture)
 * @dev Deploys the V2 pair, registers the initial token set (native ETH +
 *      USDC), and wires the treasury split from the existing V1 SSOT:
 *
 *        - feeRecipient  -> treasury Safe   (protocol fees)
 *        - gasRecipient  -> relayer wallet  (gas-in-kind refunds)
 *
 *      The gasRecipient split means the relayer float self-funds at
 *      settlement — no manual Safe -> keeper top-up loop.
 *
 *   npx hardhat run scripts/deployV2.ts --network sepolia
 *
 * Env:
 *   ALLOW_MAINNET_DEPLOY=1   — required on chainId 1
 *   FEE_RECIPIENT            — override treasury Safe (default: V1 SSOT contracts.feeRecipient)
 *   GAS_RECIPIENT            — override relayer float wallet (default: V1 SSOT ops.relayer)
 *
 * Writes deployments/<network>.v2.json (the live V1 SSOT is left untouched
 * until cutover). Extra pairs (WBTC/LINK/...) are registered post-deploy via
 * configureToken / configureTradableToken.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { loadSsot, networkNameForChainId } from "./lib/ssot";

const ZERO = ethers.ZeroAddress;

// Same references as the V1 deploy script (deployExchange.ts)
const USDC_ADDRESSES: Record<string, string> = {
  "1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "11155111": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  "31337": ZERO,
};
const UNISWAP_V2_ROUTER_ADDRESSES: Record<string, string> = {
  "1": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  "11155111": "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008",
  "31337": ZERO,
};
const ETH_USD_PRICE_FEED_ADDRESSES: Record<string, string> = {
  "1": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  "11155111": "0x694AA1769357215DE4FAC081bf1f309aDC325306",
  "31337": ZERO,
};
const SEQUENCER_UPTIME_FEED_ADDRESSES: Record<string, string> = {
  "1": ZERO, // L1 — no sequencer
  "11155111": ZERO,
  "31337": ZERO,
};

async function main() {
  console.log("🚀 Deploying Noctis V2 (multi-token vault + multi-pair exchange)...\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainKey = network.chainId.toString();
  console.log("Network:", network.name, `(${chainKey})`);
  console.log("Deployer:", deployer.address);
  console.log(
    "Balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH\n"
  );

  if (network.chainId === 1n && process.env.ALLOW_MAINNET_DEPLOY !== "1") {
    throw new Error(
      "Mainnet deploy blocked. Confirm Safe + soft caps + D0, then set ALLOW_MAINNET_DEPLOY=1."
    );
  }

  const usdcAddress = USDC_ADDRESSES[chainKey];
  const routerAddress = UNISWAP_V2_ROUTER_ADDRESSES[chainKey];
  const ethFeedAddress = ETH_USD_PRICE_FEED_ADDRESSES[chainKey];
  const sequencerFeedAddress = SEQUENCER_UPTIME_FEED_ADDRESSES[chainKey] ?? ZERO;
  if (!usdcAddress || usdcAddress === ZERO) throw new Error(`No USDC configured for chainId ${chainKey}`);
  if (!routerAddress || routerAddress === ZERO) throw new Error(`No router configured for chainId ${chainKey}`);
  if (!ethFeedAddress || ethFeedAddress === ZERO) throw new Error(`No ETH/USD feed configured for chainId ${chainKey}`);

  // ── Treasury wiring targets (from the live V1 SSOT, overridable) ──────
  let safeAddress = process.env.FEE_RECIPIENT || "";
  let relayerAddress = process.env.GAS_RECIPIENT || "";
  try {
    const { data: v1Ssot } = loadSsot(network.chainId);
    if (!safeAddress) safeAddress = v1Ssot.ops?.feeRecipientSafe || v1Ssot.contracts?.feeRecipient || "";
    if (!relayerAddress) relayerAddress = v1Ssot.ops?.relayer || "";
  } catch {
    console.log("ℹ️  No V1 SSOT found — feeRecipient/gasRecipient from env or post-deploy.");
  }

  // ── 1) NoctisVaultV2 ───────────────────────────────────────────────────
  console.log("1️⃣ Deploying NoctisVaultV2...");
  const VaultFactory = await ethers.getContractFactory("NoctisVaultV2");
  const vault = await VaultFactory.deploy(deployer.address);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log("   NoctisVaultV2:", vaultAddress);

  // ── 2) NoctisExchangeV2 ───────────────────────────────────────────────
  console.log("\n2️⃣ Deploying NoctisExchangeV2...");
  const ExchangeFactory = await ethers.getContractFactory("NoctisExchangeV2");
  const exchange = await ExchangeFactory.deploy(
    vaultAddress,
    routerAddress,
    usdcAddress,
    ethFeedAddress,
    sequencerFeedAddress
  );
  await exchange.waitForDeployment();
  const exchangeAddress = await exchange.getAddress();
  console.log("   NoctisExchangeV2:", exchangeAddress);

  // ── 3) Wiring ─────────────────────────────────────────────────────────
  console.log("\n3️⃣ Wiring vault <-> exchange + roles...");
  await (await vault.setExchange(exchangeAddress, true)).wait();
  await (await exchange.grantRole(await exchange.PARAMS_ROLE(), deployer.address)).wait();
  console.log("   setExchange + PARAMS_ROLE ✅");

  // ── 4) Initial token registry (ETH + USDC; extra pairs post-deploy) ───
  console.log("\n4️⃣ Registering initial tokens (native ETH + USDC)...");
  const E18 = ethers.parseEther;
  const E6 = (n: number) => BigInt(n) * 10n ** 6n;
  // token, decimals, minDeposit, maxDeposit, maxWithdrawal, maxDaily
  await (await vault.configureToken(ZERO, 18, E18("0.005"), E18("100"), E18("100"), E18("1000"))).wait();
  await (await vault.configureToken(usdcAddress, 6, E6(1), E6(1_000_000), E6(1_000_000), E6(10_000_000))).wait();
  // baseToken, feed, decimals, viaWeth, minOrder, maxOrder, minPriceUsd, maxPriceUsd
  await (
    await exchange.configureTradableToken(
      ZERO, ethFeedAddress, 18, false,
      E18("0.001"), E18("100"), 100n * 10n ** 8n, 50_000n * 10n ** 8n
    )
  ).wait();
  console.log("   ETH/USDC registered ✅ (add WBTC/LINK/... via configureTradableToken)");

  // ── 5) Treasury split: fees -> Safe, gas refunds -> relayer float ─────
  console.log("\n5️⃣ Treasury split (fee -> Safe, gas refund -> relayer)...");
  if (safeAddress && ethers.isAddress(safeAddress)) {
    await (await exchange.setFeeRecipient(safeAddress)).wait();
    console.log("   setFeeRecipient ->", safeAddress, "✅");
  } else {
    console.log("   ⚠️  feeRecipient left as deployer — run setFeeRecipient(<safe>) before go-live");
  }
  if (relayerAddress && ethers.isAddress(relayerAddress)) {
    await (await exchange.setGasRecipient(relayerAddress)).wait();
    console.log("   setGasRecipient ->", relayerAddress, "✅ (relayer float self-funds at settlement)");
  } else {
    console.log("   ⚠️  gasRecipient left as deployer — run setGasRecipient(<relayer>) before go-live");
  }

  // ── 6) Verify ─────────────────────────────────────────────────────────
  console.log("\n6️⃣ Verification");
  const feeNow = await exchange.feeRecipient();
  const gasNow = await exchange.gasRecipient();
  console.log("   feeRecipient:", feeNow);
  console.log("   gasRecipient:", gasNow);
  console.log("   fee/gas split:", feeNow.toLowerCase() !== gasNow.toLowerCase() ? "✅ distinct" : "⚠️ same address");

  // ── 7) SSOT (separate file until cutover) ─────────────────────────────
  const networkKey =
    network.chainId === 31337n ? "localhost" : networkNameForChainId(network.chainId);
  const deployment = {
    network: networkKey,
    chainId: Number(network.chainId),
    updatedAt: new Date().toISOString().slice(0, 10),
    contracts: {
      NoctisVaultV2: vaultAddress,
      NoctisExchangeV2: exchangeAddress,
      USDC: usdcAddress,
      UniswapV2Router: routerAddress,
      EthUsdPriceFeed: ethFeedAddress,
      SequencerUptimeFeed: sequencerFeedAddress,
      feeRecipient: feeNow,
      gasRecipient: gasNow,
      feeBps: 5,
    },
    notes:
      "V2 SSOT (multi-token). Live V1 SSOT stays canonical until cutover. " +
      "gasRecipient = relayer float wallet: gas refunds are paid there at settlement (no Safe round-trip).",
  };
  const outPath = path.join(__dirname, "..", "deployments", `${networkKey}.v2.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log("\n📄 SSOT written:", outPath);

  console.log("\n⚠️  POST-DEPLOYMENT STEPS:\n");
  console.log("1. Register extra pairs: vault.configureToken + exchange.configureTradableToken (WBTC/LINK/...)");
  console.log("2. Grant RELAYER_ROLE to the relayer + vault keeper init (setupTreasuryAndRelayer.ts pattern)");
  console.log(`3. Timelock: SKIP_SMOKE=1 npx hardhat run scripts/setupExchangeTimelock.ts --network ${networkKey}`);
  console.log("4. Cutover: sync frontend/keeper/subgraph from the V2 SSOT, then retire V1");
  console.log("\n✨ V2 deployment complete.\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
