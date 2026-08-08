/**
 * @file NoctisVault.deductBalance.test.ts
 * @description CRITICAL fund-safety fix: deduct must gate with FHE.select + sufficiency proof
 *
 * Attack (before fix):
 * - User with 1 ETH encrypted balance requests swap debit of 10 ETH
 * - Vault ignored hasSufficient, FHE.sub underflowed, transferred 10 ETH of others' funds
 *
 * Fix:
 * - prepareDeductAuth* locks via FHE.select
 * - deductBalanceWithProof requires decrypted ebool == true before physical transfer
 * - Legacy deductBalance reverts
 */

import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import * as hre from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { NoctisVault } from "../typechain-types";

describe("NoctisVault - deductBalance fund-safety (CRITICAL)", function () {
  let vault: NoctisVault;
  let vaultAddress: string;
  let exchange: any;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  before(async function () {
    if (!hre.fhevm.isMock) {
      throw new Error("This test suite requires FHEVM mock mode");
    }
  });

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    alice = signers[1];
    bob = signers[2];

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdt = await MockERC20.deploy("Mock USDT", "USDT", 6);
    const usdtAddress = await usdt.getAddress();

    const VaultFactory = await ethers.getContractFactory("NoctisVault");
    vault = (await VaultFactory.deploy(owner.address, usdtAddress)) as NoctisVault;
    vaultAddress = await vault.getAddress();

    const MockEx = await ethers.getContractFactory("MockExchangeCaller");
    exchange = await MockEx.deploy(vaultAddress);
    await vault.setExchange(await exchange.getAddress(), true);
  });

  function parseDeductAuthPrepared(receipt: any): { orderId: bigint; handle: string } {
    for (const log of receipt.logs) {
      try {
        const parsed = vault.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed && parsed.name === "DeductAuthPrepared") {
          return {
            orderId: parsed.args.orderId,
            handle: parsed.args.sufficiencyHandle,
          };
        }
      } catch {
        // skip
      }
    }
    throw new Error("DeductAuthPrepared not found");
  }

  it("should REJECT physical deduct when amount > encrypted balance (attack)", async function () {
    await vault.connect(alice).depositETH({ value: ethers.parseEther("1") });
    await vault.connect(bob).depositETH({ value: ethers.parseEther("10") });

    const vaultEthBefore = await ethers.provider.getBalance(vaultAddress);
    const orderId = 1n;
    const attackAmount = ethers.parseEther("10");

    const prepTx = await exchange.preparePlain(orderId, alice.address, attackAmount, true);
    const prepReceipt = await prepTx.wait();
    const { handle } = parseDeductAuthPrepared(prepReceipt);

    const decrypted = await fhevm.publicDecrypt([handle]);
    const ok = ethers.AbiCoder.defaultAbiCoder().decode(
      ["bool"],
      decrypted.abiEncodedClearValues
    )[0];
    expect(ok).to.equal(false);

    await expect(
      exchange.deductWithProof(
        orderId,
        alice.address,
        attackAmount,
        true,
        decrypted.abiEncodedClearValues,
        decrypted.decryptionProof
      )
    ).to.be.revertedWithCustomError(vault, "InsufficientEncryptedBalance");

    const vaultEthAfter = await ethers.provider.getBalance(vaultAddress);
    expect(vaultEthAfter).to.equal(vaultEthBefore);
  });

  it("should allow physical deduct when amount <= encrypted balance (happy path)", async function () {
    await vault.connect(alice).depositETH({ value: ethers.parseEther("1") });

    const orderId = 2n;
    const amount = ethers.parseEther("0.4");
    const exchangeAddr = await exchange.getAddress();
    const exBefore = await ethers.provider.getBalance(exchangeAddr);

    const prepTx = await exchange.preparePlain(orderId, alice.address, amount, true);
    const prepReceipt = await prepTx.wait();
    const { handle } = parseDeductAuthPrepared(prepReceipt);

    const decrypted = await fhevm.publicDecrypt([handle]);
    const ok = ethers.AbiCoder.defaultAbiCoder().decode(
      ["bool"],
      decrypted.abiEncodedClearValues
    )[0];
    expect(ok).to.equal(true);

    await exchange.deductWithProof(
      orderId,
      alice.address,
      amount,
      true,
      decrypted.abiEncodedClearValues,
      decrypted.decryptionProof
    );

    const exAfter = await ethers.provider.getBalance(exchangeAddr);
    expect(exAfter - exBefore).to.equal(amount);
  });

  it("should revert legacy deductBalance without proof", async function () {
    await vault.connect(alice).depositETH({ value: ethers.parseEther("1") });
    await expect(
      exchange.legacyDeduct(alice.address, ethers.parseEther("0.1"), true)
    ).to.be.revertedWithCustomError(vault, "DeductAuthNotPrepared");
  });

  it("should isolate users: Alice attack does not drain Bob", async function () {
    await vault.connect(alice).depositETH({ value: ethers.parseEther("1") });
    await vault.connect(bob).depositETH({ value: ethers.parseEther("5") });

    const vaultBefore = await ethers.provider.getBalance(vaultAddress);

    const prepTx = await exchange.preparePlain(99n, alice.address, ethers.parseEther("5"), true);
    const prepReceipt = await prepTx.wait();
    const { handle } = parseDeductAuthPrepared(prepReceipt);
    const decrypted = await fhevm.publicDecrypt([handle]);

    await expect(
      exchange.deductWithProof(
        99n,
        alice.address,
        ethers.parseEther("5"),
        true,
        decrypted.abiEncodedClearValues,
        decrypted.decryptionProof
      )
    ).to.be.revertedWithCustomError(vault, "InsufficientEncryptedBalance");

    expect(await ethers.provider.getBalance(vaultAddress)).to.equal(vaultBefore);
  });
});
