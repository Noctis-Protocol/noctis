import { ethers } from "hardhat";

async function main() {
  const newVaultAddress = "0x78065ee8F35e28D94078a77f939220973d3E888b";
  const oldVaultAddress = "0x0a60729d7d8E493a86b77de8853935414d6d3a76";
  
  console.log("\n📊 Checking Vault Balances on Sepolia\n");
  
  // Check NEW vault
  console.log("🆕 NOUVEAU CONTRAT (avec fix):");
  console.log("   Address:", newVaultAddress);
  const newEthBalance = await ethers.provider.getBalance(newVaultAddress);
  console.log("   ETH Balance:", ethers.formatEther(newEthBalance), "ETH");
  
  const newVault = await ethers.getContractAt("NoctisVault", newVaultAddress);
  try {
    const depositCounter = await newVault.depositCounter();
    console.log("   Total Deposits:", depositCounter.toString());
  } catch {
    console.log("   Total Deposits: 0");
  }
  
  // Check OLD vault
  console.log("\n🗄️  ANCIEN CONTRAT (sans fix):");
  console.log("   Address:", oldVaultAddress);
  const oldEthBalance = await ethers.provider.getBalance(oldVaultAddress);
  console.log("   ETH Balance:", ethers.formatEther(oldEthBalance), "ETH");
  
  const oldVault = await ethers.getContractAt("NoctisVault", oldVaultAddress);
  try {
    const oldDepositCounter = await oldVault.depositCounter();
    console.log("   Total Deposits:", oldDepositCounter.toString());
  } catch {
    console.log("   Total Deposits: N/A");
  }
  
  console.log("\n✅ Le nouveau contrat devrait avoir 0 ETH");
  console.log("✅ L'ancien contrat contient tes fonds précédents\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
