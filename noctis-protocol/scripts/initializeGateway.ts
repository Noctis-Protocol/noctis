import { ethers } from "hardhat";

/**
 * Initialize ZAMA Gateway in NoctisVault (First-time setup - BYPASSES timelock)
 * 
 * This script uses initializeGateway() which works ONLY if gateway has never been set.
 * This bypasses the 7-day timelock, allowing immediate configuration.
 * 
 * After first initialization, all future changes require timelock via proposeGateway().
 * 
 * Usage:
 *   export VAULT_ADDRESS=0xB487BeEC74B1E8793e66Dd05612032F555abC795
 *   npx hardhat run scripts/initializeGateway.ts --network sepolia
 */

// Official ZAMA Gateway address for Sepolia (from @zama-fhe/oracle-solidity)
const SEPOLIA_GATEWAY = "0xa02Cda4Ca3a71D7C46997716F4283aa851C28812";

async function main() {
  console.log("🚀 Initialize ZAMA Gateway (First-Time Setup)");
  console.log("=".repeat(60));
  console.log("");

  // Get network information
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  console.log(`Network: ${network.name} (Chain ID: ${chainId})`);

  if (chainId !== 11155111) {
    console.error("❌ Error: This script is for Sepolia only (Chain ID 11155111)");
    process.exit(1);
  }

  // Get deployer
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Account: ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);
  console.log("");

  // Get vault address
  const vaultAddress = process.env.VAULT_ADDRESS;
  
  if (!vaultAddress) {
    console.error("❌ Error: VAULT_ADDRESS not set!");
    console.log("");
    console.log("Set environment variable:");
    console.log("   export VAULT_ADDRESS=0x...");
    process.exit(1);
  }

  console.log("📋 Configuration:");
  console.log(`   Vault:   ${vaultAddress}`);
  console.log(`   Gateway: ${SEPOLIA_GATEWAY}`);
  console.log("");

  // Connect to vault
  console.log("📝 Connecting to NoctisVault...");
  const vault = await ethers.getContractAt("NoctisVault", vaultAddress);
  
  // Verify contract exists
  const code = await ethers.provider.getCode(vaultAddress);
  if (code === "0x") {
    console.error("❌ Error: No contract found at vault address!");
    process.exit(1);
  }
  console.log("✅ Connected to vault");
  console.log("");

  // Check current Gateway state
  console.log("🔍 Checking current Gateway state...");
  
  const currentGateway = await vault.gateway();
  const isConfigured = await vault.isGatewayConfigured();

  console.log(`   Current Gateway:  ${currentGateway}`);
  console.log(`   Is Configured:    ${isConfigured}`);
  console.log("");

  // Check if already configured
  if (isConfigured) {
    console.error("❌ Error: Gateway is already configured!");
    console.log("");
    console.log("initializeGateway() can ONLY be used for first-time setup.");
    console.log("To change Gateway, use the timelock pattern:");
    console.log(`   npx hardhat run scripts/configureGateway.ts --network ${network.name}`);
    process.exit(1);
  }

  // Initialize Gateway (bypasses timelock)
  console.log("🚀 Initializing Gateway (bypasses 7-day timelock)...");
  console.log(`   Address: ${SEPOLIA_GATEWAY}`);
  console.log("");
  
  try {
    // Estimate gas first
    const gasEstimate = await vault.initializeGateway.estimateGas(SEPOLIA_GATEWAY);
    console.log(`   Estimated Gas: ${gasEstimate.toString()}`);
    
    // Execute transaction
    const tx = await vault.connect(deployer).initializeGateway(SEPOLIA_GATEWAY);
    console.log(`   Tx Hash: ${tx.hash}`);
    console.log("   ⏳ Waiting for confirmation...");
    
    const receipt = await tx.wait();
    console.log(`   ✅ Block:   ${receipt?.blockNumber}`);
    console.log(`   ✅ Gas Used: ${receipt?.gasUsed.toString()}`);
    console.log("");

    // Verify configuration
    const newGateway = await vault.gateway();
    const newIsConfigured = await vault.isGatewayConfigured();

    console.log("=".repeat(60));
    console.log("✅ GATEWAY INITIALIZED SUCCESSFULLY");
    console.log("=".repeat(60));
    console.log("");
    console.log("📋 Summary:");
    console.log(`   Network:          ${network.name} (${chainId})`);
    console.log(`   Vault:            ${vaultAddress}`);
    console.log(`   Gateway:          ${newGateway}`);
    console.log(`   Is Configured:    ${newIsConfigured ? "✅ Yes" : "❌ No"}`);
    console.log("");
    console.log("🎉 Your vault can now use ZAMA Gateway for decryption!");
    console.log("");
    console.log("📡 Test withdrawal execution:");
    console.log("   1. Create a withdrawal request (user action)");
    console.log("   2. Keeper calls requestWithdrawalExecution()");
    console.log("   3. Gateway decrypts and calls executeWithdrawalCallback()");
    console.log("");
    console.log("⚠️  Important: Future Gateway changes require 7-day timelock.");
    console.log("");

  } catch (error: any) {
    console.error("❌ Transaction failed!");
    console.error("");
    
    if (error.message?.includes("InvalidGateway")) {
      console.error("Error: Invalid Gateway address");
      console.error("   - Must be a contract (not EOA)");
      console.error("   - Must not be zero address");
    } else if (error.message?.includes("OwnableUnauthorizedAccount")) {
      console.error("Error: Only the owner can initialize Gateway");
      console.error(`   Current signer: ${deployer.address}`);
    } else if (error.message?.includes("revert")) {
      console.error("Error: Gateway is already configured");
      console.error("   initializeGateway() only works for first-time setup");
    } else {
      console.error(error.message || error);
    }
    
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
