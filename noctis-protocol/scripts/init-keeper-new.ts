import { ethers } from "hardhat";

async function main() {
  const vaultAddress = "0xD888774Be1d28aE3668be232eE412a62E99685FD";
  const vault = await ethers.getContractAt("NoctisVault", vaultAddress);
  
  const [signer] = await ethers.getSigners();
  console.log("Owner:", signer.address);
  
  const count = await vault.getKeeperCount();
  console.log("Current keepers:", count.toString());
  
  if (count > 0n) {
    console.log("Keepers already initialized!");
    return;
  }
  
  console.log("Initializing keeper:", signer.address);
  const tx = await vault.initializeKeepers([signer.address], 1);
  console.log("Tx:", tx.hash);
  await tx.wait();
  console.log("Done!");
}

main().catch(console.error);
