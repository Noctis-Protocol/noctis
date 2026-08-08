import { ethers } from "hardhat";

async function main() {
  const exchange = await ethers.getContractAt("NoctisExchange", "0xfa2587781915278a3D7230c3B31BbE49DcBC6De2");
  
  const orderId = 5n;
  const order = await exchange.orders(orderId);
  
  // The handle stored in contract
  const storedHandle = order.encryptedAmountETH;
  console.log("Stored encryptedAmountETH:", storedHandle);
  console.log("Type:", typeof storedHandle);
  
  // The swapExecutionRequestTime tells us when the request was made
  const swapRequestTime = await exchange.swapExecutionRequestTime(orderId);
  console.log("\nswapExecutionRequestTime:", swapRequestTime.toString());
  console.log("Timestamp:", new Date(Number(swapRequestTime) * 1000).toISOString());
  
  // Check block around that time (approximately 12s per block on Sepolia)
  const provider = ethers.provider;
  const currentBlock = await provider.getBlockNumber();
  console.log("Current block:", currentBlock);
  
  // Search recent blocks only
  const fromBlock = currentBlock - 500; // Last ~1.5 hours
  console.log("\nSearching events from block", fromBlock, "to", currentBlock);
  
  const filter = exchange.filters.SwapDecryptionReady(orderId);
  const events = await exchange.queryFilter(filter, fromBlock, currentBlock);
  
  if (events.length > 0) {
    const event = events[0];
    console.log("\n✅ SwapDecryptionReady event found:");
    console.log("  Block:", event.blockNumber);
    console.log("  TX:", event.transactionHash);
    console.log("  Handles from event:", event.args?.handles);
    
    // Compare
    const eventHandle = event.args?.handles[0];
    console.log("\nComparison:");
    console.log("  Event handle:", eventHandle);
    console.log("  Stored handle:", storedHandle);
    console.log("  Match?:", eventHandle === storedHandle);
    
    // Type check
    console.log("\nType check:");
    console.log("  Event handle type:", typeof eventHandle);
    console.log("  Stored handle type:", typeof storedHandle);
  } else {
    console.log("❌ No SwapDecryptionReady event found for order 5 in recent blocks");
  }
}

main().catch(console.error);
