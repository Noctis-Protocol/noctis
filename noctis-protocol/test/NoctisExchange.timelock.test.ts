import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * B2 — Exchange TimelockController delay path.
 * After setTimelock, PARAMS/GATEWAY admin calls must go through the timelock;
 * PAUSER (emergency) still works instantly.
 */
describe("NoctisExchange Timelock (B2)", function () {
  const MIN_DELAY = 3600; // 1 hour

  async function deployFixture() {
    const [owner, alice, safe] = await ethers.getSigners();

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
    const priceFeed = await MockChainlinkPriceFeed.deploy(3000n * 10n ** 8n);
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

    await vault.connect(owner).setExchange(await exchange.getAddress(), true);

    // Timelock: owner proposes + executes (local unit test)
    const NoctisTimelock = await ethers.getContractFactory("NoctisTimelock");
    const timelock = await NoctisTimelock.deploy(
      MIN_DELAY,
      [owner.address],
      [owner.address],
      owner.address
    );
    await timelock.waitForDeployment();

    return { owner, alice, safe, exchange, vault, timelock };
  }

  it("setTimelock is one-time and wires onlyTimelockOrRole", async function () {
    const { owner, alice, exchange, timelock } = await loadFixture(deployFixture);
    const tl = await timelock.getAddress();

    expect(await exchange.timelockConfigured()).to.equal(false);

    await expect(exchange.connect(owner).setTimelock(tl))
      .to.emit(exchange, "TimelockSet")
      .withArgs(tl);

    expect(await exchange.timelock()).to.equal(tl);
    expect(await exchange.timelockConfigured()).to.equal(true);

    await expect(exchange.connect(owner).setTimelock(alice.address)).to.be.revertedWithCustomError(
      exchange,
      "TimelockAlreadyConfigured"
    );
  });

  it("after timelock: direct setFeeBps reverts; schedule→wait→execute works", async function () {
    const { owner, exchange, timelock } = await loadFixture(deployFixture);
    const tl = await timelock.getAddress();
    const ex = await exchange.getAddress();

    await exchange.connect(owner).grantRole(await exchange.PARAMS_ROLE(), owner.address);
    await exchange.connect(owner).setTimelock(tl);

    // Role holder can no longer call directly
    await expect(exchange.connect(owner).setFeeBps(10)).to.be.revertedWithCustomError(
      exchange,
      "OnlyTimelock"
    );

    const data = exchange.interface.encodeFunctionData("setFeeBps", [10]);
    const predecessor = ethers.ZeroHash;
    const salt = ethers.id("b2-setFeeBps-10");

    await timelock.connect(owner).schedule(ex, 0, data, predecessor, salt, MIN_DELAY);

    await expect(timelock.connect(owner).execute(ex, 0, data, predecessor, salt)).to.be.reverted;

    await time.increase(MIN_DELAY + 1);

    await expect(timelock.connect(owner).execute(ex, 0, data, predecessor, salt))
      .to.emit(exchange, "FeeBpsUpdated")
      .withArgs(5, 10);

    expect(await exchange.feeBps()).to.equal(10);
  });

  it("pause still works instantly via PAUSER_ROLE (bypasses timelock)", async function () {
    const { owner, exchange, timelock } = await loadFixture(deployFixture);
    await exchange.connect(owner).setTimelock(await timelock.getAddress());

    // Deployer has DEFAULT_ADMIN; grant PAUSER to owner if needed
    const pauser = await exchange.PAUSER_ROLE();
    if (!(await exchange.hasRole(pauser, owner.address))) {
      await exchange.connect(owner).grantRole(pauser, owner.address);
    }

    await exchange.connect(owner).pause();
    expect(await exchange.paused()).to.equal(true);
    await exchange.connect(owner).unpause();
    expect(await exchange.paused()).to.equal(false);
  });

  it("setFeeRecipient / setMaxGasRefundWei require timelock after configuration (M-2)", async function () {
    const { owner, exchange, timelock } = await loadFixture(deployFixture);

    await exchange.connect(owner).grantRole(await exchange.PARAMS_ROLE(), owner.address);
    await exchange.connect(owner).setTimelock(await timelock.getAddress());

    // staticCall avoids fhevm hardhat-plugin flake on eth_sendTransaction revert matchers
    await expect(
      exchange.connect(owner).setFeeRecipient.staticCall(owner.address)
    ).to.be.revertedWithCustomError(exchange, "OnlyTimelock");
    await expect(
      exchange.connect(owner).setMaxGasRefundWei.staticCall(1n)
    ).to.be.revertedWithCustomError(exchange, "OnlyTimelock");
  });
});
