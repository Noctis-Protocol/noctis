/**
 * @file Phase B privacy test suite (FHEVM v0.9 mock mode)
 * @description One-time pseudonyms + withdrawal batching windows:
 * - vaultId rotates when a relayed order reaches a terminal state (fill/cancel)
 * - the pre-rotation id becomes unresolvable (dead pseudonym)
 * - self-relay orders (vaultId 0) never trigger a rotation
 * - withdrawal execution is quantized to batch-window boundaries
 */

import { expect } from "chai";
import { ethers, fhevm, network } from "hardhat";
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

const PRICE_ETH = 3000n * 10n ** 8n;
const PRICE_WBTC = 60000n * 10n ** 8n;

describe("NoctisV2 - Phase B privacy (one-time vaultIds, batched withdrawals)", function () {
  let vault: NoctisVaultV2;
  let exchange: NoctisExchangeV2;
  let usdc: MockERC20;
  let wbtc: MockERC20;
  let weth: MockWETH;
  let router: MockUniswapRouterV2;

  let owner: HardhatEthersSigner; // also acts as the relayer in these tests
  let user: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  let vaultAddress: string;
  let exchangeAddress: string;
  let usdcAddress: string;
  let wbtcAddress: string;

  const E8 = (n: number) => BigInt(Math.round(n * 1e8));
  const E6 = (n: number) => BigInt(Math.round(n * 1e6));
  const E18 = (n: number) => ethers.parseEther(n.toString());

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
    usdcAddress = await usdc.getAddress();
    wbtcAddress = await wbtc.getAddress();

    const MockWETHFactory = await ethers.getContractFactory("MockWETH");
    weth = (await MockWETHFactory.deploy()) as MockWETH;

    const RouterFactory = await ethers.getContractFactory("MockUniswapRouterV2");
    router = (await RouterFactory.deploy(await weth.getAddress())) as MockUniswapRouterV2;

    const FeedFactory = await ethers.getContractFactory("MockChainlinkPriceFeed");
    const ethFeed = (await FeedFactory.deploy(PRICE_ETH)) as MockChainlinkPriceFeed;
    const wbtcFeed = (await FeedFactory.deploy(PRICE_WBTC)) as MockChainlinkPriceFeed;

    const VaultFactory = await ethers.getContractFactory("NoctisVaultV2");
    vault = (await VaultFactory.deploy(owner.address)) as NoctisVaultV2;
    vaultAddress = await vault.getAddress();

    await vault.configureToken(usdcAddress, 6, E6(1), E6(1_000_000), E6(1_000_000), E6(10_000_000));
    await vault.configureToken(wbtcAddress, 8, E8(0.0001), E8(100), E8(100), E8(1000));

    const ExchangeFactory = await ethers.getContractFactory("NoctisExchangeV2");
    exchange = (await ExchangeFactory.deploy(
      vaultAddress,
      await router.getAddress(),
      usdcAddress,
      await ethFeed.getAddress(),
      ethers.ZeroAddress
    )) as NoctisExchangeV2;
    exchangeAddress = await exchange.getAddress();

    await vault.setExchange(exchangeAddress, true);
    await exchange.grantRole(await exchange.PARAMS_ROLE(), owner.address);
    await exchange.grantRole(await exchange.RELAYER_ROLE(), owner.address);

    await exchange.configureTradableToken(
      wbtcAddress, await wbtcFeed.getAddress(), 8, false,
      E8(0.0001), E8(100), 1000n * 10n ** 8n, 200000n * 10n ** 8n
    );

    await router.setRate(wbtcAddress, usdcAddress, 598, 1);
    await usdc.mint(await router.getAddress(), E6(10_000_000));

    await wbtc.mint(user.address, E8(5));
    await wbtc.connect(user).approve(vaultAddress, E8(5));
    await vault.connect(user).depositToken(wbtcAddress, E8(1));
  });

  // Helpers -------------------------------------------------------------------

  function parseEvent(iface: any, receipt: any, name: string): any | null {
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed && parsed.name === name) return parsed.args;
      } catch {}
    }
    return null;
  }

  async function createRelayedOrder(vaultId: bigint, amount: bigint): Promise<bigint> {
    const enc = await fhevm
      .createEncryptedInput(exchangeAddress, owner.address)
      .add128(amount)
      .encrypt();
    const tx = await exchange
      .connect(owner)
      .createEncryptedOrderViaRelayer(
        vaultId, wbtcAddress, enc.handles[0], enc.inputProof, false, 100, 150, 0
      );
    const args = parseEvent(exchange.interface, await tx.wait(), "OrderCreated");
    expect(args).to.not.be.null;
    return args.orderId;
  }

  async function fillSellViaRelayer(orderId: bigint) {
    const reqTx = await exchange.connect(owner).requestSwapExecutionViaRelayer(orderId);
    const args = parseEvent(exchange.interface, await reqTx.wait(), "SwapDecryptionReady");
    const handles: string[] = [...args.handles];
    const dec = await fhevm.publicDecrypt(handles);
    const [amount] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint128", "bool"],
      dec.abiEncodedClearValues
    );
    await exchange
      .connect(owner)
      .executeSwapViaRelayer(orderId, amount, 0, dec.abiEncodedClearValues, dec.decryptionProof);
  }

  /** eth_call with a spoofed `from` — how the keeper resolves ids off-chain.
   *  Must go through a provider-connected instance: signer runners reject the
   *  `from` mismatch. */
  async function resolveOwner(vaultId: bigint): Promise<string> {
    const reader = vault.connect(ethers.provider) as NoctisVaultV2;
    return (await reader.getAddressByVaultId.staticCall(vaultId, {
      from: exchangeAddress,
    })) as string;
  }

  // One-time vaultIds -----------------------------------------------------------

  describe("vaultId rotation (one-time pseudonyms)", function () {
    it("rotates the vaultId after a relayed SELL settles", async function () {
      const idBefore = await vault.connect(user).getMyVaultId();
      const orderId = await createRelayedOrder(idBefore, E8(0.5));

      await fillSellViaRelayer(orderId);

      const idAfter = await vault.connect(user).getMyVaultId();
      expect(idAfter).to.not.equal(idBefore);
      expect(idAfter).to.not.equal(0n);

      // The exposed pseudonym is dead: it no longer resolves to anyone
      await expect(resolveOwner(idBefore)).to.be.revertedWithCustomError(vault, "InvalidVaultId");
      // The fresh one belongs to the same user (owner-scoped view)
      expect(await resolveOwner(idAfter)).to.equal(user.address);
    });

    it("rotates the vaultId after a relayed cancel", async function () {
      const idBefore = await vault.connect(user).getMyVaultId();
      const orderId = await createRelayedOrder(idBefore, E8(0.5));

      await exchange.connect(owner).cancelOrderViaRelayer(orderId);

      const idAfter = await vault.connect(user).getMyVaultId();
      expect(idAfter).to.not.equal(idBefore);
      await expect(resolveOwner(idBefore)).to.be.revertedWithCustomError(vault, "InvalidVaultId");
    });

    it("sequential relayed orders never reuse a pseudonym", async function () {
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const vid = await vault.connect(user).getMyVaultId();
        expect(seen.has(vid.toString())).to.be.false;
        seen.add(vid.toString());
        const orderId = await createRelayedOrder(vid, E8(0.1));
        await fillSellViaRelayer(orderId);
      }
      expect(seen.size).to.equal(3);
    });

    it("does NOT rotate for self-relay orders (tx.from is public anyway)", async function () {
      const idBefore = await vault.connect(user).getMyVaultId();

      const tx = await exchange
        .connect(user)
        .createMarketOrder(wbtcAddress, E8(0.5), false, 100, 150);
      const args = parseEvent(exchange.interface, await tx.wait(), "OrderCreated");
      await exchange.connect(user).cancelOrder(args.orderId);

      expect(await vault.connect(user).getMyVaultId()).to.equal(idBefore);
    });

    it("rotateVaultId is exchange-only", async function () {
      await expect(
        vault.connect(attacker).rotateVaultId.staticCall(user.address)
      ).to.be.revertedWithCustomError(vault, "UnauthorizedExchange");
    });
  });

  // Withdrawal batching -----------------------------------------------------------

  describe("withdrawal batching window", function () {
    const WINDOW = 600n; // 10 minutes

    it("quantizes withdrawal execution to window boundaries", async function () {
      await vault.setWithdrawalBatchWindow(WINDOW);

      await vault.connect(user).requestWithdrawal(wbtcAddress, E8(0.25));
      const ids = await vault.connect(user).getMyWithdrawalRequestIds();
      const requestId = ids[ids.length - 1];

      // Immediately after the request: still inside the batch window
      await expect(
        vault.connect(user).requestWithdrawalExecution.staticCall(requestId)
      ).to.be.revertedWithCustomError(vault, "WithdrawalBatchPending");

      // Cross the boundary: execution opens up
      await network.provider.send("evm_increaseTime", [Number(WINDOW)]);
      await network.provider.send("evm_mine");

      const execTx = await vault.connect(user).requestWithdrawalExecution(requestId);
      const args = parseEvent(vault.interface, await execTx.wait(), "DecryptionReady");
      expect(args).to.not.be.null;

      const dec = await fhevm.publicDecrypt([...args.handles]);
      const before = await wbtc.balanceOf(user.address);
      await vault
        .connect(user)
        .executeWithdrawalCallback(requestId, dec.abiEncodedClearValues, dec.decryptionProof);
      expect((await wbtc.balanceOf(user.address)) - before).to.equal(E8(0.25));
    });

    it("window disabled (0) keeps the immediate path", async function () {
      expect(await vault.withdrawalBatchWindow()).to.equal(0n);
      await vault.connect(user).requestWithdrawal(wbtcAddress, E8(0.25));
      const ids = await vault.connect(user).getMyWithdrawalRequestIds();
      const requestId = ids[ids.length - 1];
      // No revert: immediate execution allowed
      await vault.connect(user).requestWithdrawalExecution(requestId);
    });

    it("caps the window and gates the setter to the owner", async function () {
      await expect(
        vault.setWithdrawalBatchWindow.staticCall(3601n)
      ).to.be.revertedWithCustomError(vault, "BatchWindowTooLong");
      await expect(
        vault.connect(attacker).setWithdrawalBatchWindow.staticCall(60n)
      ).to.be.reverted;
      await expect(vault.setWithdrawalBatchWindow(WINDOW))
        .to.emit(vault, "WithdrawalBatchWindowUpdated")
        .withArgs(WINDOW);
    });
  });
});
