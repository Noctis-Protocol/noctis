import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Adding keeper:", deployer.address);
  
  // Get ABI from artifacts
  const abi = (await import("../artifacts/contracts/NoctisExchange.sol/NoctisExchange.json")).abi;
  const exchange = new ethers.Contract("0x0d9A9a414b0cc6dD9F6BFD957921e6402CAD2589", abi, deployer);
  
  // Encode function call
  const data = exchange.interface.encodeFunctionData("addKeeper", [deployer.address]);
  console.log("Encoded data:", data);
  
  const tx = await deployer.sendTransaction({
    to: "0x0d9A9a414b0cc6dD9F6BFD957921e6402CAD2589",
    data: data,
    gasLimit: 200000,
  });
  const receipt = await tx.wait();
  console.log("✅ Keeper added, tx:", receipt?.hash);
}

main().catch(console.error);
