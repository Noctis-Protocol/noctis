import { ethers } from "hardhat";

/**
 * Read-only V2 status check: roles, registries, deployer balances, pool reserves.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const ssot = require("../deployments/sepolia.v2.json");
  const c = ssot.contracts;

  const vault = await ethers.getContractAt("NoctisVaultV2", c.NoctisVaultV2);
  const exchange = await ethers.getContractAt("NoctisExchangeV2", c.NoctisExchangeV2);

  const RELAYER = "0xB63063402eD60d4630bc575dEC5458CDB94d16D6";
  const relayerRole = await exchange.RELAYER_ROLE();
  const paramsRole = await exchange.PARAMS_ROLE();

  console.log("deployer:", deployer.address);
  console.log("deployer ETH:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  const usdc = await ethers.getContractAt("IERC20", c.USDC);
  console.log("deployer USDC:", ethers.formatUnits(await usdc.balanceOf(deployer.address), 6));

  console.log("vault owner:", await vault.owner());
  console.log("vault supported tokens:", await vault.getSupportedTokens());
  console.log("exchange tradable tokens:", await exchange.getTradableTokens());
  console.log("relayer has RELAYER_ROLE:", await exchange.hasRole(relayerRole, RELAYER));
  console.log("deployer has PARAMS_ROLE:", await exchange.hasRole(paramsRole, deployer.address));
  console.log("deployer has DEFAULT_ADMIN:", await exchange.hasRole(await exchange.DEFAULT_ADMIN_ROLE(), deployer.address));
  console.log("feeRecipient:", await exchange.feeRecipient());
  console.log("gasRecipient:", await exchange.gasRecipient());
  console.log("timelockConfigured:", await exchange.timelockConfigured());
  console.log("WETH:", await exchange.WETH());

  // WETH/USDC pool reserves via factory
  const router = await ethers.getContractAt("IUniswapV2Router02", c.UniswapV2Router);
  const factoryAddr = await router.factory();
  const factory = new ethers.Contract(
    factoryAddr,
    ["function getPair(address,address) view returns (address)"],
    ethers.provider
  );
  const weth = await exchange.WETH();
  const pairAddr = await factory.getPair(weth, c.USDC);
  console.log("WETH/USDC pair:", pairAddr);
  if (pairAddr !== ethers.ZeroAddress) {
    const pair = new ethers.Contract(
      pairAddr,
      [
        "function getReserves() view returns (uint112,uint112,uint32)",
        "function token0() view returns (address)",
      ],
      ethers.provider
    );
    const [r0, r1] = await pair.getReserves();
    const t0 = await pair.token0();
    const [rWeth, rUsdc] = t0.toLowerCase() === weth.toLowerCase() ? [r0, r1] : [r1, r0];
    console.log("pool WETH:", ethers.formatEther(rWeth), "USDC:", ethers.formatUnits(rUsdc, 6));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
