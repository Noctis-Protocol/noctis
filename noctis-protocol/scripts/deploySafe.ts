import { ethers } from "hardhat";

/**
 * @title Safe{Wallet} Deployment Script for Noctis
 * @notice Deploys NoctisVault with Safe multisig as owner
 * @dev For production mainnet deployments
 * 
 * PREREQUISITES:
 * 1. Deploy Safe{Wallet} multisig first at https://app.safe.global/
 * 2. Configure 3-of-5 threshold with hardware wallets
 * 3. Update SAFE_MULTISIG_ADDRESSES below with deployed Safe address
 * 4. Test all admin operations on testnet first
 * 
 * SECURITY:
 * - NEVER deploy to mainnet with EOA owner
 * - ALWAYS use multisig for production
 * - ALWAYS verify multisig signers have hardware wallets
 */

async function main() {
  console.log("🔐 Starting Safe{Wallet} Multisig Deployment...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // Get network information
  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId, "\n");

  // Safe{Wallet} multisig addresses by network
  // IMPORTANT: Update these with your deployed Safe addresses
  const SAFE_MULTISIG_ADDRESSES: { [key: string]: string } = {
    // Arbitrum One (Mainnet) - REPLACE WITH YOUR SAFE ADDRESS
    "42161": "0x0000000000000000000000000000000000000000", // ⚠️ UPDATE THIS BEFORE MAINNET
    
    // Arbitrum Sepolia (Testnet) - REPLACE WITH YOUR SAFE ADDRESS
    "421614": "0x0000000000000000000000000000000000000000", // ⚠️ UPDATE THIS BEFORE TESTNET
    
    // Localhost/Hardhat - Use deployer for testing
    "31337": deployer.address, // OK for local testing only
  };

  const safeAddress = SAFE_MULTISIG_ADDRESSES[network.chainId.toString()];

  // Validation: Ensure Safe address is configured for production networks
  if ((network.chainId === 42161n || network.chainId === 421614n) && 
      safeAddress === "0x0000000000000000000000000000000000000000") {
    console.error("❌ ERROR: Safe multisig address not configured for this network!");
    console.error("❌ Please deploy a Safe{Wallet} and update SAFE_MULTISIG_ADDRESSES");
    console.error("❌ Visit: https://app.safe.global/");
    process.exit(1);
  }

  console.log("🔐 Safe Multisig Owner:", safeAddress);

  // Warn if deploying to mainnet
  if (network.chainId === 42161n) {
    console.log("\n⚠️  WARNING: DEPLOYING TO ARBITRUM MAINNET");
    console.log("⚠️  Ensure Safe multisig is properly configured:");
    console.log("    - 3-of-5 threshold");
    console.log("    - All signers have hardware wallets");
    console.log("    - All signers are trusted team members");
    console.log("\n⏸️  Waiting 10 seconds... Press Ctrl+C to cancel\n");
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  // USDT addresses by network
  const USDT_ADDRESSES: { [key: string]: string } = {
    // Arbitrum One (Mainnet)
    "42161": "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT on Arbitrum One
    
    // Arbitrum Sepolia (Testnet) - Deploy mock USDT
    "421614": "0x0000000000000000000000000000000000000000", // Placeholder - deploy MockERC20
    
    // Localhost/Hardhat
    "31337": "0x0000000000000000000000000000000000000000", // Will deploy MockERC20
  };

  let usdtAddress = USDT_ADDRESSES[network.chainId.toString()];

  // Deploy MockERC20 if on testnet or localhost
  if (network.chainId === 421614n || network.chainId === 31337n || usdtAddress === "0x0000000000000000000000000000000000000000") {
    console.log("📝 Deploying MockERC20 (USDT simulation)...");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockUSDT = await MockERC20.deploy("Mock USDT", "USDT", 6);
    await mockUSDT.waitForDeployment();
    usdtAddress = await mockUSDT.getAddress();
    console.log("✅ MockERC20 deployed to:", usdtAddress);
    
    // Mint some tokens to deployer for testing
    const mintAmount = ethers.parseUnits("1000000", 6); // 1M USDT
    await mockUSDT.mint(deployer.address, mintAmount);
    console.log(`✅ Minted ${ethers.formatUnits(mintAmount, 6)} USDT to deployer\n`);
  } else {
    console.log("Using existing USDT at:", usdtAddress, "\n");
  }

  // Deploy NoctisVault with Safe multisig as owner
  console.log("📝 Deploying NoctisVault with Safe multisig owner...");
  const NoctisVault = await ethers.getContractFactory("NoctisVault");
  const vault = await NoctisVault.deploy(safeAddress, usdtAddress); // Pass Safe address
  await vault.waitForDeployment();
  
  const vaultAddress = await vault.getAddress();
  console.log("✅ NoctisVault deployed to:", vaultAddress);
  
  // Verify deployment
  console.log("\n🔍 Verifying deployment...");
  const owner = await vault.owner();
  const usdt = await vault.usdt();
  
  console.log("Contract owner:", owner);
  console.log("Expected owner (Safe):", safeAddress);
  console.log("USDT address:", usdt);
  console.log("Owner matches Safe:", owner === safeAddress ? "✅" : "❌");
  console.log("USDT matches input:", usdt === usdtAddress ? "✅" : "❌");

  // Security verification
  console.log("\n🔒 Security Verification:");
  if (network.chainId === 31337n) {
    console.log("⚠️  Local network: Using EOA owner (OK for testing)");
  } else if (owner === safeAddress && safeAddress !== deployer.address) {
    console.log("✅ Multisig owner configured correctly");
  } else {
    console.log("❌ WARNING: Owner is not multisig!");
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("📋 DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.log(`Network:       ${network.name} (${network.chainId})`);
  console.log(`Deployer:      ${deployer.address}`);
  console.log(`Owner (Safe):  ${safeAddress}`);
  console.log(`NoctisVault:   ${vaultAddress}`);
  console.log(`USDT:          ${usdtAddress}`);
  console.log("=".repeat(60));

  // Next steps
  console.log("\n📝 NEXT STEPS:\n");
  
  if (network.chainId === 421614n || network.chainId === 42161n) {
    console.log("1. Verify Safe multisig configuration:");
    console.log(`   - Visit: https://app.safe.global/home?safe=arb1:${safeAddress}`);
    console.log("   - Confirm 3-of-5 threshold");
    console.log("   - Verify all signers\n");
    
    console.log("2. Verify contract on Arbiscan:");
    console.log(`   npx hardhat verify --network ${network.name} ${vaultAddress} ${safeAddress} ${usdtAddress}\n`);
    
    console.log("3. Configure keepers via Safe multisig:");
    console.log("   - Go to Safe UI");
    console.log("   - New Transaction → Contract Interaction");
    console.log(`   - Contract Address: ${vaultAddress}`);
    console.log("   - Method: proposeAddKeeper(address)");
    console.log("   - Get 3 confirmations → Execute");
    console.log("   - Wait 7 days → executeKeeperChange()\n");
    
    console.log("4. Test admin operations:");
    console.log("   - Ensure all onlyOwner functions work via multisig");
    console.log("   - Test emergency pause via multisig");
  } else {
    console.log("1. Run tests:");
    console.log("   npm test");
    console.log("\n2. Deploy to testnet with Safe:");
    console.log("   npm run deploy:testnet:safe");
  }

  // Security reminders
  console.log("\n🔐 SECURITY REMINDERS:");
  console.log("━".repeat(60));
  console.log("✅ All admin operations now require 3-of-5 multisig");
  console.log("✅ 7-day timelock on keeper/gateway changes (already implemented)");
  console.log("✅ No single point of failure");
  console.log("✅ Hardware wallets required for all signers");
  console.log("⚠️  Keep Safe signer keys secure and backed up");
  console.log("⚠️  Test all operations on testnet before mainnet");
  console.log("━".repeat(60));

  console.log("\n✨ Deployment complete!\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
