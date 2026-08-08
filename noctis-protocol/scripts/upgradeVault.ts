import { ethers } from "hardhat";

/**
 * @notice Redeploy NoctisVault with PRIVACY FIX
 * @dev This script deploys a new NoctisVault with hasSufficientBalance (ebool)
 *      instead of revealing the user's actual balance during withdrawals.
 * 
 * PRIVACY IMPROVEMENT:
 *   - Before: Decrypted originalBalance (euint128) → revealed exact user balance
 *   - After:  Decrypted hasSufficientBalance (ebool) → only reveals true/false
 * 
 * IMPORTANT: This creates a NEW vault. Users will need to migrate their funds.
 */
async function main() {
  console.log("🚀 Deploying NEW NoctisVault with ACL batch fix...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // Get network information
  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId, "\n");

  // Use existing MockUSDT from previous deployment
  // On Sepolia, we can use the same mock USDT address
  let usdtAddress: string;
  
  if (network.chainId === 11155111n) {
    // Deploy new MockERC20 for the new vault
    console.log("📝 Deploying new MockERC20 (USDT)...");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockUSDT = await MockERC20.deploy("Mock USDT", "USDT", 6);
    await mockUSDT.waitForDeployment();
    usdtAddress = await mockUSDT.getAddress();
    console.log("✅ MockERC20 deployed to:", usdtAddress, "\n");
  } else {
    throw new Error("Unsupported network");
  }

  // Deploy NEW NoctisVault with privacy fix (hasSufficientBalance instead of originalBalance)
  console.log("📝 Deploying NEW NoctisVault (with PRIVACY FIX)...");
  const NoctisVaultFactory = await ethers.getContractFactory("NoctisVault");
  const vault = await NoctisVaultFactory.deploy(deployer.address, usdtAddress);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log("✅ NEW NoctisVault deployed to:", vaultAddress);
  
  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("📋 UPGRADE SUMMARY");
  console.log("=".repeat(60));
  console.log(`Network:              ${network.name} (${network.chainId})`);
  console.log(`NEW NoctisVault:      ${vaultAddress}`);
  console.log(`USDT Address:         ${usdtAddress}`);
  console.log("");
  console.log("PRIVACY FIX APPLIED:");
  console.log("  - Uses hasSufficientBalance (ebool) instead of originalBalance (euint128)");
  console.log("  - Only reveals true/false, NOT the actual user balance");
  console.log("  - Uses _makePubliclyDecryptableBatchAmountBool() for ACL batch fix");
  console.log("=".repeat(60));

  console.log("\n⚠️  IMPORTANT NEXT STEPS:\n");
  console.log("1. Update frontend .env.local with new vault address:");
  console.log(`   NEXT_PUBLIC_VAULT_ADDRESS=${vaultAddress}`);
  console.log("");
  console.log("2. Update subgraph configuration to index new vault");
  console.log("");
  console.log("3. Users need to migrate funds from old vault to new vault");
  console.log("");
  console.log("4. Verify contract on Etherscan:");
  console.log(`   npx hardhat verify --network sepolia ${vaultAddress} "${deployer.address}" "${usdtAddress}"`);

  console.log("\n✨ Vault upgrade complete!\n");

  return { vaultAddress, vault };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
