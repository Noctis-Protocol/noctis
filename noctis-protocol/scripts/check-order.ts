import { ethers } from "hardhat";

async function main() {
  const exchange = await ethers.getContractAt("NoctisExchange", "0xfa2587781915278a3D7230c3B31BbE49DcBC6De2");
  
  const order = await exchange.orders(5);
  console.log("Order 5:");
  console.log("  orderId:", order.orderId.toString());
  console.log("  plaintextTrader:", order.plaintextTrader);
  console.log("  status:", order.status);
  console.log("  encryptedAmountETH:", order.encryptedAmountETH);
  
  const swapRequested = await exchange.swapExecutionRequested(5);
  console.log("  swapExecutionRequested:", swapRequested);
  
  const swapRequestTime = await exchange.swapExecutionRequestTime(5);
  console.log("  swapExecutionRequestTime:", swapRequestTime.toString());
  console.log("  current time:", Math.floor(Date.now()/1000));
  
  // Check SWAP_EXECUTION_TIMEOUT
  const timeout = await exchange.SWAP_EXECUTION_TIMEOUT();
  console.log("  SWAP_EXECUTION_TIMEOUT:", timeout.toString(), "seconds");
}

main().catch(console.error);
