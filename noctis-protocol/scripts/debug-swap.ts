import { ethers } from "hardhat";

async function main() {
  const exchange = await ethers.getContractAt("NoctisExchange", "0xfa2587781915278a3D7230c3B31BbE49DcBC6De2");
  
  // Order 5 details
  const orderId = 5n;
  const order = await exchange.orders(orderId);
  
  console.log("=== Order 5 Analysis ===");
  console.log("encryptedAmountETH (euint128):", order.encryptedAmountETH);
  
  // The handle from the contract
  // In FHE.toBytes32(), it converts euint128 to bytes32
  // The euint128 type is 0x06 (last byte of handle suffix)
  const handleHex = order.encryptedAmountETH;
  console.log("\nHandle analysis:");
  console.log("  Full handle:", handleHex);
  console.log("  Last 2 bytes:", handleHex.slice(-4)); // Should show type suffix
  
  // Check what the frontend would send
  // The cleartexts for 0.01 ETH = 10000000000000000 = 0x002386f26fc10000
  const amountETH = 10000000000000000n; // 0.01 ETH
  
  // The SDK should encode as abi.encode(uint128)
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encodedAsUint128 = abiCoder.encode(["uint128"], [amountETH]);
  const encodedAsUint256 = abiCoder.encode(["uint256"], [amountETH]);
  
  console.log("\nABI Encoding comparison:");
  console.log("  abi.encode(uint128):", encodedAsUint128);
  console.log("  abi.encode(uint256):", encodedAsUint256);
  console.log("  Same?:", encodedAsUint128 === encodedAsUint256);
  
  // Decode to verify
  const decodedUint128 = abiCoder.decode(["uint128"], encodedAsUint128);
  console.log("  Decoded uint128:", decodedUint128[0].toString());
  
  // What the SDK should return based on handle type (euint128 -> uint128)
  console.log("\n=== Expected SDK behavior ===");
  console.log("Handle type: euint128 (0x06)");
  console.log("Expected abiEncodedClearValues: abi.encode(uint128(", amountETH.toString(), "))");
  console.log("Expected value:", encodedAsUint128);
  
  // The failed transaction used these cleartexts:
  const txCleartexts = "0x000000000000000000000000000000000000000000000000002386f26fc10000";
  console.log("\n=== Transaction cleartexts ===");
  console.log("TX cleartexts:", txCleartexts);
  console.log("Match abi.encode(uint128)?:", txCleartexts.toLowerCase() === encodedAsUint128.toLowerCase());
}

main().catch(console.error);
