/**
 * Debug ACL State Script
 * 
 * Checks if a withdrawal request's handles are properly marked for public decryption
 * on the Zama ACL contract.
 */

import { ethers } from "hardhat";

const ACL_ADDRESS = "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D"; // Sepolia ACL
const VAULT_ADDRESS = "0xD888774Be1d28aE3668be232eE412a62E99685FD"; // Deployed vault on Sepolia

// ACL interface (minimal)
const ACL_ABI = [
  "function isAllowedForDecryption(bytes32 handle) external view returns (bool)",
  "function allowedForDecryption(bytes32 handle) external view returns (bool)",
  "function allowedTransient(address account, bytes32 handle) external view returns (bool)",
  "function persistedAllowedPairs(address account, bytes32 handle) external view returns (bool)"
];

// NoctisVault interface
const VAULT_ABI = [
  "function withdrawalRequests(uint256 requestId) external view returns (tuple(uint256 requestId, address requester, address plaintextRecipient, uint256 encryptedRecipient, uint256 encryptedAmount, uint256 originalBalance, bool isEth, uint256 requestTime, bool executed, uint256 gatewayRequestId, bool gatewayRequested, uint256 gatewayRequestTime))"
];

async function main() {
  const requestId = parseInt(process.argv[2] || "6");
  
  console.log("=".repeat(60));
  console.log("DEBUG: ACL State for Withdrawal Request", requestId);
  console.log("=".repeat(60));
  
  const [signer] = await ethers.getSigners();
  console.log("Signer:", signer.address);
  console.log("");
  
  // Connect to contracts
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);
  const acl = new ethers.Contract(ACL_ADDRESS, ACL_ABI, signer);
  
  console.log("Vault Address:", VAULT_ADDRESS);
  console.log("ACL Address:", ACL_ADDRESS);
  console.log("");
  
  // Get withdrawal request
  console.log("📦 Fetching withdrawal request...");
  const request = await vault.withdrawalRequests(requestId);
  
  console.log("Request ID:", request.requestId.toString());
  console.log("Requester:", request.requester);
  console.log("Gateway Requested:", request.gatewayRequested);
  console.log("Executed:", request.executed);
  console.log("");
  
  // Get handles
  const encryptedAmount = request.encryptedAmount;
  const originalBalance = request.originalBalance;
  
  console.log("🔐 Raw Handle Values (BigInt):");
  console.log("  encryptedAmount:", encryptedAmount.toString());
  console.log("  originalBalance:", originalBalance.toString());
  console.log("");
  
  // Convert to bytes32 format
  const amountHandle = ethers.zeroPadValue(ethers.toBeHex(encryptedAmount), 32);
  const balanceHandle = ethers.zeroPadValue(ethers.toBeHex(originalBalance), 32);
  
  console.log("📝 Handle Values (bytes32):");
  console.log("  amountHandle:", amountHandle);
  console.log("  balanceHandle:", balanceHandle);
  console.log("");
  
  // Check ACL permissions
  console.log("🔍 Checking ACL Permissions...");
  
  try {
    // Try isAllowedForDecryption
    const amountAllowed = await acl.isAllowedForDecryption(amountHandle);
    console.log("  isAllowedForDecryption(amount):", amountAllowed);
  } catch (e: any) {
    console.log("  isAllowedForDecryption not available:", e.message?.slice(0, 50));
  }
  
  try {
    // Try allowedForDecryption
    const amountAllowed = await acl.allowedForDecryption(amountHandle);
    console.log("  allowedForDecryption(amount):", amountAllowed);
  } catch (e: any) {
    console.log("  allowedForDecryption not available:", e.message?.slice(0, 50));
  }
  
  try {
    const balanceAllowed = await acl.isAllowedForDecryption(balanceHandle);
    console.log("  isAllowedForDecryption(balance):", balanceAllowed);
  } catch (e: any) {
    console.log("  isAllowedForDecryption(balance) not available:", e.message?.slice(0, 50));
  }
  
  // Check vault's permission on the handles
  try {
    const vaultAmountAllowed = await acl.persistedAllowedPairs(VAULT_ADDRESS, amountHandle);
    console.log("  Vault has permission on amount:", vaultAmountAllowed);
  } catch (e: any) {
    console.log("  persistedAllowedPairs not available:", e.message?.slice(0, 50));
  }
  
  // Try to check isAllowed for vault on both handles
  console.log("");
  console.log("🔍 Checking if Vault contract has ACL permission on handles...");
  const IACL_ABI = [
    "function isAllowed(bytes32 handle, address account) external view returns (bool)"
  ];
  const aclFull = new ethers.Contract(ACL_ADDRESS, IACL_ABI, signer);
  
  try {
    const vaultAllowedAmount = await aclFull.isAllowed(amountHandle, VAULT_ADDRESS);
    console.log("  Vault isAllowed on encryptedAmount:", vaultAllowedAmount);
  } catch (e: any) {
    console.log("  isAllowed(amount) error:", e.message?.slice(0, 80));
  }
  
  try {
    const vaultAllowedBalance = await aclFull.isAllowed(balanceHandle, VAULT_ADDRESS);
    console.log("  Vault isAllowed on originalBalance:", vaultAllowedBalance);
  } catch (e: any) {
    console.log("  isAllowed(balance) error:", e.message?.slice(0, 80));
  }
  
  console.log("");
  console.log("=".repeat(60));
  console.log("Summary:");
  console.log("- If isAllowedForDecryption returns FALSE, makePubliclyDecryptable() was NOT called");
  console.log("- Or it reverted (contract doesn't have permission on handle)");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
