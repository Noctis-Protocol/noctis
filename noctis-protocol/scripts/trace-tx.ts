/**
 * Trace Transaction Script
 * 
 * Traces a requestWithdrawalExecution transaction to see if there were any internal failures.
 */

import { ethers } from "hardhat";

const VAULT_ADDRESS = "0xD888774Be1d28aE3668be232eE412a62E99685FD";

async function main() {
  const requestId = parseInt(process.argv[2] || "6");
  
  console.log("=".repeat(60));
  console.log("Tracing Withdrawal Request", requestId);
  console.log("=".repeat(60));
  
  const [signer] = await ethers.getSigners();
  
  // Get the Vault contract
  const vault = await ethers.getContractAt("NoctisVault", VAULT_ADDRESS, signer);
  
  // Get withdrawal request
  const request = await vault.withdrawalRequests(requestId);
  console.log("Gateway Requested:", request.gatewayRequested);
  console.log("Gateway Request Time:", new Date(Number(request.gatewayRequestTime) * 1000).toISOString());
  console.log("");
  
  // Check if we can simulate the transaction again
  console.log("📋 Simulating makePubliclyDecryptable calls...");
  
  // Try to call makePubliclyDecryptable for the balance handle using a test contract
  // Unfortunately we can't directly call internal library functions
  // But we can check the trace of recent transactions
  
  // Get recent transactions to this contract
  const provider = signer.provider!;
  const currentBlock = await provider.getBlockNumber();
  
  console.log("Current block:", currentBlock);
  console.log("Scanning recent blocks for requestWithdrawalExecution calls...");
  
  // Look for the DecryptionReady event which is emitted after makePubliclyDecryptable
  const filter = vault.filters.DecryptionReady(BigInt(requestId));
  const events = await vault.queryFilter(filter, currentBlock - 10000, currentBlock);
  
  console.log("Found", events.length, "DecryptionReady events for request", requestId);
  
  for (const event of events) {
    console.log("");
    console.log("Transaction:", event.transactionHash);
    console.log("Block:", event.blockNumber);
    
    // Get transaction receipt to check gas usage
    const receipt = await provider.getTransactionReceipt(event.transactionHash);
    if (receipt) {
      console.log("Gas Used:", receipt.gasUsed.toString());
      console.log("Status:", receipt.status === 1 ? "SUCCESS" : "FAILED");
      
      // Get the original transaction
      const tx = await provider.getTransaction(event.transactionHash);
      if (tx) {
        console.log("Gas Limit:", tx.gasLimit.toString());
        console.log("Gas Used %:", ((Number(receipt.gasUsed) * 100) / Number(tx.gasLimit)).toFixed(2) + "%");
      }
      
      // Check logs for ACL calls
      console.log("");
      console.log("Logs in transaction:", receipt.logs.length);
      
      // Look for ACL events
      const ACL_ADDRESS = "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D".toLowerCase();
      const aclLogs = receipt.logs.filter(log => log.address.toLowerCase() === ACL_ADDRESS);
      console.log("ACL logs:", aclLogs.length);
    }
  }
  
  console.log("");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
