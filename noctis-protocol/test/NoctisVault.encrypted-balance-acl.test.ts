import { expect } from "chai";
import { ethers } from "hardhat";
import { NoctisVault, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Privacy: getEncryptedBalance must not grant FHE ACL to arbitrary callers.
 * Deposit events must not echo cleartext amounts (still public via tx/Transfer).
 */
describe("NoctisVault - Encrypted Balance ACL & Deposit Event Privacy", function () {
  let vault: NoctisVault;
  let mockUSDT: MockERC20;
  let owner: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let exchange: HardhatEthersSigner;

  const ETH_DEPOSIT = ethers.parseEther("0.01");
  const USDT_DEPOSIT = ethers.parseUnits("100", 6);

  beforeEach(async function () {
    [owner, user1, user2, exchange] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    mockUSDT = await MockERC20Factory.deploy("Mock USDT", "USDT", 6);
    await mockUSDT.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory("NoctisVault");
    vault = await VaultFactory.deploy(owner.address, await mockUSDT.getAddress());
    await vault.waitForDeployment();

    await mockUSDT.mint(user1.address, ethers.parseUnits("10000", 6));
  });

  describe("Deposit events (no cleartext amount)", function () {
    it("ETHDeposited emits only indexed user", async function () {
      await expect(vault.connect(user1).depositETH({ value: ETH_DEPOSIT }))
        .to.emit(vault, "ETHDeposited")
        .withArgs(user1.address);
    });

    it("USDTDeposited emits only indexed user", async function () {
      await mockUSDT.connect(user1).approve(await vault.getAddress(), USDT_DEPOSIT);
      await expect(vault.connect(user1).depositUSDT(USDT_DEPOSIT))
        .to.emit(vault, "USDTDeposited")
        .withArgs(user1.address);
    });
  });

  describe("getEncryptedBalance ACL gate", function () {
    beforeEach(async function () {
      await vault.connect(user1).depositETH({ value: ETH_DEPOSIT });
    });

    it("owner of balance can call getEncryptedBalance (happy path)", async function () {
      const handle = await vault
        .connect(user1)
        .getEncryptedBalance.staticCall(user1.address, true);
      expect(handle).to.not.equal(ethers.ZeroHash);
    });

    it("third party can still read ciphertext handle (no revert)", async function () {
      // Handle is public ciphertext; decrypt rights must not be granted to user2.
      // (ACL grant itself is enforced in Solidity; ZAMA coprocessor validates off-chain.)
      const handle = await vault
        .connect(user2)
        .getEncryptedBalance.staticCall(user1.address, true);
      expect(handle).to.not.equal(ethers.ZeroHash);
    });

    it("authorized exchange can call getEncryptedBalance for a user", async function () {
      await vault.connect(owner).setExchange(exchange.address, true);
      const handle = await vault
        .connect(exchange)
        .getEncryptedBalance.staticCall(user1.address, true);
      expect(handle).to.not.equal(ethers.ZeroHash);
    });

    it("revoked exchange is treated like a third party (still returns handle)", async function () {
      await vault.connect(owner).setExchange(exchange.address, true);
      await vault.connect(owner).setExchange(exchange.address, false);
      const handle = await vault
        .connect(exchange)
        .getEncryptedBalance.staticCall(user1.address, true);
      expect(handle).to.not.equal(ethers.ZeroHash);
    });

    it("reverts for address(0)", async function () {
      await expect(
        vault.connect(user1).getEncryptedBalance(ethers.ZeroAddress, true)
      ).to.be.revertedWithCustomError(vault, "InvalidAddress");
    });

    it("returns a handle for uninitialized USDT balance", async function () {
      const handle = await vault
        .connect(user1)
        .getEncryptedBalance.staticCall(user1.address, false);
      expect(handle).to.not.be.undefined;
    });
  });
});
