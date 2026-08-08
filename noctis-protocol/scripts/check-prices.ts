import { ethers } from "hardhat";

async function main() {
  // Official Uniswap V2 on Sepolia
  const ROUTER = "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3";
  const WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
  const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
  
  const router = await ethers.getContractAt("IUniswapV2Router02", ROUTER);
  
  // Get price for 1 ETH
  const oneEth = ethers.parseEther("1");
  const amounts = await router.getAmountsOut(oneEth, [WETH, USDC]);
  
  console.log("Uniswap WETH/USDC price:");
  console.log("  1 ETH =", ethers.formatUnits(amounts[1], 6), "USDC");
  
  // Also check Chainlink for reference
  const priceFeed = await ethers.getContractAt(
    "AggregatorV3Interface",
    "0x694AA1769357215DE4FAC081bf1f309aDC325306"
  );
  const [, answer] = await priceFeed.latestRoundData();
  console.log("\nChainlink ETH/USD price:");
  console.log("  1 ETH =", Number(answer) / 1e8, "USD");
}

main().catch(console.error);
