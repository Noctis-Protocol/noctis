/**
 * Fix ACL Script
 * 
 * Attempts to manually call makePubliclyDecryptable on the originalBalance handle
 * to fix the decryption issue.
 */

import { ethers } from "hardhat";

const VAULT_ADDRESS = "0xD888774Be1d28aE3668be232eE412a62E99685FD";
const ACL_ADDRESS = "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D";

const ACL_ABI = [
  "function isAllowedForDecryption(bytes32 handle) external view returns (bool)",
  "function allowForDecryption(bytes32[] calldata handles) external",
  "function isAllowed(bytes32 handle, address account) external view returns (bool)"
];

async function main() {
  const requestId = parseInt(process.argv[2] || "6");
  
  console.log("=".repeat(60));
  console.log("Attempting to fix ACL for Withdrawal Request", requestId);
  console.log("=".repeat(60));
  
  const [signer] = await ethers.getSigners();
  console.log("Signer:", signer.address);
  
  // Get the Vault contract
  const vault = await ethers.getContractAt("NoctisVault", VAULT_ADDRESS, signer);
  const acl = new ethers.Contract(ACL_ADDRESS, ACL_ABI, signer);
  
  // Get withdrawal request
  const request = await vault.withdrawalRequests(requestId);
  console.log("Request ID:", request.requestId.toString());
  console.log("Gateway Requested:", request.gatewayRequested);
  console.log("");
  
  // Get handles in bytes32 format
  const balanceHandle = ethers.zeroPadValue(ethers.toBeHex(request.originalBalance), 32);
  console.log("Balance Handle:", balanceHandle);
  
  // Check current state
  const isDecryptable = await acl.isAllowedForDecryption(balanceHandle);
  console.log("Current isAllowedForDecryption:", isDecryptable);
  
  if (isDecryptable) {
    console.log("✅ Already allowed for decryption!");
    return;
  }
  
  // Check if vault has permission
  const vaultHasPermission = await acl.isAllowed(balanceHandle, VAULT_ADDRESS);
  console.log("Vault has ACL permission:", vaultHasPermission);
  
  if (!vaultHasPermission) {
    console.log("❌ Vault doesn't have permission on this handle!");
    console.log("Cannot fix without vault permission.");
    return;
  }
  
  // Try to call retryWithdrawalExecution to re-trigger makePubliclyDecryptable
  console.log("");
  console.log("🔄 Attempting to retry withdrawal execution...");
  
  try {
    // Check if we can retry (10 min timeout)
    const canRetry = await vault.canRetryWithdrawalExecution(requestId);
    console.log("Can retry:", canRetry);
    
    if (canRetry) {
      console.log("Calling retryWithdrawalExecution...");
      const tx = await vault.retryWithdrawalExecution(requestId);
      console.log("Transaction hash:", tx.hash);
      const receipt = await tx.wait();
      console.log("Transaction confirmed in block:", receipt?.blockNumber);
      
      // Check if it worked
      const isDecryptableNow = await acl.isAllowedForDecryption(balanceHandle);
      console.log("New isAllowedForDecryption:", isDecryptableNow);
    } else {
      console.log("Cannot retry yet - need to wait for 10 minute timeout");
      
      // Try calling requestWithdrawalExecution again (will fail if already requested)
      console.log("The makePubliclyDecryptable call likely failed in the original tx");
      console.log("Need to investigate why...");
    }
  } catch (e: any) {
    console.error("Error:", e.reason || e.message?.slice(0, 200));
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
