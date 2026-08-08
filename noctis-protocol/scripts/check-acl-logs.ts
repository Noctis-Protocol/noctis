/**
 * Check ACL Logs Script
 * 
 * Examines the ACL logs from a specific transaction to understand what happened.
 */

import { ethers } from "hardhat";

const VAULT_ADDRESS = "0xD888774Be1d28aE3668be232eE412a62E99685FD";
const ACL_ADDRESS = "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D";
const TX_HASH = "0x2f1b0e6578bd9942ff0645129be572e2a121f0a003dbef6a4cfed9f1756e317f";

// Known ACL event signatures
const ALLOWED_SIG = ethers.id("Allowed(bytes32,address)");  // First 4 bytes = 0x
const ALLOWED_FOR_DECRYPTION_SIG = ethers.id("AllowedForDecryption(bytes32[])");

async function main() {
  console.log("=".repeat(60));
  console.log("Examining ACL logs for transaction:");
  console.log(TX_HASH);
  console.log("=".repeat(60));
  
  const [signer] = await ethers.getSigners();
  const provider = signer.provider!;
  
  // Get the transaction receipt
  const receipt = await provider.getTransactionReceipt(TX_HASH);
  if (!receipt) {
    console.log("Transaction not found");
    return;
  }
  
  console.log("Transaction Status:", receipt.status === 1 ? "SUCCESS" : "FAILED");
  console.log("Block:", receipt.blockNumber);
  console.log("Total logs:", receipt.logs.length);
  console.log("");
  
  // Filter ACL logs
  const aclLogs = receipt.logs.filter(log => 
    log.address.toLowerCase() === ACL_ADDRESS.toLowerCase()
  );
  
  console.log("ACL logs:", aclLogs.length);
  console.log("");
  
  // Known event topics from Zama ACL
  const ALLOWED_TOPIC = "0x" + ethers.id("Allowed(bytes32,address)").slice(2);
  const ALLOWED_FOR_DECRYPTION_TOPIC = "0x" + ethers.id("AllowedForDecryption(bytes32[])").slice(2);
  
  console.log("Expected topics:");
  console.log("  Allowed:", ALLOWED_TOPIC);
  console.log("  AllowedForDecryption:", ALLOWED_FOR_DECRYPTION_TOPIC);
  console.log("");
  
  for (let i = 0; i < aclLogs.length; i++) {
    const log = aclLogs[i];
    console.log(`--- ACL Log ${i + 1} ---`);
    console.log("Topic 0:", log.topics[0]);
    
    if (log.topics[0] === ALLOWED_TOPIC || log.topics[0].startsWith("0x56ae23e5")) {
      console.log("Type: Allowed (allow/allowThis)");
      if (log.topics.length > 1) {
        console.log("Handle:", log.topics[1]);
      }
      if (log.topics.length > 2) {
        console.log("Address:", "0x" + log.topics[2]?.slice(-40));
      }
    } else if (log.topics[0] === ALLOWED_FOR_DECRYPTION_TOPIC || log.topics[0].startsWith("0x")) {
      console.log("Type: AllowedForDecryption (makePubliclyDecryptable)");
      console.log("Data:", log.data.slice(0, 200) + "...");
    } else {
      console.log("Type: Unknown");
    }
    console.log("");
  }
  
  // Also get the withdrawal request handles for comparison
  const vault = await ethers.getContractAt("NoctisVault", VAULT_ADDRESS, signer);
  const request = await vault.withdrawalRequests(6);
  
  const amountHandle = ethers.zeroPadValue(ethers.toBeHex(request.encryptedAmount), 32);
  const balanceHandle = ethers.zeroPadValue(ethers.toBeHex(request.originalBalance), 32);
  
  console.log("=".repeat(60));
  console.log("Expected handles:");
  console.log("  Amount:", amountHandle);
  console.log("  Balance:", balanceHandle);
  console.log("=".repeat(60));
  
  // Check if the balance handle appears in any of the ACL logs
  console.log("");
  console.log("Checking if balance handle appears in ACL logs...");
  const balanceInLogs = aclLogs.some(log => 
    log.topics.includes(balanceHandle) || 
    log.data.toLowerCase().includes(balanceHandle.slice(2).toLowerCase())
  );
  console.log("Balance handle in logs:", balanceInLogs);
  
  const amountInLogs = aclLogs.some(log => 
    log.topics.includes(amountHandle) || 
    log.data.toLowerCase().includes(amountHandle.slice(2).toLowerCase())
  );
  console.log("Amount handle in logs:", amountInLogs);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
