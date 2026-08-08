/**
 * Add liquidity to Uniswap V3 WETH/USDT pool on Sepolia
 * Usage: npx hardhat run scripts/addUniswapLiquidity.ts --network sepolia
 */

import { ethers, network } from "hardhat";

// Uniswap V3 Sepolia addresses
const UNISWAP_V3_FACTORY = "0x0227628f3F023bb0B980b67D528571c95c6DaC1c";
const UNISWAP_V3_POSITION_MANAGER = "0x1238536071E1c677A632429e3655c799b22cDA52";
const WETH9 = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

// ABIs
const POSITION_MANAGER_ABI = [
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
];

async function main() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("💧 Adding Liquidity to Uniswap V3");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (network.name !== "sepolia") {
    console.error("❌ This script is for Sepolia only!");
    process.exit(1);
  }

  const [signer] = await ethers.getSigners();
  console.log(`Signer: ${signer.address}`);

  // Get USDT address from environment or prompt
  const usdtAddress = process.env.USDT_ADDRESS;
  if (!usdtAddress) {
    console.error("❌ USDT_ADDRESS not set in .env!");
    console.log("Run: npx hardhat run scripts/deployMockUSDT.ts --network sepolia");
    process.exit(1);
  }

  console.log(`\nToken Addresses:`);
  console.log(`WETH: ${WETH9}`);
  console.log(`USDT: ${usdtAddress}\n`);

  // Configuration
  const FEE_TIER = 3000; // 0.3% fee
  const ETH_AMOUNT = ethers.parseEther("5"); // 5 ETH
  const USDT_AMOUNT = ethers.parseUnits("17500", 6); // 17,500 USDT (price ~$3500/ETH)

  console.log(`Liquidity to add:`);
  console.log(`  ETH: ${ethers.formatEther(ETH_AMOUNT)} ETH`);
  console.log(`  USDT: ${ethers.formatUnits(USDT_AMOUNT, 6)} USDT`);
  console.log(`  Fee Tier: ${FEE_TIER / 10000}%\n`);

  // Connect to contracts
  const factory = new ethers.Contract(UNISWAP_V3_FACTORY, FACTORY_ABI, signer);
  const positionManager = new ethers.Contract(
    UNISWAP_V3_POSITION_MANAGER,
    POSITION_MANAGER_ABI,
    signer
  );
  const usdt = new ethers.Contract(usdtAddress, ERC20_ABI, signer);

  // Check balances
  console.log("Checking balances...");
  const ethBalance = await ethers.provider.getBalance(signer.address);
  const usdtBalance = await usdt.balanceOf(signer.address);

  console.log(`ETH balance: ${ethers.formatEther(ethBalance)} ETH`);
  console.log(`USDT balance: ${ethers.formatUnits(usdtBalance, 6)} USDT\n`);

  if (ethBalance < ETH_AMOUNT) {
    console.error(`❌ Insufficient ETH! Need ${ethers.formatEther(ETH_AMOUNT)} ETH`);
    process.exit(1);
  }

  if (usdtBalance < USDT_AMOUNT) {
    console.error(`❌ Insufficient USDT! Need ${ethers.formatUnits(USDT_AMOUNT, 6)} USDT`);
    console.log(`\nMint more USDT:`);
    console.log(`npx hardhat run scripts/mintUSDT.ts --network sepolia`);
    process.exit(1);
  }

  // Determine token order (Uniswap requires token0 < token1)
  const [token0, token1] = WETH9.toLowerCase() < usdtAddress.toLowerCase()
    ? [WETH9, usdtAddress]
    : [usdtAddress, WETH9];

  const isWETHToken0 = token0 === WETH9;

  console.log(`Token ordering:`);
  console.log(`  token0: ${token0} (${isWETHToken0 ? "WETH" : "USDT"})`);
  console.log(`  token1: ${token1} (${isWETHToken0 ? "USDT" : "WETH"})\n`);

  // Check if pool exists
  console.log("Checking if pool exists...");
  let poolAddress = await factory.getPool(token0, token1, FEE_TIER);

  if (poolAddress === ethers.ZeroAddress) {
    console.log("Pool doesn't exist, creating...");

    // Calculate initial price
    // Price = (USDT per ETH) = 3500
    // sqrtPriceX96 = sqrt(price) * 2^96
    // If WETH is token0: price = USDT/WETH = 3500
    // If USDT is token0: price = WETH/USDT = 1/3500

    let sqrtPriceX96: bigint;
    if (isWETHToken0) {
      // WETH/USDT pool, price = 3500 USDT per WETH
      // Adjust for decimals: (3500 * 10^6) / 10^18 = 0.0000035
      const priceRatio = (3500n * 10n ** 6n * 10n ** 18n) / 10n ** 18n;
      const sqrtPrice = sqrt(priceRatio);
      sqrtPriceX96 = (sqrtPrice * 2n ** 96n) / 10n ** 9n;
    } else {
      // USDT/WETH pool, price = 1/3500
      const priceRatio = (10n ** 18n * 10n ** 18n) / (3500n * 10n ** 6n);
      const sqrtPrice = sqrt(priceRatio);
      sqrtPriceX96 = (sqrtPrice * 2n ** 96n) / 10n ** 9n;
    }

    console.log(`Initial sqrtPriceX96: ${sqrtPriceX96.toString()}\n`);

    const createTx = await positionManager.createAndInitializePoolIfNecessary(
      token0,
      token1,
      FEE_TIER,
      sqrtPriceX96
    );
    await createTx.wait();

    poolAddress = await factory.getPool(token0, token1, FEE_TIER);
    console.log(`✅ Pool created: ${poolAddress}\n`);
  } else {
    console.log(`✅ Pool exists: ${poolAddress}\n`);
  }

  // Get pool info
  const pool = new ethers.Contract(poolAddress, POOL_ABI, signer);
  const [sqrtPriceX96, tick] = await pool.slot0();
  const liquidity = await pool.liquidity();

  console.log(`Pool state:`);
  console.log(`  sqrtPriceX96: ${sqrtPriceX96.toString()}`);
  console.log(`  Current tick: ${tick}`);
  console.log(`  Current liquidity: ${liquidity.toString()}\n`);

  // Approve tokens
  console.log("Approving tokens...");
  const approveTx = await usdt.approve(UNISWAP_V3_POSITION_MANAGER, USDT_AMOUNT);
  await approveTx.wait();
  console.log("✅ USDT approved\n");

  // Add liquidity
  console.log("Adding liquidity...");

  // Full range position (tick -887220 to 887220)
  const tickLower = -887220;
  const tickUpper = 887220;

  const amount0Desired = isWETHToken0 ? ETH_AMOUNT : USDT_AMOUNT;
  const amount1Desired = isWETHToken0 ? USDT_AMOUNT : ETH_AMOUNT;

  const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

  const params = {
    token0,
    token1,
    fee: FEE_TIER,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    amount0Min: 0, // Accept any amount (for testing)
    amount1Min: 0,
    recipient: signer.address,
    deadline,
  };

  const mintTx = await positionManager.mint(params, {
    value: ETH_AMOUNT, // Send ETH for WETH conversion
    gasLimit: 5000000,
  });

  console.log(`Transaction hash: ${mintTx.hash}`);
  const receipt = await mintTx.wait();

  console.log(`✅ Liquidity added!`);
  console.log(`Gas used: ${receipt?.gasUsed.toString()}\n`);

  // Get new pool state
  const newLiquidity = await pool.liquidity();
  console.log(`New pool liquidity: ${newLiquidity.toString()}`);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("✅ LIQUIDITY ADDED SUCCESSFULLY");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Pool: ${poolAddress}`);
  console.log(`Etherscan: https://sepolia.etherscan.io/address/${poolAddress}`);
  console.log(`\nYou can now test trades on:`);
  console.log(`https://app.uniswap.org/swap?chain=sepolia`);
  console.log("\nNext: Run your keeper and create test orders!");
}

// Integer square root helper
function sqrt(value: bigint): bigint {
  if (value < 0n) {
    throw new Error("Square root of negative number");
  }
  if (value < 2n) {
    return value;
  }

  let z = value;
  let x = value / 2n + 1n;
  while (x < z) {
    z = x;
    x = (value / x + x) / 2n;
  }
  return z;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
