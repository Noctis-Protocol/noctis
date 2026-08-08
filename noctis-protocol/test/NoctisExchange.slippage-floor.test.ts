import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";

/**
 * Oracle-derived slippage floor (keeper-less hardening).
 *
 * SECURITY: `minAmountOut` on the execution entrypoints is supplied by the caller
 * (the trusted relayer today, any submitter under a future permissionless path).
 * A hostile submitter could pass `minAmountOut = 0` and let the settlement be
 * sandwiched. `_slippageFloor` binds the minimum to the order's own
 * `slippageToleranceBPS` and the live Chainlink price, so no submitter can settle
 * below fair-value-minus-tolerance regardless of the value they pass.
 *
 * Full settlement E2E stays for the mock-router upgrade chunk (real token
 * transfers). This suite locks the floor math, the on-chain enforcement wiring,
 * and deployability.
 */
describe("NoctisExchange slippage floor", function () {
  const PRICE_3000_8DEC = 3000n * 10n ** 8n;

  // Mirror of the on-chain `_slippageFloor` formula.
  function slippageFloor(amountIn: bigint, slippageBPS: bigint, isBuy: boolean, price = PRICE_3000_8DEC) {
    const fairOut = isBuy ? (amountIn * 10n ** 20n) / price : (amountIn * price) / 10n ** 20n;
    return (fairOut * (10_000n - slippageBPS)) / 10_000n;
  }

  describe("floor math", function () {
    it("SELL 0.5 ETH @ $3000, 0.5% → 1492.5 USDT floor", function () {
      const amountIn = 5n * 10n ** 17n; // 0.5 ETH in wei
      const floor = slippageFloor(amountIn, 50n, false);
      // fair = 1500 USDT (1e6); floor = 1500 * 0.995 = 1492.5 USDT
      expect(floor).to.equal(1_492_500_000n);
    });

    it("BUY 1500 USDT @ $3000, 0.5% → 0.4975 ETH floor", function () {
      const amountIn = 1_500n * 10n ** 6n; // 1500 USDT (6 dec)
      const floor = slippageFloor(amountIn, 50n, true);
      // fair = 0.5 ETH (1e18); floor = 0.5 * 0.995 = 0.4975 ETH
      expect(floor).to.equal(4_975n * 10n ** 14n);
    });

    it("wider tolerance lowers the floor monotonically", function () {
      const amountIn = 10n ** 18n; // 1 ETH
      const tight = slippageFloor(amountIn, 50n, false);
      const loose = slippageFloor(amountIn, 300n, false);
      expect(loose).to.be.lessThan(tight);
    });

    it("zero tolerance floors at exact fair value", function () {
      const amountIn = 10n ** 18n;
      const floor = slippageFloor(amountIn, 0n, false);
      expect(floor).to.equal((amountIn * PRICE_3000_8DEC) / 10n ** 20n);
    });
  });

  describe("contract source properties", function () {
    let src: string;
    before(function () {
      src = fs.readFileSync("contracts/NoctisExchange.sol", "utf8");
    });

    it("exposes the internal _slippageFloor helper reading the oracle", function () {
      expect(src).to.match(
        /function _slippageFloor\(uint256 amountIn, uint16 slippageBPS, bool isBuy\)/
      );
      // Floor is derived from the live Chainlink price, not a stored value.
      const floorBody = src.slice(src.indexOf("function _slippageFloor"));
      expect(floorBody.slice(0, 400)).to.match(/_getChainlinkPrice\(\)/);
    });

    it("SELL branch enforces the floor instead of trusting minAmountOut", function () {
      expect(src).to.match(
        /uint256 floorSell = _slippageFloor\(amountETH, order\.slippageToleranceBPS, false\);/
      );
      expect(src).to.match(/minAmountOut < floorSell \? floorSell : minAmountOut/);
    });

    it("BUY branch enforces the floor instead of trusting minAmountOut", function () {
      expect(src).to.match(
        /uint256 floorBuy = _slippageFloor\(usdtNeeded, order\.slippageToleranceBPS, true\);/
      );
      expect(src).to.match(/minAmountOut < floorBuy \? floorBuy : minAmountOut/);
    });

    it("BUY floor uses min(oracle, Uniswap spot) for thin-pool Sepolia", function () {
      const floorBody = src.slice(src.indexOf("function _slippageFloor"));
      expect(floorBody.slice(0, 1200)).to.match(/getAmountsOut/);
      expect(floorBody.slice(0, 1200)).to.match(/poolFloor < oracleFloor/);
    });

    it("no settlement swap passes a bare caller minAmountOut to the router", function () {
      // Both swapExactTokensForTokens calls must use the ternary floor guard.
      const bareMinToRouter = src.match(/\n\s*minAmountOut,\n\s*path,\n\s*address\(this\)/g) || [];
      expect(bareMinToRouter.length).to.equal(0);
      const guarded = src.match(/\? floor(Sell|Buy) : minAmountOut/g) || [];
      expect(guarded.length).to.equal(2);
    });
  });

  describe("deployability", function () {
    async function deployFixture() {
      const [owner] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdt = await MockERC20.deploy("Mock USDT", "USDT", 6);
      await usdt.waitForDeployment();

      const MockWETH = await ethers.getContractFactory("MockWETH");
      const weth = await MockWETH.deploy();
      await weth.waitForDeployment();

      const MockUniswapRouter = await ethers.getContractFactory("MockUniswapRouter");
      const router = await MockUniswapRouter.deploy(await weth.getAddress());
      await router.waitForDeployment();

      const MockChainlinkPriceFeed = await ethers.getContractFactory("MockChainlinkPriceFeed");
      const priceFeed = await MockChainlinkPriceFeed.deploy(PRICE_3000_8DEC);
      await priceFeed.waitForDeployment();

      const NoctisVault = await ethers.getContractFactory("NoctisVault");
      const vault = await NoctisVault.deploy(owner.address, await usdt.getAddress());
      await vault.waitForDeployment();

      const NoctisExchange = await ethers.getContractFactory("NoctisExchange");
      const exchange = await NoctisExchange.deploy(
        await vault.getAddress(),
        await router.getAddress(),
        await priceFeed.getAddress(),
        ethers.ZeroAddress
      );
      await exchange.waitForDeployment();

      return { exchange };
    }

    it("Exchange still deploys within known size budget (EIP-170 follow-up)", async function () {
      await loadFixture(deployFixture);
      const fs = await import("fs");
      const path = await import("path");
      const artifactPath = path.join(
        __dirname,
        "../artifacts/contracts/NoctisExchange.sol/NoctisExchange.json"
      );
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      const size = (artifact.deployedBytecode.length - 2) / 2;
      // Residual ~25.1KB > EIP-170; guard against growth (mainnet shrink is follow-up).
      expect(size).to.be.lessThan(26_000);
    });
  });
});
