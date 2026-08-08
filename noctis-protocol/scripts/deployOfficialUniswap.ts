import { ethers } from "hardhat";

/**
 * @title Full Deployment with Official Uniswap V2 on Sepolia
 * @notice Deploys NoctisVault + NoctisExchange using official Uniswap addresses
 * 
 * Official Uniswap V2 Sepolia Addresses:
 * - Router: 0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3
 * - WETH: 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14
 * - USDC: 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 (has liquidity!)
 * 
 * Chainlink Price Feeds (Sepolia):
 * - ETH/USD: 0x694AA1769357215DE4FAC081bf1f309aDC325306
 */

// Official Uniswap V2 Sepolia addresses
const OFFICIAL_UNISWAP = {
  ROUTER: "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3",
  WETH: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Circle's official USDC on Sepolia
};

// Chainlink price feeds
const CHAINLINK = {
  ETH_USD: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
  SEQUENCER: "0x0000000000000000000000000000000000000000", // No sequencer on L1 Sepolia
};

async function main() {
  console.log("🚀 Deploying Noctis with Official Uniswap V2 on Sepolia...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId);

  if (network.chainId !== 11155111n) {
    console.error("❌ This script is for Sepolia only (chainId 11155111)");
    process.exit(1);
  }

  console.log("\n📋 Official Uniswap V2 Addresses:");
  console.log("   Router:", OFFICIAL_UNISWAP.ROUTER);
  console.log("   WETH:  ", OFFICIAL_UNISWAP.WETH);
  console.log("   USDC:  ", OFFICIAL_UNISWAP.USDC);

  // Verify Uniswap router works
  console.log("\n🔍 Verifying Uniswap connection...");
  const router = await ethers.getContractAt("IUniswapV2Router02", OFFICIAL_UNISWAP.ROUTER);
  const weth = await router.WETH();
  console.log("   Router WETH:", weth);
  
  if (weth.toLowerCase() !== OFFICIAL_UNISWAP.WETH.toLowerCase()) {
    console.error("❌ WETH mismatch! Expected:", OFFICIAL_UNISWAP.WETH);
    process.exit(1);
  }
  console.log("   ✅ Router verified\n");

  // Check USDC/WETH pool has liquidity
  console.log("🔍 Checking USDC/WETH liquidity...");
  try {
    const amounts = await router.getAmountsOut(ethers.parseEther("1"), [OFFICIAL_UNISWAP.WETH, OFFICIAL_UNISWAP.USDC]);
    const price = Number(amounts[1]) / 1e6;
    console.log(`   1 ETH = ${price.toFixed(2)} USDC`);
    console.log("   ✅ Pool has liquidity\n");
  } catch (e) {
    console.error("❌ No liquidity in USDC/WETH pool!");
    process.exit(1);
  }

  // ==========================================
  // STEP 1: Deploy NoctisVault
  // ==========================================
  console.log("📝 Step 1: Deploying NoctisVault...");
  const NoctisVault = await ethers.getContractFactory("NoctisVault");
  const vault = await NoctisVault.deploy(deployer.address, OFFICIAL_UNISWAP.USDC);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log("   ✅ NoctisVault deployed to:", vaultAddress);

  // Verify vault config
  const vaultUsdc = await vault.usdt(); // Variable is named usdt but contains USDC address
  console.log("   Stablecoin (USDC):", vaultUsdc);

  // ==========================================
  // STEP 2: Deploy NoctisExchange
  // ==========================================
  console.log("\n📝 Step 2: Deploying NoctisExchange...");
  const NoctisExchange = await ethers.getContractFactory("NoctisExchange");
  const exchange = await NoctisExchange.deploy(
    vaultAddress,
    OFFICIAL_UNISWAP.ROUTER,
    CHAINLINK.ETH_USD,
    CHAINLINK.SEQUENCER
  );
  await exchange.waitForDeployment();
  const exchangeAddress = await exchange.getAddress();
  console.log("   ✅ NoctisExchange deployed to:", exchangeAddress);

  // Verify exchange config
  const exchangeRouter = await exchange.uniswapRouter();
  const exchangeWeth = await exchange.WETH();
  console.log("   Uniswap Router:", exchangeRouter);
  console.log("   WETH:", exchangeWeth);

  // ==========================================
  // STEP 3: Configure Vault to allow Exchange
  // ==========================================
  console.log("\n📝 Step 3: Configuring Vault to allow Exchange...");
  const setExchangeTx = await vault.setExchange(exchangeAddress, true);
  await setExchangeTx.wait();
  console.log("   ✅ Vault configured to allow Exchange");

  // ==========================================
  // STEP 4: Add deployer as keeper (for testing)
  // ==========================================
  console.log("\n📝 Step 4: Adding deployer as keeper...");
  try {
    const addKeeperTx = await exchange.addKeeper(deployer.address);
    await addKeeperTx.wait();
    console.log("   ✅ Deployer added as keeper");
  } catch (e: any) {
    console.log("   ⚠️ Could not add keeper:", e.message?.slice(0, 100));
  }

  // ==========================================
  // SUMMARY
  // ==========================================
  console.log("\n" + "=".repeat(70));
  console.log("📋 DEPLOYMENT SUMMARY");
  console.log("=".repeat(70));
  console.log(`Network:           Sepolia (${network.chainId})`);
  console.log(`Deployer:          ${deployer.address}`);
  console.log("");
  console.log("Contracts:");
  console.log(`  NoctisVault:     ${vaultAddress}`);
  console.log(`  NoctisExchange:  ${exchangeAddress}`);
  console.log("");
  console.log("External Addresses:");
  console.log(`  Uniswap Router:  ${OFFICIAL_UNISWAP.ROUTER}`);
  console.log(`  WETH:            ${OFFICIAL_UNISWAP.WETH}`);
  console.log(`  USDC:            ${OFFICIAL_UNISWAP.USDC}`);
  console.log(`  ETH/USD Feed:    ${CHAINLINK.ETH_USD}`);
  console.log("=".repeat(70));

  console.log("\n📝 REQUIRED UPDATES:\n");
  
  console.log("1. Update frontend/.env.local:");
  console.log("   ─────────────────────────────────────────────────────");
  console.log(`   NEXT_PUBLIC_VAULT_ADDRESS=${vaultAddress}`);
  console.log(`   NEXT_PUBLIC_EXCHANGE_ADDRESS=${exchangeAddress}`);
  console.log(`   NEXT_PUBLIC_USDT_ADDRESS=${OFFICIAL_UNISWAP.USDC}`);
  console.log("   ─────────────────────────────────────────────────────");

  console.log("\n2. Update subgraph/subgraph.yaml:");
  console.log("   - NoctisVault address:", vaultAddress);
  console.log("   - NoctisExchange address:", exchangeAddress);

  console.log("\n3. Update useEthPrice hook:");
  console.log("   - Use Uniswap getAmountsOut with official router");
  console.log("   - WETH:", OFFICIAL_UNISWAP.WETH);
  console.log("   - USDC:", OFFICIAL_UNISWAP.USDC);

  console.log("\n4. Get test USDC:");
  console.log("   - Circle faucet: https://faucet.circle.com/");
  console.log("   - Select Sepolia network");

  console.log("\n✨ Deployment complete!\n");

  return {
    vault: vaultAddress,
    exchange: exchangeAddress,
    usdc: OFFICIAL_UNISWAP.USDC,
    router: OFFICIAL_UNISWAP.ROUTER,
    weth: OFFICIAL_UNISWAP.WETH,
  };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
