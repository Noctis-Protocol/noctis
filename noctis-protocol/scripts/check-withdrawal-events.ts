import { ethers } from "hardhat";

async function main() {
  // Use checksummed address
  const vaultAddress = ethers.getAddress("0x3172E00d5887090fD355826fD3Ad5c2ACB759934");
  const vault = await ethers.getContractAt("NoctisVault", vaultAddress);
  
  const provider = ethers.provider;
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = currentBlock - 5000;
  
  console.log("=== Checking Withdrawal Events ===");
  console.log("Vault address:", vaultAddress);
  console.log("Searching blocks", fromBlock, "to", currentBlock);
  
  // Check for successful WithdrawalExecuted events
  const withdrawFilter = vault.filters.WithdrawalExecuted();
  const withdrawEvents = await vault.queryFilter(withdrawFilter, fromBlock, currentBlock);
  
  console.log("\n✅ WithdrawalExecuted events:", withdrawEvents.length);
  for (const event of withdrawEvents.slice(-5)) {
    console.log("  - Block:", event.blockNumber, "TX:", event.transactionHash.slice(0, 20) + "...");
  }
  
  // Check for DecryptionReady events (withdrawal flow)
  const decryptFilter = vault.filters.DecryptionReady();
  const decryptEvents = await vault.queryFilter(decryptFilter, fromBlock, currentBlock);
  
  console.log("\n📦 DecryptionReady events:", decryptEvents.length);
  for (const event of decryptEvents.slice(-5)) {
    console.log("  - Block:", event.blockNumber, "RequestId:", event.args?.requestId?.toString());
  }
}

main().catch(console.error);
