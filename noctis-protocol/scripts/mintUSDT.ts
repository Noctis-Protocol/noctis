/**
 * Mint MockUSDT tokens for testing
 * Usage: npx hardhat run scripts/mintUSDT.ts --network sepolia
 */

import { ethers, network } from "hardhat";

async function main() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("💰 Minting MockUSDT");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (network.name !== "sepolia") {
    console.error("❌ This script is for Sepolia only!");
    process.exit(1);
  }

  const [signer] = await ethers.getSigners();
  console.log(`Signer: ${signer.address}\n`);

  // Get USDT address
  const usdtAddress = process.env.USDT_ADDRESS;
  if (!usdtAddress) {
    console.error("❌ USDT_ADDRESS not set in .env!");
    console.log("Run: npx hardhat run scripts/deployMockUSDT.ts --network sepolia");
    process.exit(1);
  }

  console.log(`MockUSDT: ${usdtAddress}\n`);

  // Connect to MockUSDT
  const MockUSDT_ABI = [
    "function balanceOf(address) external view returns (uint256)",
    "function mint(address to, uint256 amount) external",
    "function faucet() external",
    "function owner() external view returns (address)",
  ];

  const mockUSDT = new ethers.Contract(usdtAddress, MockUSDT_ABI, signer);

  // Check current balance
  const currentBalance = await mockUSDT.balanceOf(signer.address);
  console.log(`Current balance: ${ethers.formatUnits(currentBalance, 6)} USDT`);

  // Get owner
  const owner = await mockUSDT.owner();
  console.log(`Contract owner: ${owner}\n`);

  // Amount to mint
  const MINT_AMOUNT = ethers.parseUnits("50000", 6); // 50,000 USDT

  if (signer.address.toLowerCase() === owner.toLowerCase()) {
    // We are owner, can mint directly
    console.log(`Minting ${ethers.formatUnits(MINT_AMOUNT, 6)} USDT...`);

    const mintTx = await mockUSDT.mint(signer.address, MINT_AMOUNT);
    console.log(`Transaction: ${mintTx.hash}`);
    await mintTx.wait();

    console.log("✅ Minted successfully!\n");
  } else {
    // Not owner, use faucet (1000 USDT)
    console.log("Using faucet (1000 USDT per day)...");

    const faucetTx = await mockUSDT.faucet();
    console.log(`Transaction: ${faucetTx.hash}`);
    await faucetTx.wait();

    console.log("✅ Claimed from faucet!\n");
  }

  // Check new balance
  const newBalance = await mockUSDT.balanceOf(signer.address);
  console.log(`New balance: ${ethers.formatUnits(newBalance, 6)} USDT`);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("✅ MINT COMPLETE");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Balance: ${ethers.formatUnits(newBalance, 6)} USDT`);
  console.log("\nNext: Add liquidity to Uniswap");
  console.log("npx hardhat run scripts/addUniswapLiquidity.ts --network sepolia");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
