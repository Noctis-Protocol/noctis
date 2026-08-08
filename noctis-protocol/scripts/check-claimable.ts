import { ethers } from "hardhat";

async function main() {
  const vaultAddress = "0x0a60729d7d8E493a86b77de8853935414d6d3a76";
  const userAddress = "0x0a8141174241824a0244889c6f846c3975aad8f7";
  
  const vault = await ethers.getContractAt("NoctisVault", vaultAddress);
  const claimable = await vault.claimableETH(userAddress);
  
  console.log("\n=== CLAIMABLE ETH ===");
  console.log("User:", userAddress);
  console.log("Claimable:", ethers.formatEther(claimable), "ETH");
  console.log("Raw:", claimable.toString(), "wei");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
