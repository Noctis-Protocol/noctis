/**
 * Test New Withdrawal Script
 * 
 * Creates a new withdrawal request and checks if both handles are properly
 * marked for public decryption after requestWithdrawalExecution.
 */

import { ethers } from "hardhat";

const VAULT_ADDRESS = "0xD888774Be1d28aE3668be232eE412a62E99685FD";
const ACL_ADDRESS = "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D";

const ACL_ABI = [
  "function isAllowedForDecryption(bytes32 handle) external view returns (bool)",
  "function isAllowed(bytes32 handle, address account) external view returns (bool)"
];

async function main() {
  console.log("=".repeat(60));
  console.log("Testing New Withdrawal ACL Behavior");
  console.log("=".repeat(60));
  
  const [signer] = await ethers.getSigners();
  console.log("Signer:", signer.address);
  
  const vault = await ethers.getContractAt("NoctisVault", VAULT_ADDRESS, signer);
  const acl = new ethers.Contract(ACL_ADDRESS, ACL_ABI, signer);
  
  // Get current withdrawal counter
  const currentCounter = await vault.withdrawalCounter();
  console.log("Current withdrawal counter:", currentCounter.toString());
  
  // Check if we have any pending withdrawal requests we can test
  // Look for the latest request that hasn't been executed yet
  for (let i = Number(currentCounter); i >= Math.max(1, Number(currentCounter) - 5); i--) {
    console.log("");
    console.log(`--- Checking Withdrawal Request ${i} ---`);
    
    const request = await vault.withdrawalRequests(i);
    console.log("Executed:", request.executed);
    console.log("Gateway Requested:", request.gatewayRequested);
    
    if (!request.executed && request.gatewayRequested) {
      // Check ACL state
      const amountHandle = ethers.zeroPadValue(ethers.toBeHex(request.encryptedAmount), 32);
      const balanceHandle = ethers.zeroPadValue(ethers.toBeHex(request.originalBalance), 32);
      
      console.log("Amount Handle:", amountHandle.slice(0, 20) + "...");
      console.log("Balance Handle:", balanceHandle.slice(0, 20) + "...");
      
      const amountDecryptable = await acl.isAllowedForDecryption(amountHandle);
      const balanceDecryptable = await acl.isAllowedForDecryption(balanceHandle);
      
      console.log("Amount isAllowedForDecryption:", amountDecryptable);
      console.log("Balance isAllowedForDecryption:", balanceDecryptable);
      
      if (amountDecryptable && !balanceDecryptable) {
        console.log("");
        console.log("⚠️ BUG CONFIRMED: Amount is decryptable but Balance is not!");
        console.log("This appears to be a systematic issue with Zama's ACL.");
      } else if (amountDecryptable && balanceDecryptable) {
        console.log("");
        console.log("✅ Both handles are properly decryptable!");
      }
    }
  }
  
  console.log("");
  console.log("=".repeat(60));
  console.log("");
  console.log("WORKAROUND OPTIONS:");
  console.log("1. Simplify to single-handle flow (only decrypt amount)");
  console.log("2. Report bug to Zama and wait for fix");
  console.log("3. Use off-chain balance verification");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
