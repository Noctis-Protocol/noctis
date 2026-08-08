import { ethers } from "hardhat";

/**
 * Configure ZAMA Gateway in NoctisVault
 * 
 * This script proposes a new Gateway address for the NoctisVault contract.
 * The Gateway change is subject to a 7-day timelock for security.
 * 
 * ZAMA Gateway Documentation:
 * https://docs.zama.ai/protocol/solidity-guides/smart-contract/configure/contract_addresses
 * 
 * Usage:
 *   # Set environment variables
 *   export VAULT_ADDRESS=0x...
 *   export GATEWAY_ADDRESS=0x...  # From ZAMA docs
 *   
 *   # Run on Sepolia
 *   npx hardhat run scripts/configureGateway.ts --network sepolia
 */

// ============================================
// NETWORK-SPECIFIC GATEWAY ADDRESSES
// ============================================
// Source: https://docs.zama.ai/protocol/solidity-guides/smart-contract/configure/contract_addresses

const GATEWAY_ADDRESSES: Record<number, string> = {
  // Ethereum Sepolia (testnet) - ZAMA DecryptionOracle from @zama-fhe/oracle-solidity
  // Source: node_modules/@zama-fhe/oracle-solidity/address/ZamaOracleAddress.sol
  11155111: "0xa02Cda4Ca3a71D7C46997716F4283aa851C28812",
  
  // Arbitrum Sepolia (testnet) - Not yet available from ZAMA
  421614: "", // Contact ZAMA for Arbitrum Gateway address
  
  // Zama Devnet
  9000: "0x33347831500F1e73f0ccCBb95c9f86B94d7b1123", // Example - verify with ZAMA
};

// Network-specific vault addresses (from deployments)
const VAULT_ADDRESSES: Record<number, string> = {
  11155111: process.env.VAULT_ADDRESS || "", // Ethereum Sepolia - set via env
  421614: "0x545Ce95A3CF5f775b605eeA4a557Bf85567180ce", // Arbitrum Sepolia (legacy)
};

async function main() {
  console.log("🔧 ZAMA Gateway Configuration Script");
  console.log("=".repeat(60));
  console.log("");

  // Get network information
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  console.log(`Network: ${network.name} (Chain ID: ${chainId})`);

  // Get deployer
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Account: ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);
  console.log("");

  // Determine Gateway address
  let gatewayAddress = process.env.GATEWAY_ADDRESS || GATEWAY_ADDRESSES[chainId] || "";
  
  if (!gatewayAddress) {
    console.error("❌ Error: Gateway address not found!");
    console.log("");
    console.log("Options:");
    console.log("1. Set GATEWAY_ADDRESS environment variable:");
    console.log("   export GATEWAY_ADDRESS=0x...");
    console.log("");
    console.log("2. Find the official address from ZAMA docs:");
    console.log("   https://docs.zama.ai/protocol/solidity-guides/smart-contract/configure/contract_addresses");
    console.log("");
    console.log("3. Contact ZAMA for your network:");
    console.log("   Discord: discord.gg/zama");
    console.log("   Forum: community.zama.ai");
    process.exit(1);
  }

  // Determine Vault address
  const vaultAddress = process.env.VAULT_ADDRESS || VAULT_ADDRESSES[chainId] || "";
  
  if (!vaultAddress) {
    console.error("❌ Error: Vault address not found!");
    console.log("");
    console.log("Set VAULT_ADDRESS environment variable:");
    console.log("   export VAULT_ADDRESS=0x...");
    process.exit(1);
  }

  console.log("📋 Configuration:");
  console.log(`   Vault:   ${vaultAddress}`);
  console.log(`   Gateway: ${gatewayAddress}`);
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
  const pendingGateway = await vault.pendingGateway();
  const gatewayChangeTimestamp = await vault.gatewayChangeTimestamp();
  const isConfigured = await vault.isGatewayConfigured();

  console.log(`   Current Gateway:  ${currentGateway}`);
  console.log(`   Pending Gateway:  ${pendingGateway}`);
  console.log(`   Is Configured:    ${isConfigured}`);
  console.log("");

  // Handle pending proposal
  if (pendingGateway !== ethers.ZeroAddress) {
    const now = Math.floor(Date.now() / 1000);
    const executeTime = Number(gatewayChangeTimestamp);
    const timeLeft = executeTime - now;

    console.log("⚠️  Pending Gateway proposal exists!");
    console.log(`   Proposed Gateway: ${pendingGateway}`);
    console.log(`   Execute After:    ${new Date(executeTime * 1000).toISOString()}`);
    
    if (timeLeft <= 0) {
      console.log("   Status: ✅ READY TO EXECUTE");
      console.log("");
      console.log("Run the execution script:");
      console.log(`   npx hardhat run scripts/executeGatewayChange.ts --network ${network.name}`);
    } else {
      const daysLeft = (timeLeft / 86400).toFixed(2);
      const hoursLeft = (timeLeft / 3600).toFixed(1);
      console.log(`   Status: ⏳ Waiting (${daysLeft} days / ${hoursLeft} hours left)`);
    }
    
    console.log("");
    console.log("To propose a different Gateway, the current proposal will be overwritten.");
    console.log("");
  }

  // Check if Gateway is already set to desired address
  if (currentGateway.toLowerCase() === gatewayAddress.toLowerCase()) {
    console.log("✅ Gateway is already configured to the desired address!");
    console.log("");
    return;
  }

  // Propose new Gateway
  console.log("📝 Proposing new Gateway...");
  console.log(`   Address: ${gatewayAddress}`);
  
  try {
    const tx = await vault.connect(deployer).proposeGateway(gatewayAddress);
    console.log(`   Tx Hash: ${tx.hash}`);
    
    const receipt = await tx.wait();
    console.log(`   Block:   ${receipt?.blockNumber}`);
    console.log(`   Gas:     ${receipt?.gasUsed.toString()}`);
    console.log("");

    // Get the new timestamp
    const newTimestamp = await vault.gatewayChangeTimestamp();
    const executeAfter = new Date(Number(newTimestamp) * 1000);

    console.log("=".repeat(60));
    console.log("✅ GATEWAY PROPOSAL SUBMITTED");
    console.log("=".repeat(60));
    console.log("");
    console.log("📋 Summary:");
    console.log(`   Network:          ${network.name} (${chainId})`);
    console.log(`   Vault:            ${vaultAddress}`);
    console.log(`   Proposed Gateway: ${gatewayAddress}`);
    console.log(`   Execute After:    ${executeAfter.toISOString()}`);
    console.log(`   Timelock:         7 days (604800 seconds)`);
    console.log("");
    console.log("⏳ Next Steps:");
    console.log("   1. Wait 7 days for the timelock to expire");
    console.log("   2. Run the execution script:");
    console.log(`      npx hardhat run scripts/executeGatewayChange.ts --network ${network.name}`);
    console.log("");
    console.log("📡 Monitor the proposal:");
    console.log(`   npx hardhat run scripts/checkGatewayStatus.ts --network ${network.name}`);
    console.log("");

  } catch (error: any) {
    console.error("❌ Transaction failed!");
    console.error("");
    
    if (error.message?.includes("InvalidGateway")) {
      console.error("Error: Invalid Gateway address (must be a contract, not EOA)");
    } else if (error.message?.includes("OwnableUnauthorizedAccount")) {
      console.error("Error: Only the owner can propose Gateway changes");
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
