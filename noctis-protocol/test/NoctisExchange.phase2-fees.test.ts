import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Protocol fee wiring (settable feeBps, launch 5 = 0.05%, hard cap MAX_FEE_BPS = 30, feeRecipient).
 * Full Uniswap settlement coverage stays in integration tests; this locks admin + params.
 */
describe("NoctisExchange Phase 2 fees", function () {
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

    return { owner, alice, safe, exchange, vault };
  }

  it("feeBps launches at 5 (0.05%) and feeRecipient defaults to deployer", async function () {
    const { owner, exchange } = await loadFixture(deployFixture);
    expect(await exchange.feeBps()).to.equal(5);
    expect(await exchange.MAX_FEE_BPS()).to.equal(30);
    expect(await exchange.feeRecipient()).to.equal(owner.address);
  });

  it("PARAMS_ROLE admin can set feeBps within the cap (promo 0 / partner 5 / rack 10)", async function () {
    const { owner, exchange } = await loadFixture(deployFixture);
    await exchange.connect(owner).grantRole(await exchange.PARAMS_ROLE(), owner.address);

    // Promo: 0 bps
    await expect(exchange.connect(owner).setFeeBps(0))
      .to.emit(exchange, "FeeBpsUpdated")
      .withArgs(5, 0);
    expect(await exchange.feeBps()).to.equal(0);

    // Rack rate: 10 bps
    await expect(exchange.connect(owner).setFeeBps(10))
      .to.emit(exchange, "FeeBpsUpdated")
      .withArgs(0, 10);
    expect(await exchange.feeBps()).to.equal(10);

    // Cap boundary is allowed
    await exchange.connect(owner).setFeeBps(30);
    expect(await exchange.feeBps()).to.equal(30);
  });

  it("setFeeBps reverts above MAX_FEE_BPS and for non-admins", async function () {
    const { owner, alice, exchange } = await loadFixture(deployFixture);
    await exchange.connect(owner).grantRole(await exchange.PARAMS_ROLE(), owner.address);

    await expect(exchange.connect(owner).setFeeBps(31))
      .to.be.revertedWithCustomError(exchange, "FeeTooHigh")
      .withArgs(31, 30);

    await expect(exchange.connect(alice).setFeeBps(10)).to.be.reverted;
    expect(await exchange.feeBps()).to.equal(5);
  });

  it("PARAMS_ROLE can set feeRecipient to a Safe; zero address reverts", async function () {
    const { owner, alice, safe, exchange } = await loadFixture(deployFixture);

    // M-2: setFeeRecipient is behind PARAMS_ROLE / Timelock (not DEFAULT_ADMIN alone)
    await exchange.connect(owner).grantRole(await exchange.PARAMS_ROLE(), owner.address);

    await expect(exchange.connect(owner).setFeeRecipient(safe.address))
      .to.emit(exchange, "FeeRecipientUpdated")
      .withArgs(owner.address, safe.address);
    expect(await exchange.feeRecipient()).to.equal(safe.address);

    await expect(exchange.connect(owner).setFeeRecipient(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      exchange,
      "InvalidFeeRecipient"
    );

    await expect(
      exchange.connect(alice).setFeeRecipient.staticCall(alice.address)
    ).to.be.rejected;
  });
});
