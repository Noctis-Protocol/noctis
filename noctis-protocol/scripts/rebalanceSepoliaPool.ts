/**
 * @notice C6 — Rebalance Sepolia Uniswap V2 WETH/USDC toward Chainlink.
 * @dev Pool is often USDC-heavy (implied ETH price >> oracle), which makes BUY
 *      fills tiny. Selling ETH into the pool increases ETH reserves / burns USDC
 *      from the AMM and pulls spot toward oracle.
 *
 * Env:
 *   ETH_TO_SELL   — ETH to sell into the pool (default 1.5)
 *   TARGET_GAP_BPS — stop early if |spot-oracle|/oracle ≤ this (default 1500 = 15%)
 *   DRY_RUN=1     — quotes only
 *
 * Usage:
 *   SKIP_FHEVM=1 npx hardhat run scripts/rebalanceSepoliaPool.ts --network sepolia
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 11155111n) {
    throw new Error(`Sepolia only, got ${network.chainId}`);
  }

  const ssot = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "sepolia.json"), "utf8")
  );
  const routerAddr = ssot.contracts.UniswapV2Router as string;
  const usdcAddr = ssot.contracts.USDT as string;
  const feedAddr = ssot.contracts.EthUsdPriceFeed as string;

  const [signer] = await ethers.getSigners();
  const ethToSell = ethers.parseEther(process.env.ETH_TO_SELL || "1.5");
  const targetGapBps = BigInt(process.env.TARGET_GAP_BPS || "1500");
  const dry = process.env.DRY_RUN === "1";

  const router = await ethers.getContractAt(
    [
      "function WETH() view returns (address)",
      "function factory() view returns (address)",
      "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)",
      "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
    ],
    routerAddr
  );
  const weth: string = await router.WETH();
  const factoryAddr: string = await router.factory();
  const factory = new ethers.Contract(
    factoryAddr,
    ["function getPair(address,address) view returns (address)"],
    ethers.provider
  );
  const pairAddr: string = await factory.getPair(weth, usdcAddr);
  if (pairAddr === ethers.ZeroAddress) throw new Error("No WETH/USDC pair");

  const pair = new ethers.Contract(
    pairAddr,
    [
      "function getReserves() view returns (uint112,uint112,uint32)",
      "function token0() view returns (address)",
    ],
    ethers.provider
  );
  const feed = new ethers.Contract(
    feedAddr,
    [
      "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
    ],
    ethers.provider
  );

  async function spotAndOracle() {
    const [r0, r1] = await pair.getReserves();
    const t0: string = await pair.token0();
    const wethIs0 = t0.toLowerCase() === weth.toLowerCase();
    const ethR = wethIs0 ? r0 : r1;
    const usdR = wethIs0 ? r1 : r0;
    const spot = (Number(usdR) / 1e6) / Number(ethers.formatEther(ethR));
    const oracle = Number((await feed.latestRoundData())[1]) / 1e8;
    const gapBps = Math.abs((spot / oracle - 1) * 10000);
    return { ethR, usdR, spot, oracle, gapBps };
  }

  let state = await spotAndOracle();
  console.log("Signer:", signer.address);
  console.log("Pair:", pairAddr);
  console.log(
    `Before: ETH=${ethers.formatEther(state.ethR)} USDC=${Number(state.usdR) / 1e6} spot=$${state.spot.toFixed(2)} oracle=$${state.oracle.toFixed(2)} gap=${state.gapBps.toFixed(0)}bps`
  );

  if (state.gapBps <= Number(targetGapBps)) {
    console.log("✅ Already within target gap — nothing to do");
    return;
  }

  if (state.spot <= state.oracle) {
    console.log(
      "Spot ≤ oracle (ETH cheap on pool). This script sells ETH to raise spot; skip or invert manually."
    );
    return;
  }

  const bal = await ethers.provider.getBalance(signer.address);
  if (bal < ethToSell + ethers.parseEther("0.05")) {
    throw new Error(`Need ~${ethers.formatEther(ethToSell)} ETH + gas, have ${ethers.formatEther(bal)}`);
  }

  const pathTokens = [weth, usdcAddr];
  const quoted = await router.getAmountsOut(ethToSell, pathTokens);
  const minOut = (quoted[1] * 9500n) / 10000n; // 5% slip on rebalance
  console.log(
    `Sell ${ethers.formatEther(ethToSell)} ETH → ~${Number(quoted[1]) / 1e6} USDC (min ${Number(minOut) / 1e6})`
  );

  if (dry) {
    console.log("DRY_RUN=1 — not sending");
    return;
  }

  const deadline = Math.floor(Date.now() / 1000) + 600;
  const tx = await router.swapExactETHForTokens(
    minOut,
    pathTokens,
    signer.address,
    deadline,
    { value: ethToSell, gasLimit: 400_000n }
  );
  console.log("tx", tx.hash);
  await tx.wait();

  state = await spotAndOracle();
  console.log(
    `After:  ETH=${ethers.formatEther(state.ethR)} USDC=${Number(state.usdR) / 1e6} spot=$${state.spot.toFixed(2)} oracle=$${state.oracle.toFixed(2)} gap=${state.gapBps.toFixed(0)}bps`
  );

  // Record in SSOT ops
  const ssotPath = path.join(__dirname, "..", "deployments", "sepolia.json");
  const fresh = JSON.parse(fs.readFileSync(ssotPath, "utf8"));
  fresh.ops = {
    ...(fresh.ops || {}),
    lastPoolRebalanceAt: new Date().toISOString(),
    lastPoolRebalanceTx: tx.hash,
    lastPoolRebalanceEthSold: ethers.formatEther(ethToSell),
    lastPoolSpotUsd: Number(state.spot.toFixed(2)),
    lastPoolOracleUsd: Number(state.oracle.toFixed(2)),
    lastPoolGapBps: Math.round(state.gapBps),
  };
  fs.writeFileSync(ssotPath, JSON.stringify(fresh, null, 2) + "\n");
  console.log("SSOT ops updated");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
