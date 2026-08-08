import { ethers } from "hardhat";

async function main() {
  console.log("🔐 Initializing Keepers on NoctisVault\n");
  
  const vaultAddress = "0x78065ee8F35e28D94078a77f939220973d3E888b";
  const vault = await ethers.getContractAt("NoctisVault", vaultAddress);
  
  const [signer] = await ethers.getSigners();
  console.log("Owner:", signer.address);
  
  // Check if keepers already exist
  const count = await vault.getKeeperCount();
  console.log("Current keepers:", count.toString());
  
  if (count > 0n) {
    console.log("❌ Keepers already initialized!");
    return;
  }
  
  // For testing, we'll use the owner as the keeper
  // In production, this would be separate addresses
  const keeperAddress = signer.address;
  
  console.log("\n📝 Initializing with keeper:", keeperAddress);
  console.log("   Setting minKeepers: 1 (for testing)");
  
  const tx = await vault.initializeKeepers([keeperAddress], 1);
  console.log("   Tx:", tx.hash);
  
  const receipt = await tx.wait();
  console.log("   ✅ Done! Gas used:", receipt?.gasUsed.toString());
  
  // Verify
  const newCount = await vault.getKeeperCount();
  console.log("\n✅ Keepers now:", newCount.toString());
  
  const isKeeper = await vault.isKeeper(keeperAddress);
  console.log("   Is keeper:", isKeeper);
}

main().catch((error) => {
  console.error("❌ Error:", error.message);
  process.exit(1);
});
