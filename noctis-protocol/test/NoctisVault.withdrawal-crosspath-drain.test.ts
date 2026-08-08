/**
 * @file NoctisVault.withdrawal-crosspath-drain.test.ts
 * @description C-1 audit fix: pending over-balance withdrawal must NOT wrap encrypted
 *              balance such that the Exchange prepareDeductAuth* path can drain the vault.
 *
 * Attack (before fix):
 * 1. Deposit 1 ETH
 * 2. requestEncryptedWithdrawal(100 ETH) — un-gated FHE.sub wraps balance
 * 3. Leave withdrawal pending (no callback)
 * 4. prepareDeductAuth sees huge balance → deductBalanceWithProof moves others' ETH
 *
 * Fix: FHE.select gates the withdrawal debit so balance never wraps.
 */

import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import * as hre from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { NoctisVault } from "../typechain-types";

describe("NoctisVault - C-1 withdrawal cross-path drain", function () {
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

    const VaultFactory = await ethers.getContractFactory("NoctisVault");
    vault = (await VaultFactory.deploy(owner.address, await usdt.getAddress())) as NoctisVault;
    vaultAddress = await vault.getAddress();

    const MockEx = await ethers.getContractFactory("MockExchangeCaller");
    exchange = await MockEx.deploy(vaultAddress);
    await vault.setExchange(await exchange.getAddress(), true);
  });

  function parseDeductAuthPrepared(receipt: any): string {
    for (const log of receipt.logs) {
      try {
        const parsed = vault.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed && parsed.name === "DeductAuthPrepared") {
          return parsed.args.sufficiencyHandle as string;
        }
      } catch {
        // skip
      }
    }
    throw new Error("DeductAuthPrepared not found");
  }

  it("pending over-balance withdrawal must not make Exchange deduct succeed", async function () {
    await vault.connect(alice).depositETH({ value: ethers.parseEther("1") });
    await vault.connect(bob).depositETH({ value: ethers.parseEther("50") });

    const vaultEthBefore = await ethers.provider.getBalance(vaultAddress);

    // Open malicious over-balance withdrawal and leave it pending
    await vault
      .connect(alice)
      .requestEncryptedWithdrawal(alice.address, ethers.parseEther("50"), true);

    // Exchange tries to debit 50 ETH against Alice while withdrawal is still pending
    const orderId = 42n;
    const attackAmount = ethers.parseEther("50");
    const prepTx = await exchange.preparePlain(orderId, alice.address, attackAmount, true);
    const prepReceipt = await prepTx.wait();
    const handle = parseDeductAuthPrepared(prepReceipt);

    const decrypted = await fhevm.publicDecrypt([handle]);
    const ok = ethers.AbiCoder.defaultAbiCoder().decode(
      ["bool"],
      decrypted.abiEncodedClearValues
    )[0];
    expect(ok).to.equal(false, "sufficiency must be false — balance must not have wrapped");

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

  it("should still allow valid withdraw amount after a failed over-balance request", async function () {
    await vault.connect(alice).depositETH({ value: ethers.parseEther("2") });

    await vault
      .connect(alice)
      .requestEncryptedWithdrawal(alice.address, ethers.parseEther("50"), true);

    // Cancel the pending over-balance request (immediate — no gateway started)
    const requestId = await vault.withdrawalCounter();
    await vault.connect(alice).cancelWithdrawal(requestId);

    // Honest withdraw of 1 ETH must still work (balance was never wrapped/corrupted)
    const orderId = 7n;
    const amount = ethers.parseEther("1");
    const prepTx = await exchange.preparePlain(orderId, alice.address, amount, true);
    const prepReceipt = await prepTx.wait();
    const handle = parseDeductAuthPrepared(prepReceipt);

    const decrypted = await fhevm.publicDecrypt([handle]);
    const ok = ethers.AbiCoder.defaultAbiCoder().decode(
      ["bool"],
      decrypted.abiEncodedClearValues
    )[0];
    expect(ok).to.equal(true);

    await expect(
      exchange.deductWithProof(
        orderId,
        alice.address,
        amount,
        true,
        decrypted.abiEncodedClearValues,
        decrypted.decryptionProof
      )
    ).to.not.be.reverted;
  });
});
