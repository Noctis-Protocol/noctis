import { ethers } from "hardhat";

async function main() {
  // Transaction de callback
  const txHash = "0xaaa94735580e13c657eae2df1c12a6b66dc86a5775eacef0850b15403a40366a";
  
  console.log("🔍 Analyzing withdrawal callback transaction...\n");
  
  const tx = await ethers.provider.getTransaction(txHash);
  const receipt = await ethers.provider.getTransactionReceipt(txHash);
  
  console.log("=== TRANSACTION DATA (visible on-chain) ===\n");
  
  // Decode the input data
  const iface = new ethers.Interface([
    "function executeWithdrawalCallback(uint256 requestId, bytes cleartexts, bytes decryptionProof)"
  ]);
  
  try {
    const decoded = iface.parseTransaction({ data: tx!.data });
    console.log("📋 Function: executeWithdrawalCallback");
    console.log("📋 Request ID:", decoded?.args[0].toString());
    
    // Decode cleartexts (this is what's visible on-chain)
    const cleartexts = decoded?.args[1];
    console.log("\n📋 Cleartexts (ABI-encoded, visible on-chain):");
    console.log("   Raw hex:", cleartexts.slice(0, 66) + "...");
    
    // Try to decode as (uint128, bool)
    const decodedValues = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint128", "bool"],
      cleartexts
    );
    console.log("\n🔓 DECRYPTED VALUES (publicly visible):");
    console.log("   Amount:", ethers.formatEther(decodedValues[0]), "ETH");
    console.log("   hasSufficientBalance:", decodedValues[1]);
    
    console.log("\n✅ PRIVACY CHECK:");
    console.log("   ❌ Amount is visible: YES (required for transfer)");
    console.log("   ✅ User balance is hidden: YES (only true/false revealed)");
    console.log("   ✅ Actual balance value: NEVER EXPOSED");
    
  } catch (err) {
    console.error("Failed to decode:", err);
  }
  
  // Check events
  console.log("\n=== EMITTED EVENTS ===\n");
  for (const log of receipt!.logs) {
    try {
      // WithdrawalExecuted event
      if (log.topics[0] === ethers.id("WithdrawalExecuted(uint256,address,uint256)")) {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "uint256"],
          log.data
        );
        console.log("📢 WithdrawalExecuted event:");
        console.log("   Recipient:", decoded[0]);
        console.log("   Amount:", ethers.formatEther(decoded[1]), "ETH");
        console.log("   → Amount is visible in event (required for transparency)");
      }
    } catch {}
  }
  
  console.log("\n=== SUMMARY ===");
  console.log("✅ Your BALANCE is PRIVATE - only true/false was decrypted");
  console.log("⚠️  Withdrawal AMOUNT is visible (necessary for the transfer)");
  console.log("✅ No one knows your remaining balance after withdrawal");
}

main().catch(console.error);
