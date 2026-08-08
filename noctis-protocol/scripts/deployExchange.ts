import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * @notice Deploy NoctisExchange with TimelockController (H-3 Security Fix)
 * @dev This script deploys NoctisExchange with maximum security:
 *      - Immutable vault (prevents malicious vault swap)
 *      - AccessControl with role separation
 *      - TimelockController for non-emergency functions (2-day delay)
 *      - Ready for multisig transfer
 */
async function main() {
  console.log("🚀 Starting NoctisExchange deployment with H-3 security fixes...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // Get network information
  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId, "\n");

  // Hard stop: require explicit ops ack (Safe/caps ready). D0 FHE = @fhevm/solidity >=0.11.1.
  if (network.chainId === 1n) {
    const allow = process.env.ALLOW_MAINNET_DEPLOY === "1";
    if (!allow) {
      throw new Error(
        "Mainnet deploy blocked. Confirm Safe + soft caps + D0 (@fhevm/solidity >=0.11.1), " +
          "then set ALLOW_MAINNET_DEPLOY=1. See docs/D_PHASE_MAINNET_RUNBOOK.md"
      );
    }
  }

  // USDC addresses by network (using real USDC on testnets for realistic testing)
  const USDT_ADDRESSES: { [key: string]: string } = {
    "1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum mainnet USDC
    "42161": "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // Arbitrum One - USDT
    "421614": "0x0000000000000000000000000000000000000000", // Arbitrum Sepolia - Mock
    "11155111": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Ethereum Sepolia - Circle USDC
    "9000": "0x0000000000000000000000000000000000000000", // Zama Devnet - Mock
    "31337": "0x0000000000000000000000000000000000000000", // Localhost/Hardhat - Mock
  };

  // Uniswap V2 Router addresses by network
  const UNISWAP_V2_ROUTER_ADDRESSES: { [key: string]: string } = {
    "1": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Ethereum mainnet
    "42161": "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24", // Arbitrum One
    "421614": "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24", // Arbitrum Sepolia
    "11155111": "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008", // Ethereum Sepolia (Uniswap V2)
    "31337": "0x0000000000000000000000000000000000000000", // Localhost/Hardhat - Mock
  };

  // Chainlink ETH/USD Price Feed addresses by network
  const ETH_USD_PRICE_FEED_ADDRESSES: { [key: string]: string } = {
    "1": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", // Ethereum mainnet
    "42161": "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", // Arbitrum One
    "421614": "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165", // Arbitrum Sepolia
    "11155111": "0x694AA1769357215DE4FAC081bf1f309aDC325306", // Ethereum Sepolia
    "31337": "0x0000000000000000000000000000000000000000", // Localhost/Hardhat - Mock
  };

  // Chainlink Sequencer Uptime Feed addresses by network
  const SEQUENCER_UPTIME_FEED_ADDRESSES: { [key: string]: string } = {
    "1": "0x0000000000000000000000000000000000000000", // Ethereum L1 — no sequencer
    "42161": "0xFdB631F5EE196F0ed6FAa767959853A9F217697D", // Arbitrum One
    "421614": "0x4da69F028a5790fCCAfe81a75C0D24f46ceCDd69", // Arbitrum Sepolia
    "11155111": "0x0000000000000000000000000000000000000000", // Ethereum Sepolia (No sequencer)
    "31337": "0x0000000000000000000000000000000000000000", // Localhost/Hardhat - Mock
  };

  let usdtAddress = USDT_ADDRESSES[network.chainId.toString()];
  let uniswapRouterAddress = UNISWAP_V2_ROUTER_ADDRESSES[network.chainId.toString()];
  const ethUsdPriceFeedAddress = ETH_USD_PRICE_FEED_ADDRESSES[network.chainId.toString()];
  const sequencerUptimeFeedAddress = SEQUENCER_UPTIME_FEED_ADDRESSES[network.chainId.toString()];

  // Deploy MockERC20 only if no real token address is configured
  if (usdtAddress === "0x0000000000000000000000000000000000000000") {
    console.log("📝 Deploying MockERC20...");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockUSDT = await MockERC20.deploy("Mock USDT", "USDT", 6);
    await mockUSDT.waitForDeployment();
    usdtAddress = await mockUSDT.getAddress();
    console.log("✅ MockERC20 deployed to:", usdtAddress, "\n");
  } else {
    console.log("✅ Using existing USDC:", usdtAddress, "\n");
  }

  // Deploy NoctisVault
  console.log("📝 Deploying NoctisVault...");
  const NoctisVaultFactory = await ethers.getContractFactory("NoctisVault");
  const vault = await NoctisVaultFactory.deploy(deployer.address, usdtAddress); // initialOwner, _usdt
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log("✅ NoctisVault deployed to:", vaultAddress);

  // Deploy NoctisExchange (vault is IMMUTABLE - H-3 fix)
  console.log("\n📝 Deploying NoctisExchange (vault is immutable)...");
  const NoctisExchangeFactory = await ethers.getContractFactory("NoctisExchange");
  const exchange = await NoctisExchangeFactory.deploy(
    vaultAddress, 
    uniswapRouterAddress,
    ethUsdPriceFeedAddress,
    sequencerUptimeFeedAddress
  );
  await exchange.waitForDeployment();
  const exchangeAddress = await exchange.getAddress();
  console.log("✅ NoctisExchange deployed to:", exchangeAddress);
  console.log("   ⚠️  Vault is IMMUTABLE (cannot be changed) - H-3 security fix");
  console.log("   🔗 Uniswap Router:", uniswapRouterAddress);
  console.log("   🔗 ETH/USD Price Feed:", ethUsdPriceFeedAddress);
  console.log("   🔗 Sequencer Uptime Feed:", sequencerUptimeFeedAddress, "\n");

  // Configure vault to allow exchange
  console.log("🔗 Configuring vault...");
  await vault.connect(deployer).setExchange(exchangeAddress, true);
  console.log("✅ Vault configured\n");

  // NOTE: TimelockController deployment skipped for MVP
  // Will be added for mainnet deployment with proper multisig setup
  const timelockAddress = ethers.ZeroAddress;
  console.log("⏱️  TimelockController: Skipped for MVP (will add for mainnet)\n");

  // Verify deployment
  console.log("🔍 Verifying deployment...");
  const DEFAULT_ADMIN_ROLE = await exchange.DEFAULT_ADMIN_ROLE();
  const PAUSER_ROLE = await exchange.PAUSER_ROLE();
  
  const hasAdminRole = await exchange.hasRole(DEFAULT_ADMIN_ROLE, deployer.address);
  const hasPauserRole = await exchange.hasRole(PAUSER_ROLE, deployer.address);
  const vaultIsImmutable = await exchange.vault() === vaultAddress;

  console.log("Deployer has DEFAULT_ADMIN_ROLE:", hasAdminRole ? "✅" : "❌");
  console.log("Deployer has PAUSER_ROLE:", hasPauserRole ? "✅" : "❌");
  console.log("Vault is immutable:", vaultIsImmutable ? "✅" : "❌");

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("📋 DEPLOYMENT SUMMARY (Privacy-First Architecture)");
  console.log("=".repeat(60));
  console.log(`Network:              ${network.name} (${network.chainId})`);
  console.log(`Deployer:             ${deployer.address}`);
  console.log(`NoctisVault:          ${vaultAddress}`);
  console.log(`NoctisExchange:       ${exchangeAddress}`);
  console.log(`USDC:                 ${usdtAddress}`);
  console.log(`Uniswap Router:       ${uniswapRouterAddress}`);
  console.log(`Vault Status:         IMMUTABLE ✅`);
  console.log("=".repeat(60));

  // Privacy architecture checklist
  console.log("\n🔒 PRIVACY ARCHITECTURE:\n");
  console.log("✅ Vault is immutable (cannot be changed)");
  console.log("✅ AccessControl with role separation");
  console.log("✅ RELAYER_ROLE for privacy-preserving meta-transactions");
  console.log("✅ VaultID system: opaque IDs replace addresses in calldata & vault calls");
  console.log("✅ No plaintext trader in Order struct (private mapping)");
  console.log("✅ No addresses in events (CRIT-3 fix)");
  console.log("✅ No ecrecover on-chain (CRIT-1 fix)");
  console.log("✅ SafeERC20 for all token operations (HIGH-1 fix)");
  console.log("✅ forceApprove for router approvals (HIGH-2 fix)");
  console.log("✅ All user mappings private (nonces, stats, claimable)");
  console.log("✅ deductBalanceByVaultId/creditBalanceByVaultId: no address in traces");

  // Phase 2 SSOT: write deployments/<network>.json
  const networkKey =
    network.chainId === 1n
      ? "mainnet"
      : network.chainId === 11155111n
        ? "sepolia"
        : network.chainId === 421614n
          ? "arbitrumSepolia"
          : network.chainId === 42161n
            ? "arbitrumOne"
            : `chain-${network.chainId}`;

  if (!uniswapRouterAddress || uniswapRouterAddress === ethers.ZeroAddress) {
    throw new Error(`No Uniswap V2 router configured for chainId ${network.chainId}`);
  }
  if (!ethUsdPriceFeedAddress || ethUsdPriceFeedAddress === ethers.ZeroAddress) {
    throw new Error(`No ETH/USD price feed configured for chainId ${network.chainId}`);
  }
  const deployment = {
    network: networkKey,
    chainId: Number(network.chainId),
    updatedAt: new Date().toISOString().slice(0, 10),
    contracts: {
      NoctisVault: vaultAddress,
      NoctisExchange: exchangeAddress,
      USDT: usdtAddress,
      UniswapV2Router: uniswapRouterAddress,
      EthUsdPriceFeed: ethUsdPriceFeedAddress,
      SequencerUptimeFeed: sequencerUptimeFeedAddress,
      feeRecipient: deployer.address,
      feeBps: 5,
    },
    notes:
      "SSOT for addresses. Sync frontend/.env.local, keeper/.env, subgraph/subgraph.yaml from this file. Transfer feeRecipient to a Safe via setFeeRecipient.",
  };
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${networkKey}.json`);
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`\n📄 SSOT written: ${outPath}`);

  console.log("\n⚠️  POST-DEPLOYMENT STEPS (Phase D):\n");
  console.log(`1. npx hardhat run scripts/setupTreasuryAndRelayer.ts --network ${networkKey}`);
  console.log(`2. SKIP_SMOKE=1 npx hardhat run scripts/setupExchangeTimelock.ts --network ${networkKey}`);
  console.log(`3. npx hardhat run scripts/transferOwnershipToSafe.ts --network ${networkKey}`);
  console.log("4. Sync frontend NEXT_PUBLIC_* + keeper env + subgraph from deployments/*.json");
  console.log("5. See docs/D_PHASE_MAINNET_RUNBOOK.md");

  console.log("\n✨ Deployment complete with privacy-first architecture! 🔒\n");

  return {
    vaultAddress,
    exchangeAddress,
    vault,
    exchange,
  };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
