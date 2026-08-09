/**
 * @file V2.5 privacy test suite — chaff writes + confidential deposits (FHEVM v0.9 mock mode)
 * @description
 * Chaff (decoy balance rewrites):
 * - a settlement credit/debit also rewrites K decoy balances (fresh handles)
 * - decoy balance VALUES are unchanged (FHE.add(bal, 0))
 * - owner can tune K; K=0 disables; K > MAX reverts
 *
 * Confidential deposits (ERC-7984 cUSDC):
 * - wrap USDC -> cUSDC, then confidentialTransferAndCall credits the vault
 *   balance with an END-TO-END ENCRYPTED amount (never in calldata/logs)
 * - homomorphic maxDeposit cap: over-limit deposits credit 0 and are refunded
 *   by the token (FHE-gated refund, no revert, no amount leak)
 * - flushConfidentialBuffer unwraps the POOLED total to the vault's public
 *   reserve (k-anonymity: only the sum is ever revealed)
 *
 * Shredding capacity:
 * - MAX_PENDING_WITHDRAWALS_PER_USER == 8 (parallel denomination requests)
 */

import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import * as hre from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { NoctisVaultV2, NoctisConfidentialToken, MockERC20 } from "../../typechain-types";

describe("NoctisV2 - V2.5 privacy (chaff + confidential deposits)", function () {
  let vault: NoctisVaultV2;
  let usdc: MockERC20;
  let cusdc: NoctisConfidentialToken;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let exchangeEOA: HardhatEthersSigner;

  let vaultAddress: string;
  let usdcAddress: string;
  let cusdcAddress: string;

  const E6 = (n: number) => BigInt(Math.round(n * 1e6));
  const MAX_DEPOSIT = E6(1_000_000);

  before(async function () {
    if (!hre.fhevm.isMock) {
      throw new Error("This test suite requires FHEVM mock mode (hardhat network)");
    }
  });

  beforeEach(async function () {
    [owner, user, alice, bob, carol, exchangeEOA] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    usdc = (await MockERC20Factory.deploy("USD Coin", "USDC", 6)) as MockERC20;
    usdcAddress = await usdc.getAddress();

    const VaultFactory = await ethers.getContractFactory("NoctisVaultV2");
    vault = (await VaultFactory.deploy(owner.address)) as NoctisVaultV2;
    vaultAddress = await vault.getAddress();

    await vault.configureToken(usdcAddress, 6, E6(1), MAX_DEPOSIT, E6(500_000), E6(5_000_000));

    const WrapperFactory = await ethers.getContractFactory("NoctisConfidentialToken");
    cusdc = (await WrapperFactory.deploy(
      usdcAddress,
      "Confidential USDC",
      "cUSDC",
      ""
    )) as NoctisConfidentialToken;
    cusdcAddress = await cusdc.getAddress();

    await vault.setConfidentialWrapper(cusdcAddress);

    for (const signer of [user, alice, bob, carol]) {
      await usdc.mint(signer.address, E6(2_000_000));
      await usdc.connect(signer).approve(vaultAddress, ethers.MaxUint256);
      await usdc.connect(signer).approve(cusdcAddress, ethers.MaxUint256);
    }
  });

  // Helpers -------------------------------------------------------------------

  async function balanceHandle(who: string): Promise<string> {
    return await vault.getEncryptedBalance.staticCall(who, usdcAddress);
  }

  async function decryptBalance(signer: HardhatEthersSigner): Promise<bigint> {
    // Grant/refresh ACL exactly like the production flow, then user-decrypt
    await (await vault.connect(signer).getEncryptedBalance(signer.address, usdcAddress)).wait();
    const handle = await balanceHandle(signer.address);
    if (handle === ethers.ZeroHash) return 0n;
    return await fhevm.userDecryptEuint(FhevmType.euint128, handle, vaultAddress, signer);
  }

  /** Confidential deposit: wrap + confidentialTransferAndCall to the vault */
  async function confidentialDeposit(signer: HardhatEthersSigner, amount: bigint) {
    await (await cusdc.connect(signer).wrap(signer.address, amount)).wait();
    const enc = await fhevm
      .createEncryptedInput(cusdcAddress, signer.address)
      .add64(amount)
      .encrypt();
    await (
      await cusdc
        .connect(signer)
        ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
          vaultAddress,
          enc.handles[0],
          enc.inputProof,
          "0x"
        )
    ).wait();
  }

  async function decryptCusdcBalance(signer: HardhatEthersSigner): Promise<bigint> {
    const handle = await cusdc.confidentialBalanceOf(signer.address);
    if (handle === ethers.ZeroHash) return 0n;
    return await fhevm.userDecryptEuint(FhevmType.euint64, handle, cusdcAddress, signer);
  }

  // ===========================================================================
  // Chaff decoy writes
  // ===========================================================================

  describe("Chaff decoy writes (settlement storage-diff ambiguity)", function () {
    beforeEach(async function () {
      // Seed the depositor registry with 4 users (public deposits)
      for (const signer of [user, alice, bob, carol]) {
        await vault.connect(signer).depositToken(usdcAddress, E6(1000));
      }
      // Authorize an EOA as "exchange" so we can trigger settlement writes
      await vault.setExchange(exchangeEOA.address, true);
    });

    it("rewrites decoy balances on a settlement credit (default K=2)", async function () {
      const before: Record<string, string> = {};
      for (const s of [user, alice, bob, carol]) {
        before[s.address] = await balanceHandle(s.address);
      }

      await vault
        .connect(exchangeEOA)
        .creditBalance(user.address, E6(100), usdcAddress);

      let changed = 0;
      for (const s of [alice, bob, carol]) {
        if ((await balanceHandle(s.address)) !== before[s.address]) changed++;
      }
      // K=2 decoys requested; bounded probing may deduplicate draws, but at
      // least one decoy must have been rewritten alongside the real credit
      expect(changed).to.be.gte(1);
      expect(await balanceHandle(user.address)).to.not.equal(before[user.address]);
    });

    it("decoy rewrites do NOT change decoy balance values", async function () {
      await vault
        .connect(exchangeEOA)
        .creditBalance(user.address, E6(100), usdcAddress);

      // Every non-target user still decrypts exactly their deposit
      expect(await decryptBalance(alice)).to.equal(E6(1000));
      expect(await decryptBalance(bob)).to.equal(E6(1000));
      expect(await decryptBalance(carol)).to.equal(E6(1000));
      // And the real target got credited
      expect(await decryptBalance(user)).to.equal(E6(1100));
    });

    it("chaff also fires on the deduct-lock path", async function () {
      const before: Record<string, string> = {};
      for (const s of [alice, bob, carol]) {
        before[s.address] = await balanceHandle(s.address);
      }

      await vault
        .connect(exchangeEOA)
        .prepareDeductAuth(1, user.address, E6(50), usdcAddress);

      let changed = 0;
      for (const s of [alice, bob, carol]) {
        if ((await balanceHandle(s.address)) !== before[s.address]) changed++;
      }
      expect(changed).to.be.gte(1);
    });

    it("owner can disable chaff (K=0) — only the real balance moves", async function () {
      await vault.setChaffWrites(0);

      const before: Record<string, string> = {};
      for (const s of [alice, bob, carol]) {
        before[s.address] = await balanceHandle(s.address);
      }

      await vault
        .connect(exchangeEOA)
        .creditBalance(user.address, E6(100), usdcAddress);

      for (const s of [alice, bob, carol]) {
        expect(await balanceHandle(s.address)).to.equal(before[s.address]);
      }
    });

    it("rejects K above the hard cap; non-owner cannot tune", async function () {
      await expect(vault.setChaffWrites(9)).to.be.revertedWithCustomError(
        vault,
        "InvalidChaffCount"
      );
      await expect(vault.connect(user).setChaffWrites(1)).to.be.reverted;
      await expect(vault.setChaffWrites(8)).to.emit(vault, "ChaffWritesUpdated").withArgs(8);
    });
  });

  // ===========================================================================
  // Confidential deposits (ERC-7984)
  // ===========================================================================

  describe("Confidential deposits (ERC-7984 cUSDC)", function () {
    it("credits the vault balance with an end-to-end encrypted amount", async function () {
      await confidentialDeposit(user, E6(5000));
      expect(await decryptBalance(user)).to.equal(E6(5000));
    });

    it("stacks on top of an existing public-deposit balance", async function () {
      await vault.connect(user).depositToken(usdcAddress, E6(1000));
      await confidentialDeposit(user, E6(250));
      expect(await decryptBalance(user)).to.equal(E6(1250));
    });

    it("emits only an anonymous event (token + timestamp, no address, no amount)", async function () {
      await (await cusdc.connect(user).wrap(user.address, E6(100))).wait();
      const enc = await fhevm
        .createEncryptedInput(cusdcAddress, user.address)
        .add64(E6(100))
        .encrypt();
      const tx = await cusdc
        .connect(user)
        ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
          vaultAddress,
          enc.handles[0],
          enc.inputProof,
          "0x"
        );
      const receipt = await tx.wait();

      const vaultLogs = receipt!.logs
        .filter((l) => l.address === vaultAddress)
        .map((l) => vault.interface.parseLog(l))
        .filter((p) => p !== null);
      expect(vaultLogs.map((p) => p!.name)).to.deep.equal(["ConfidentialDeposited"]);
      expect(vaultLogs[0]!.args.token).to.equal(usdcAddress);
    });

    it("HOMOMORPHIC CAP: over-limit deposit credits 0 and is refunded in cUSDC", async function () {
      const over = MAX_DEPOSIT + E6(1);
      await confidentialDeposit(user, over);

      // Nothing credited in the vault
      expect(await decryptBalance(user)).to.equal(0n);
      // Token refunded the whole transfer — user still holds their cUSDC
      expect(await decryptCusdcBalance(user)).to.equal(over);
    });

    it("rejects hook calls from anyone but the configured wrapper", async function () {
      const fakeHandle = ethers.ZeroHash;
      await expect(
        vault
          .connect(user)
          .onConfidentialTransferReceived(user.address, user.address, fakeHandle, "0x")
      ).to.be.revertedWithCustomError(vault, "NotConfidentialWrapper");
    });

    it("flushes the POOLED buffer to the vault's public reserve (k-anonymity)", async function () {
      // Three users deposit different confidential amounts in the same window
      await confidentialDeposit(user, E6(1000));
      await confidentialDeposit(alice, E6(2500));
      await confidentialDeposit(bob, E6(600));

      const reserveBefore = await usdc.balanceOf(vaultAddress);

      // Keeper flushes: unwrap request for the vault's whole cUSDC balance
      const tx = await vault.connect(exchangeEOA).flushConfidentialBuffer();
      const receipt = await tx.wait();
      const parsed = receipt!.logs
        .filter((l) => l.address === vaultAddress)
        .map((l) => vault.interface.parseLog(l))
        .find((p) => p?.name === "ConfidentialBufferFlushRequested");
      const unwrapRequestId = parsed!.args.unwrapRequestId as string;

      // Keeper decrypts the pooled total and finalizes on the wrapper
      const dec = await fhevm.publicDecrypt([unwrapRequestId]);
      const [pooled] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint64"],
        dec.abiEncodedClearValues
      );
      expect(pooled).to.equal(E6(4100)); // only the SUM is ever public

      await cusdc.finalizeUnwrap(unwrapRequestId, pooled, dec.decryptionProof);

      expect((await usdc.balanceOf(vaultAddress)) - reserveBefore).to.equal(E6(4100));
      // Individual encrypted balances are untouched by the flush
      expect(await decryptBalance(user)).to.equal(E6(1000));
      expect(await decryptBalance(alice)).to.equal(E6(2500));
      expect(await decryptBalance(bob)).to.equal(E6(600));
    });

    it("wiring: setConfidentialWrapper validates the underlying is registered", async function () {
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const dai = await MockERC20Factory.deploy("DAI", "DAI", 18);
      const WrapperFactory = await ethers.getContractFactory("NoctisConfidentialToken");
      const cdai = await WrapperFactory.deploy(await dai.getAddress(), "cDAI", "cDAI", "");
      // staticCall: the FHEVM mock plugin chokes on gas estimation of
      // reverting txs that follow a fresh FHE-contract deployment
      await expect(
        vault.setConfidentialWrapper.staticCall(await cdai.getAddress())
      ).to.be.revertedWithCustomError(vault, "TokenNotSupported");
    });
  });

  // ===========================================================================
  // Shredding capacity
  // ===========================================================================

  describe("Withdrawal shredding capacity", function () {
    it("MAX_PENDING_WITHDRAWALS_PER_USER is 8", async function () {
      expect(await vault.MAX_PENDING_WITHDRAWALS_PER_USER()).to.equal(8n);
    });

    it("accepts 8 parallel withdrawal requests (denomination shredding)", async function () {
      await vault.connect(user).depositToken(usdcAddress, E6(10_000));

      for (let i = 0; i < 8; i++) {
        const enc = await fhevm
          .createEncryptedInput(vaultAddress, user.address)
          .add128(E6(1000))
          .addAddress(ethers.Wallet.createRandom().address)
          .encrypt();
        await vault
          .connect(user)
          .requestWithdrawalPrivate(usdcAddress, enc.handles[0], enc.handles[1], enc.inputProof);
      }
      const ids = await vault.connect(user).getMyWithdrawalRequestIds();
      expect(ids.length).to.equal(8);

      // The 9th is rejected
      const enc = await fhevm
        .createEncryptedInput(vaultAddress, user.address)
        .add128(E6(1000))
        .addAddress(ethers.Wallet.createRandom().address)
        .encrypt();
      await expect(
        vault
          .connect(user)
          .requestWithdrawalPrivate(usdcAddress, enc.handles[0], enc.handles[1], enc.inputProof)
      ).to.be.revertedWithCustomError(vault, "TooManyPendingWithdrawals");
    });
  });
});
