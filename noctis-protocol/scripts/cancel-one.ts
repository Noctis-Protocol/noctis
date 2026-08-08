import { ethers } from "hardhat";

async function main() {
  const VAULT_ADDRESS = "0xB9dcA86284456300dD71DDc13c21bCa5f12bfB81";
  
  const [signer] = await ethers.getSigners();
  console.log("Using account:", signer.address);
  
  const vault = await ethers.getContractAt("NoctisVault", VAULT_ADDRESS);
  
  console.log("\nCancelling withdrawal #1...");
  const tx = await vault.cancelWithdrawal(1, { gasLimit: 3000000 });
  console.log("TX hash:", tx.hash);
  
  const receipt = await tx.wait();
  console.log("✅ Withdrawal #1 cancelled!");
  console.log("Gas used:", receipt?.gasUsed.toString());
}

main().catch(console.error);
