/**
 * @file NoctisExchangeV2 multi-pair test suite (FHEVM v0.9 mock mode)
 * @description Full settlement E2E across pairs with different decimals, using
 * MockUniswapRouterV2 (real token transfers + per-hop rates):
 * - SELL WBTC/USDC (8 -> 6 decimals) with fee skim and vault settlement
 * - BUY WBTC/USDC via the two-leg sufficiency flow
 * - SELL LINK/USDC routed through WETH (3-hop path)
 * - Native ETH pair (WETH wrap/unwrap)
 * - Oracle price-deviation guard, pair registry, cancel + lock restore
 */

import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import * as hre from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  NoctisVaultV2,
  NoctisExchangeV2,
  MockERC20,
  MockUniswapRouterV2,
  MockChainlinkPriceFeed,
  MockWETH,
} from "../../typechain-types";

const NATIVE = ethers.ZeroAddress;
const PRICE_ETH = 3000n * 10n ** 8n;
const PRICE_WBTC = 60000n * 10n ** 8n;
const PRICE_LINK = 15n * 10n ** 8n;

describe("NoctisExchangeV2 - Multi-Pair Trading (Mock Mode)", function () {
  let vault: NoctisVaultV2;
  let exchange: NoctisExchangeV2;
  let usdc: MockERC20;
  let wbtc: MockERC20;
  let link: MockERC20;
  let weth: MockWETH;
  let router: MockUniswapRouterV2;
  let ethFeed: MockChainlinkPriceFeed;
  let wbtcFeed: MockChainlinkPriceFeed;
  let linkFeed: MockChainlinkPriceFeed;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  let vaultAddress: string;
  let exchangeAddress: string;
  let usdcAddress: string;
  let wbtcAddress: string;
  let linkAddress: string;

  const E18 = (n: number) => ethers.parseEther(n.toString());
  const E8 = (n: number) => BigInt(Math.round(n * 1e8));
  const E6 = (n: number) => BigInt(Math.round(n * 1e6));

  before(async function () {
    if (!hre.fhevm.isMock) {
      throw new Error("This test suite requires FHEVM mock mode (hardhat network)");
    }
  });

  beforeEach(async function () {
    [owner, user, attacker] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    usdc = (await MockERC20Factory.deploy("USD Coin", "USDC", 6)) as MockERC20;
    wbtc = (await MockERC20Factory.deploy("Wrapped BTC", "WBTC", 8)) as MockERC20;
    link = (await MockERC20Factory.deploy("Chainlink", "LINK", 18)) as MockERC20;
    usdcAddress = await usdc.getAddress();
    wbtcAddress = await wbtc.getAddress();
    linkAddress = await link.getAddress();

    const MockWETHFactory = await ethers.getContractFactory("MockWETH");
    weth = (await MockWETHFactory.deploy()) as MockWETH;
    const wethAddress = await weth.getAddress();

    const RouterFactory = await ethers.getContractFactory("MockUniswapRouterV2");
    router = (await RouterFactory.deploy(wethAddress)) as MockUniswapRouterV2;
    const routerAddress = await router.getAddress();

    const FeedFactory = await ethers.getContractFactory("MockChainlinkPriceFeed");
    ethFeed = (await FeedFactory.deploy(PRICE_ETH)) as MockChainlinkPriceFeed;
    wbtcFeed = (await FeedFactory.deploy(PRICE_WBTC)) as MockChainlinkPriceFeed;
    linkFeed = (await FeedFactory.deploy(PRICE_LINK)) as MockChainlinkPriceFeed;

    const VaultFactory = await ethers.getContractFactory("NoctisVaultV2");
    vault = (await VaultFactory.deploy(owner.address)) as NoctisVaultV2;
    vaultAddress = await vault.getAddress();

    // Vault registry: ETH, USDC, WBTC, LINK
    await vault.configureToken(NATIVE, 18, E18(0.005), E18(100), E18(100), E18(1000));
    await vault.configureToken(usdcAddress, 6, E6(1), E6(1_000_000), E6(1_000_000), E6(10_000_000));
    await vault.configureToken(wbtcAddress, 8, E8(0.0001), E8(100), E8(100), E8(1000));
    await vault.configureToken(linkAddress, 18, E18(1), E18(1_000_000), E18(1_000_000), E18(10_000_000));

    const ExchangeFactory = await ethers.getContractFactory("NoctisExchangeV2");
    exchange = (await ExchangeFactory.deploy(
      vaultAddress,
      routerAddress,
      usdcAddress,
      await ethFeed.getAddress(),
      ethers.ZeroAddress
    )) as NoctisExchangeV2;
    exchangeAddress = await exchange.getAddress();

    await vault.setExchange(exchangeAddress, true);
    await exchange.grantRole(await exchange.PARAMS_ROLE(), owner.address);

    // Pair registry: baseToken, feed, decimals, viaWeth, minOrder, maxOrder, minPrice, maxPrice
    await exchange.configureTradableToken(
      NATIVE, await ethFeed.getAddress(), 18, false,
      E18(0.001), E18(100), 100n * 10n ** 8n, 50000n * 10n ** 8n
    );
    await exchange.configureTradableToken(
      wbtcAddress, await wbtcFeed.getAddress(), 8, false,
      E8(0.0001), E8(100), 1000n * 10n ** 8n, 200000n * 10n ** 8n
    );
    await exchange.configureTradableToken(
      linkAddress, await linkFeed.getAddress(), 18, true, // routed via WETH
      E18(1), E18(1_000_000), 1n * 10n ** 8n, 1000n * 10n ** 8n
    );

    // Router rates ~0.33% below oracle-fair so 1% tolerance floors pass.
    // WBTC(8) -> USDC(6): fair = amount * 600 (60000e8 / 10^(8+2))
    await router.setRate(wbtcAddress, usdcAddress, 598, 1);
    // USDC(6) -> WBTC(8): fair = amount / 600
    await router.setRate(usdcAddress, wbtcAddress, 1, 602);
    // LINK(18) -> WETH(18): $15 / $3000 = 0.005
    await router.setRate(linkAddress, wethAddress, 5, 1000);
    // WETH(18) -> USDC(6): fair = amount * 3000 / 1e12
    await router.setRate(wethAddress, usdcAddress, 2990, 10n ** 12n);
    // USDC(6) -> WETH(18): fair = amount * 1e12 / 3000
    await router.setRate(usdcAddress, wethAddress, 10n ** 12n, 3010);

    // Fund the router with output-side liquidity
    await usdc.mint(routerAddress, E6(10_000_000));
    await wbtc.mint(routerAddress, E8(100));
    await weth.connect(owner).deposit({ value: E18(50) });
    await weth.connect(owner).transfer(routerAddress, E18(50));

    // Fund the user
    await wbtc.mint(user.address, E8(5));
    await link.mint(user.address, E18(10_000));
    await usdc.mint(user.address, E6(100_000));
  });

  // Helpers -------------------------------------------------------------------

  function parseEvent(receipt: any, name: string): any | null {
    for (const log of receipt.logs) {
      try {
        const parsed = exchange.interface.parseLog(log);
        if (parsed && parsed.name === name) return parsed.args;
      } catch {}
    }
    return null;
  }

  async function depositToVault(token: MockERC20, amount: bigint) {
    await token.connect(user).approve(vaultAddress, amount);
    await vault.connect(user).depositToken(await token.getAddress(), amount);
  }

  async function createOrder(
    baseToken: string,
    amount: bigint,
    isBuy: boolean,
    slipBPS = 100,
    devBPS = 150
  ): Promise<bigint> {
    const tx = await exchange.connect(user).createMarketOrder(baseToken, amount, isBuy, slipBPS, devBPS);
    const args = parseEvent(await tx.wait(), "OrderCreated");
    expect(args).to.not.be.null;
    return args.orderId;
  }

  async function requestExecution(orderId: bigint): Promise<string[]> {
    const tx = await exchange.connect(user).requestSwapExecution(orderId);
    const args = parseEvent(await tx.wait(), "SwapDecryptionReady");
    expect(args).to.not.be.null;
    return [...args.handles];
  }

  /** SELL: single-leg execution */
  async function executeSell(orderId: bigint, handles: string[]) {
    const dec = await fhevm.publicDecrypt(handles);
    const tx = await exchange
      .connect(user)
      .executeSwapCallback(orderId, dec.abiEncodedClearValues, dec.decryptionProof, 0);
    return tx.wait();
  }

  /** BUY: two legs (amount proof, then USDC sufficiency proof) */
  async function executeBuy(orderId: bigint, handles: string[]) {
    const amountDec = await fhevm.publicDecrypt(handles);
    const step1 = await exchange
      .connect(user)
      .executeSwapCallback(orderId, amountDec.abiEncodedClearValues, amountDec.decryptionProof, 0);
    const suffArgs = parseEvent(await step1.wait(), "BuySufficiencyReady");
    expect(suffArgs).to.not.be.null;

    const suffDec = await fhevm.publicDecrypt([suffArgs.sufficiencyHandle]);
    const step2 = await exchange
      .connect(user)
      .finalizeBuySwap(orderId, suffDec.abiEncodedClearValues, suffDec.decryptionProof, 0);
    return { receipt: await step2.wait(), usdcNeeded: suffArgs.usdcNeeded as bigint };
  }

  // Pair registry ---------------------------------------------------------------

  describe("pair registry", function () {
    it("rejects orders on unregistered tokens", async function () {
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const rogue = await MockERC20Factory.deploy("Rogue", "RGE", 18);
      await expect(
        exchange.connect(user).createMarketOrder(await rogue.getAddress(), E18(1), false, 100, 150)
      ).to.be.revertedWithCustomError(exchange, "TokenNotTradable");
    });

    it("rejects orders when a pair is disabled", async function () {
      await exchange.setTokenTradingEnabled(wbtcAddress, false);
      await expect(
        exchange.connect(user).createMarketOrder(wbtcAddress, E8(1), false, 100, 150)
      ).to.be.revertedWithCustomError(exchange, "TokenNotTradable");
    });

    it("enforces per-pair order size limits", async function () {
      await expect(
        exchange.connect(user).createMarketOrder(wbtcAddress, E8(0.00001), false, 100, 150)
      ).to.be.revertedWithCustomError(exchange, "BelowMinimumOrderSize");
      await expect(
        exchange.connect(user).createMarketOrder(wbtcAddress, E8(101), false, 100, 150)
      ).to.be.revertedWithCustomError(exchange, "ExceedsMaximumOrderSize");
    });

    it("registry management requires PARAMS_ROLE", async function () {
      // staticCall: the fhevm mock provider masks reverts surfaced via
      // eth_sendTransaction with an internal assertion; eth_call is unaffected
      await expect(
        exchange.connect(attacker).setTokenTradingEnabled.staticCall(wbtcAddress, false)
      ).to.be.revertedWithCustomError(exchange, "AccessControlUnauthorizedAccount");
    });

    it("validates slippage bounds at creation", async function () {
      await expect(
        exchange.connect(user).createMarketOrder(wbtcAddress, E8(1), false, 0, 150)
      ).to.be.revertedWithCustomError(exchange, "ZeroSlippageTolerance");
      await expect(
        exchange.connect(user).createMarketOrder(wbtcAddress, E8(1), false, 301, 150)
      ).to.be.revertedWithCustomError(exchange, "SlippageToleranceTooHigh");
    });
  });

  // SELL flows ------------------------------------------------------------------

  describe("SELL flows (base -> USDC)", function () {
    it("sells WBTC for USDC with full settlement (8 -> 6 decimals)", async function () {
      await depositToVault(wbtc, E8(1));

      const orderId = await createOrder(wbtcAddress, E8(0.5), false, 100);
      const handles = await requestExecution(orderId);
      expect(handles.length).to.equal(2); // amount + sufficiency

      const vaultUsdcBefore = await usdc.balanceOf(vaultAddress);
      const feeRecipientBefore = await usdc.balanceOf(owner.address);

      const receipt = await executeSell(orderId, handles);
      expect(parseEvent(receipt, "OrderFilledSimple")).to.not.be.null;

      // out = 0.5e8 * 598 = 29,900 USDC; fee 5 bps
      const grossOut = (E8(0.5) * 598n) / 1n;
      const fee = (grossOut * 5n) / 10_000n;
      const netOut = grossOut - fee;

      expect((await usdc.balanceOf(vaultAddress)) - vaultUsdcBefore).to.equal(netOut);
      expect((await usdc.balanceOf(owner.address)) - feeRecipientBefore).to.equal(fee);
      // 0.5 WBTC left the vault for the swap
      expect(await wbtc.balanceOf(vaultAddress)).to.equal(E8(0.5));

      const [exists, baseToken, isBuy, status] = await exchange.getOrderPublic(orderId);
      expect(exists).to.be.true;
      expect(baseToken).to.equal(wbtcAddress);
      expect(isBuy).to.be.false;
      expect(status).to.equal(2n); // Filled
    });

    it("sells LINK routed through WETH (3-hop path)", async function () {
      await depositToVault(link, E18(200));

      const orderId = await createOrder(linkAddress, E18(100), false, 100);
      const handles = await requestExecution(orderId);

      const vaultUsdcBefore = await usdc.balanceOf(vaultAddress);
      await executeSell(orderId, handles);

      // 100 LINK -> 0.5 WETH -> 1495 USDC; fee 5 bps
      const wethOut = (E18(100) * 5n) / 1000n;
      const grossOut = (wethOut * 2990n) / 10n ** 12n;
      const fee = (grossOut * 5n) / 10_000n;
      expect((await usdc.balanceOf(vaultAddress)) - vaultUsdcBefore).to.equal(grossOut - fee);
    });

    it("sells native ETH (wrap to WETH before the router)", async function () {
      await vault.connect(user).depositETH({ value: E18(1) });

      const orderId = await createOrder(NATIVE, E18(0.5), false, 100);
      const handles = await requestExecution(orderId);

      const vaultUsdcBefore = await usdc.balanceOf(vaultAddress);
      await executeSell(orderId, handles);

      const grossOut = (E18(0.5) * 2990n) / 10n ** 12n; // 1495 USDC
      const fee = (grossOut * 5n) / 10_000n;
      expect((await usdc.balanceOf(vaultAddress)) - vaultUsdcBefore).to.equal(grossOut - fee);
      // 0.5 ETH left the vault
      expect(await ethers.provider.getBalance(vaultAddress)).to.equal(E18(0.5));
    });

    it("rejects execution from a non-owner", async function () {
      await depositToVault(wbtc, E8(1));
      const orderId = await createOrder(wbtcAddress, E8(0.5), false, 100);
      const handles = await requestExecution(orderId);
      const dec = await fhevm.publicDecrypt(handles);

      await expect(
        exchange
          .connect(attacker)
          .executeSwapCallback(orderId, dec.abiEncodedClearValues, dec.decryptionProof, 0)
      ).to.be.revertedWithCustomError(exchange, "NotOrderOwner");
    });
  });

  // BUY flows -------------------------------------------------------------------

  describe("BUY flows (USDC -> base, two-leg sufficiency)", function () {
    it("buys WBTC with USDC end-to-end", async function () {
      await depositToVault(usdc, E6(35_000));

      const orderId = await createOrder(wbtcAddress, E8(0.5), true, 100, 0);
      const handles = await requestExecution(orderId);
      expect(handles.length).to.equal(1); // BUY: amount only at request time

      const vaultWbtcBefore = await wbtc.balanceOf(vaultAddress);
      const { usdcNeeded } = await executeBuy(orderId, handles);

      // usdcNeeded = 0.5 * $60,000 * 1.01 = 30,300 USDC
      expect(usdcNeeded).to.equal(((E8(0.5) * PRICE_WBTC) / 10n ** 10n) * 10100n / 10000n);

      const grossOut = usdcNeeded / 602n;
      const fee = (grossOut * 5n) / 10_000n;
      expect((await wbtc.balanceOf(vaultAddress)) - vaultWbtcBefore).to.equal(grossOut - fee);

      const [, , , status] = await exchange.getOrderPublic(orderId);
      expect(status).to.equal(2n); // Filled
    });

    it("buys native ETH (unwrap WETH, credit as value)", async function () {
      await depositToVault(usdc, E6(2_000));

      const orderId = await createOrder(NATIVE, E18(0.5), true, 100, 0);
      const handles = await requestExecution(orderId);

      const vaultEthBefore = await ethers.provider.getBalance(vaultAddress);
      const { usdcNeeded } = await executeBuy(orderId, handles);

      // usdcNeeded = 0.5 * $3000 * 1.01 = 1515 USDC
      expect(usdcNeeded).to.equal(E6(1515));

      const grossOut = (usdcNeeded * 10n ** 12n) / 3010n;
      const fee = (grossOut * 5n) / 10_000n;
      expect((await ethers.provider.getBalance(vaultAddress)) - vaultEthBefore).to.equal(grossOut - fee);
    });
  });

  // Oracle protections ------------------------------------------------------------

  describe("oracle protections", function () {
    it("blocks execution when the price deviates beyond the order's tolerance", async function () {
      await depositToVault(wbtc, E8(1));
      const orderId = await createOrder(wbtcAddress, E8(0.5), false, 100, 100); // 1% max deviation
      const handles = await requestExecution(orderId);
      const dec = await fhevm.publicDecrypt(handles);

      // +1.67% move
      await wbtcFeed.setPrice(61000n * 10n ** 8n);

      await expect(
        exchange
          .connect(user)
          .executeSwapCallback(orderId, dec.abiEncodedClearValues, dec.decryptionProof, 0)
      ).to.be.revertedWithCustomError(exchange, "PriceDeviationExceeded");
    });

    it("enforces per-token price circuit-breaker bounds", async function () {
      await wbtcFeed.setPrice(500n * 10n ** 8n); // below minPriceUsd (1000)
      await expect(
        exchange.connect(user).createMarketOrder(wbtcAddress, E8(0.5), false, 100, 150)
      ).to.be.revertedWithCustomError(exchange, "PriceOutOfBounds");
    });
  });

  // Gas refund split --------------------------------------------------------------
  // Fee goes to the treasury (feeRecipient) while the gas-in-kind refund goes to
  // the relayer float wallet (gasRecipient) — the relayer self-funds without a
  // Safe -> keeper round-trip.

  describe("gas refund split (fee -> treasury, refund -> gasRecipient)", function () {
    const GAS_REFUND_WEI = ethers.parseEther("0.001"); // signed off-chain by the user

    it("SELL via relayer: refund converted to USDC lands on gasRecipient, fee on feeRecipient", async function () {
      const [, , , treasury, gasWallet] = await ethers.getSigners();
      await exchange.setFeeRecipient(treasury.address);
      await exchange.setGasRecipient(gasWallet.address);
      await exchange.grantRole(await exchange.RELAYER_ROLE(), owner.address);

      await depositToVault(wbtc, E8(1));
      const vaultId = await vault.connect(user).getMyVaultId();

      const tx = await exchange.createMarketOrderViaRelayer(
        vaultId, wbtcAddress, E8(0.5), false, 100, 150, GAS_REFUND_WEI
      );
      const orderId = parseEvent(await tx.wait(), "OrderCreated").orderId;

      const handles = await requestExecution(orderId);
      const receipt = await executeSell(orderId, handles);
      expect(parseEvent(receipt, "OrderFilledSimple")).to.not.be.null;

      // out = 0.5e8 * 598 = 29,900 USDC; fee 5 bps; refund 0.001 ETH * $3000 = 3 USDC
      const grossOut = E8(0.5) * 598n;
      const fee = (grossOut * 5n) / 10_000n;
      const refundUsdc = (GAS_REFUND_WEI * PRICE_ETH) / 10n ** 20n;
      expect(refundUsdc).to.equal(E6(3));

      expect(await usdc.balanceOf(treasury.address)).to.equal(fee);
      expect(await usdc.balanceOf(gasWallet.address)).to.equal(refundUsdc);
      expect(await usdc.balanceOf(vaultAddress)).to.equal(grossOut - fee - refundUsdc);

      const refundArgs = parseEvent(receipt, "GasRefundCollected");
      expect(refundArgs.token).to.equal(usdcAddress);
      expect(refundArgs.refundAmount).to.equal(refundUsdc);
    });

    it("BUY via relayer: refund converted to base units lands on gasRecipient", async function () {
      const [, , , treasury, gasWallet] = await ethers.getSigners();
      await exchange.setFeeRecipient(treasury.address);
      await exchange.setGasRecipient(gasWallet.address);
      await exchange.grantRole(await exchange.RELAYER_ROLE(), owner.address);

      await depositToVault(usdc, E6(50_000));
      const vaultId = await vault.connect(user).getMyVaultId();

      const tx = await exchange.createMarketOrderViaRelayer(
        vaultId, wbtcAddress, E8(0.5), true, 100, 150, GAS_REFUND_WEI
      );
      const orderId = parseEvent(await tx.wait(), "OrderCreated").orderId;

      const handles = await requestExecution(orderId);
      await executeBuy(orderId, handles);

      // refund in WBTC: wei * ethUsd * 10^8 / (wbtcUsd * 1e18)
      const refundWbtc = (GAS_REFUND_WEI * PRICE_ETH * 10n ** 8n) / (PRICE_WBTC * 10n ** 18n);
      expect(refundWbtc).to.equal(5000n); // 0.00005 WBTC

      expect(await wbtc.balanceOf(gasWallet.address)).to.equal(refundWbtc);
      expect(await wbtc.balanceOf(treasury.address)).to.be.gt(0n); // fee in WBTC
    });

    it("setGasRecipient is PARAMS_ROLE/timelock gated and rejects the zero address", async function () {
      await expect(
        exchange.connect(attacker).setGasRecipient.staticCall(attacker.address)
      ).to.be.reverted;
      await expect(
        exchange.setGasRecipient.staticCall(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(exchange, "InvalidFeeRecipient");
    });
  });

  // Cancellation --------------------------------------------------------------------

  describe("cancellation and lock restore", function () {
    it("cancelSwapExecution restores the vault lock (SELL)", async function () {
      await depositToVault(wbtc, E8(1));
      const orderId = await createOrder(wbtcAddress, E8(0.5), false, 100);
      await requestExecution(orderId); // locks 0.5 WBTC in the vault

      await exchange.connect(user).cancelSwapExecution(orderId);
      const [, , , status] = await exchange.getOrderPublic(orderId);
      expect(status).to.equal(0n); // back to Pending

      await exchange.connect(user).cancelOrder(orderId);

      // Lock restored: the FULL 1 WBTC is withdrawable again
      const reqTx = await vault.connect(user).requestWithdrawal(wbtcAddress, E8(1));
      await reqTx.wait();
      const requestId = await vault.withdrawalCounter();
      const execTx = await vault.connect(user).requestWithdrawalExecution(requestId);
      const receipt = await execTx.wait();
      let handles: string[] = [];
      for (const log of receipt!.logs) {
        try {
          const parsed = vault.interface.parseLog(log);
          if (parsed?.name === "DecryptionReady") handles = [...parsed.args.handles];
        } catch {}
      }
      const dec = await fhevm.publicDecrypt(handles);
      const before = await wbtc.balanceOf(user.address);
      await vault
        .connect(user)
        .executeWithdrawalCallback(requestId, dec.abiEncodedClearValues, dec.decryptionProof);
      expect((await wbtc.balanceOf(user.address)) - before).to.equal(E8(1));
    });

    it("only the owner can cancel their order", async function () {
      await depositToVault(wbtc, E8(1));
      const orderId = await createOrder(wbtcAddress, E8(0.5), false, 100);
      await expect(
        exchange.connect(attacker).cancelOrder(orderId)
      ).to.be.revertedWithCustomError(exchange, "UnauthorizedCancellation");
    });
  });

  // Sizing ---------------------------------------------------------------------------

  describe("deployability", function () {
    it("stays under the EIP-170 runtime-code limit", async function () {
      const fs = await import("fs");
      const path = await import("path");
      const artifactPath = path.join(
        __dirname,
        "../../artifacts/contracts/v2/NoctisExchangeV2.sol/NoctisExchangeV2.json"
      );
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      const size = (artifact.deployedBytecode.length - 2) / 2;
      expect(size).to.be.lessThan(24_576);
    });
  });
});
