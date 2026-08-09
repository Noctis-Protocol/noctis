/**
 * @file NoctisVaultV2 multi-token test suite (FHEVM v0.9 mock mode)
 * @description Verifies the token-generic vault: registry, deposits, encrypted
 * withdrawals (gated FHE.select debits), per-token circuit breakers, and the
 * fee-on-transfer defense — across tokens with different decimals
 * (WBTC 8, LINK 18, DAI 18, EURC 6) plus native ETH.
 */

import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import * as hre from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { NoctisVaultV2, MockERC20 } from "../../typechain-types";

const NATIVE = ethers.ZeroAddress;

describe("NoctisVaultV2 - Multi-Token Vault (Mock Mode)", function () {
  let vault: NoctisVaultV2;
  let vaultAddress: string;
  let wbtc: MockERC20;
  let link: MockERC20;
  let dai: MockERC20;
  let eurc: MockERC20;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const WBTC = (n: number) => BigInt(Math.round(n * 1e8));
  const E18 = (n: number) => ethers.parseEther(n.toString());
  const E6 = (n: number) => BigInt(Math.round(n * 1e6));

  before(async function () {
    if (!hre.fhevm.isMock) {
      throw new Error("This test suite requires FHEVM mock mode (hardhat network)");
    }
  });

  beforeEach(async function () {
    [owner, user, other] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    wbtc = (await MockERC20Factory.deploy("Wrapped BTC", "WBTC", 8)) as MockERC20;
    link = (await MockERC20Factory.deploy("Chainlink", "LINK", 18)) as MockERC20;
    dai = (await MockERC20Factory.deploy("Dai", "DAI", 18)) as MockERC20;
    eurc = (await MockERC20Factory.deploy("Euro Coin", "EURC", 6)) as MockERC20;

    const VaultFactory = await ethers.getContractFactory("NoctisVaultV2");
    vault = (await VaultFactory.deploy(owner.address)) as NoctisVaultV2;
    vaultAddress = await vault.getAddress();

    // Register: token, decimals, minDeposit, maxDeposit, maxWithdrawal, maxDaily
    await vault.configureToken(NATIVE, 18, E18(0.005), E18(100), E18(100), E18(1000));
    await vault.configureToken(await wbtc.getAddress(), 8, WBTC(0.0001), WBTC(100), WBTC(100), WBTC(1000));
    await vault.configureToken(await link.getAddress(), 18, E18(1), E18(1_000_000), E18(1_000_000), E18(10_000_000));
    await vault.configureToken(await dai.getAddress(), 18, E18(1), E18(1_000_000), E18(1_000_000), E18(10_000_000));
    await vault.configureToken(await eurc.getAddress(), 6, E6(1), E6(1_000_000), E6(1_000_000), E6(10_000_000));

    // Fund the user
    await wbtc.mint(user.address, WBTC(10));
    await link.mint(user.address, E18(10_000));
    await dai.mint(user.address, E18(10_000));
    await eurc.mint(user.address, E6(10_000));
  });

  // Helpers -----------------------------------------------------------------

  async function depositToken(token: MockERC20, amount: bigint) {
    await token.connect(user).approve(vaultAddress, amount);
    await vault.connect(user).depositToken(await token.getAddress(), amount);
  }

  function parseDecryptionReady(receipt: any): { requestId: bigint; handles: string[] } | null {
    for (const log of receipt.logs) {
      try {
        const parsed = vault.interface.parseLog(log);
        if (parsed && parsed.name === "DecryptionReady") {
          return { requestId: parsed.args.requestId, handles: [...parsed.args.handles] };
        }
      } catch {}
    }
    return null;
  }

  /** Full self-relay withdrawal roundtrip; returns the callback tx receipt */
  async function withdraw(token: string, amount: bigint) {
    const reqTx = await vault.connect(user).requestWithdrawal(token, amount);
    await reqTx.wait();
    // Stealth exits v2: ids are random and the request event is anonymous —
    // read the caller-scoped list instead
    const ids = await vault.connect(user).getMyWithdrawalRequestIds();
    const requestId = ids[ids.length - 1];

    const execTx = await vault.connect(user).requestWithdrawalExecution(requestId);
    const execReceipt = await execTx.wait();
    const decEvent = parseDecryptionReady(execReceipt);
    expect(decEvent).to.not.be.null;

    const dec = await fhevm.publicDecrypt(decEvent!.handles);
    const cbTx = await vault
      .connect(user)
      .executeWithdrawalCallback(requestId, dec.abiEncodedClearValues, dec.decryptionProof);
    return { requestId, receipt: await cbTx.wait() };
  }

  // Registry ------------------------------------------------------------------

  describe("token registry", function () {
    it("rejects deposits of unregistered tokens", async function () {
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const rogue = await MockERC20Factory.deploy("Rogue", "RGE", 18);
      await rogue.mint(user.address, E18(10));
      await rogue.connect(user).approve(vaultAddress, E18(10));

      // staticCall: the fhevm mock provider masks reverts surfaced via
      // eth_sendTransaction with an internal assertion; eth_call is unaffected
      await expect(
        vault.connect(user).depositToken.staticCall(await rogue.getAddress(), E18(10))
      ).to.be.revertedWithCustomError(vault, "TokenNotSupported");
    });

    it("only owner can configure tokens", async function () {
      await expect(
        vault.connect(user).configureToken(await wbtc.getAddress(), 8, 1n, 2n, 1n, 1n)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("disabling a token blocks new deposits, re-enabling restores them", async function () {
      const wbtcAddr = await wbtc.getAddress();
      await vault.setTokenEnabled(wbtcAddr, false);
      await wbtc.connect(user).approve(vaultAddress, WBTC(1));
      await expect(
        vault.connect(user).depositToken.staticCall(wbtcAddr, WBTC(1))
      ).to.be.revertedWithCustomError(vault, "TokenNotSupported");

      await vault.setTokenEnabled(wbtcAddr, true);
      await expect(vault.connect(user).depositToken(wbtcAddr, WBTC(1))).to.emit(vault, "Deposited");
    });

    it("lists all registered tokens", async function () {
      const tokens = await vault.getSupportedTokens();
      expect(tokens.length).to.equal(5);
      expect(tokens).to.include(NATIVE);
      expect(tokens).to.include(await wbtc.getAddress());
    });
  });

  // Deposits ------------------------------------------------------------------

  describe("multi-token deposits", function () {
    it("accepts ETH and 4 ERC-20 tokens with different decimals", async function () {
      await vault.connect(user).depositETH({ value: E18(1) });
      await depositToken(wbtc, WBTC(1));
      await depositToken(link, E18(100));
      await depositToken(dai, E18(500));
      await depositToken(eurc, E6(250));

      expect(await ethers.provider.getBalance(vaultAddress)).to.equal(E18(1));
      expect(await wbtc.balanceOf(vaultAddress)).to.equal(WBTC(1));
      expect(await link.balanceOf(vaultAddress)).to.equal(E18(100));
      expect(await dai.balanceOf(vaultAddress)).to.equal(E18(500));
      expect(await eurc.balanceOf(vaultAddress)).to.equal(E6(250));

      expect(await vault.hasUserDeposited(user.address, NATIVE)).to.be.true;
      expect(await vault.hasUserDeposited(user.address, await wbtc.getAddress())).to.be.true;
      expect(await vault.hasUserDeposited(user.address, await eurc.getAddress())).to.be.true;
      // Never deposited by `other`
      expect(await vault.hasUserDeposited(other.address, NATIVE)).to.be.false;
    });

    it("enforces per-token min/max deposit limits", async function () {
      const wbtcAddr = await wbtc.getAddress();
      await wbtc.connect(user).approve(vaultAddress, WBTC(200));

      await expect(
        vault.connect(user).depositToken(wbtcAddr, WBTC(0.00001))
      ).to.be.revertedWithCustomError(vault, "BelowMinimumDeposit");
      await expect(
        vault.connect(user).depositToken(wbtcAddr, WBTC(101))
      ).to.be.revertedWithCustomError(vault, "ExceedsMaximumDeposit");
    });

    it("rejects fee-on-transfer tokens charging more than 1%", async function () {
      const FeeTokenFactory = await ethers.getContractFactory("MockFeeOnTransferToken");
      const feeToken = await FeeTokenFactory.deploy("Fee Token", "FEE", 18);
      const feeTokenAddr = await feeToken.getAddress();

      await vault.configureToken(feeTokenAddr, 18, E18(1), E18(1000), E18(1000), E18(10000));
      await feeToken.mint(user.address, E18(100));
      await feeToken.connect(user).approve(vaultAddress, E18(100));

      // 2% fee -> reject
      await feeToken.setFeesEnabled(true);
      await feeToken.setFeePercentage(200);
      await expect(
        vault.connect(user).depositToken(feeTokenAddr, E18(50))
      ).to.be.revertedWithCustomError(vault, "ExcessiveTransferFee");

      // 0.5% fee -> accepted, credits what actually arrived
      await feeToken.setFeePercentage(50);
      await expect(vault.connect(user).depositToken(feeTokenAddr, E18(50)))
        .to.emit(vault, "TransferFeeDetected");
    });
  });

  // VaultId privacy -------------------------------------------------------------

  describe("pseudo-random vaultIds", function () {
    it("assigns non-sequential, stable, distinct vaultIds", async function () {
      await vault.connect(user).depositETH({ value: E18(1) });
      await vault.connect(other).depositETH({ value: E18(1) });

      const idUser = await vault.connect(user).getMyVaultId();
      const idOther = await vault.connect(other).getMyVaultId();

      expect(idUser).to.not.equal(0n);
      expect(idOther).to.not.equal(0n);
      expect(idUser).to.not.equal(idOther);
      // PRIVACY: sequential ids (1, 2, 3…) would let observers rebuild the
      // vaultId<->address table from public first-deposit ordering
      expect(idUser > 1_000_000n || idOther > 1_000_000n).to.be.true;
      expect(idOther - idUser).to.not.equal(1n);

      // Stable across subsequent deposits
      await vault.connect(user).depositETH({ value: E18(1) });
      expect(await vault.connect(user).getMyVaultId()).to.equal(idUser);
    });
  });

  // Withdrawals ---------------------------------------------------------------

  describe("multi-token withdrawals (self-relay roundtrip)", function () {
    it("withdraws WBTC end-to-end (8 decimals, direct ERC-20 payout)", async function () {
      await depositToken(wbtc, WBTC(2));
      const before = await wbtc.balanceOf(user.address);

      const { requestId, receipt } = await withdraw(await wbtc.getAddress(), WBTC(1.5));

      const after = await wbtc.balanceOf(user.address);
      expect(after - before).to.equal(WBTC(1.5));

      const request = await vault.getWithdrawalRequest(requestId);
      expect(request.executed).to.be.true;
      expect(receipt!.status).to.equal(1);
    });

    it("withdraws EURC end-to-end (6 decimals)", async function () {
      await depositToken(eurc, E6(1000));
      const before = await eurc.balanceOf(user.address);

      await withdraw(await eurc.getAddress(), E6(750));

      expect((await eurc.balanceOf(user.address)) - before).to.equal(E6(750));
    });

    it("withdraws ETH via the claimETH pull pattern", async function () {
      await vault.connect(user).depositETH({ value: E18(1) });

      await withdraw(NATIVE, E18(0.4));

      const claimable = await vault.connect(user).getMyClaimableETH();
      expect(claimable).to.equal(E18(0.4));

      const before = await ethers.provider.getBalance(user.address);
      const tx = await vault.connect(user).claimETH();
      const rc = await tx.wait();
      const gasCost = rc!.gasUsed * rc!.gasPrice;
      const after = await ethers.provider.getBalance(user.address);
      expect(after - before + gasCost).to.equal(E18(0.4));
    });

    it("balances are isolated per token: WBTC withdrawal leaves LINK intact", async function () {
      await depositToken(wbtc, WBTC(1));
      await depositToken(link, E18(100));

      await withdraw(await wbtc.getAddress(), WBTC(1));

      // LINK still fully withdrawable
      const before = await link.balanceOf(user.address);
      await withdraw(await link.getAddress(), E18(100));
      expect((await link.balanceOf(user.address)) - before).to.equal(E18(100));
    });

    it("over-balance withdrawal is gated: no payout, original balance preserved", async function () {
      // Another depositor funds the vault so the contract-balance defense layer
      // does not mask the user-balance sufficiency path under test
      await wbtc.mint(other.address, WBTC(10));
      await wbtc.connect(other).approve(vaultAddress, WBTC(10));
      await vault.connect(other).depositToken(await wbtc.getAddress(), WBTC(10));

      await depositToken(wbtc, WBTC(1));
      const before = await wbtc.balanceOf(user.address);

      // Request 5 WBTC with only 1 deposited: debit is gated to 0 by FHE.select
      const { receipt } = await withdraw(await wbtc.getAddress(), WBTC(5));

      // Callback executed as a graceful failure (no revert, no transfer)
      const failed = receipt!.logs.some((log: any) => {
        try {
          const parsed = vault.interface.parseLog(log);
          return parsed?.name === "WithdrawalExecutionFailed";
        } catch {
          return false;
        }
      });
      expect(failed).to.be.true;
      expect(await wbtc.balanceOf(user.address)).to.equal(before);

      // The full original balance is still withdrawable — proves no debit happened
      await withdraw(await wbtc.getAddress(), WBTC(1));
      expect((await wbtc.balanceOf(user.address)) - before).to.equal(WBTC(1));
    });

    it("enforces per-token maxWithdrawal at request time", async function () {
      await depositToken(wbtc, WBTC(1));
      await expect(
        vault.connect(user).requestWithdrawal(await wbtc.getAddress(), WBTC(101))
      ).to.be.revertedWithCustomError(vault, "ExceedsMaximumWithdrawal");
    });

    it("caps pending withdrawals per user (8 — shredding capacity)", async function () {
      await depositToken(wbtc, WBTC(9));
      const cap = await vault.MAX_PENDING_WITHDRAWALS_PER_USER();
      for (let i = 0n; i < cap; i++) {
        await vault.connect(user).requestWithdrawal(await wbtc.getAddress(), WBTC(1));
      }
      await expect(
        vault.connect(user).requestWithdrawal(await wbtc.getAddress(), WBTC(1))
      ).to.be.revertedWithCustomError(vault, "TooManyPendingWithdrawals");
    });
  });

  describe("withdrawal cancellation", function () {
    it("cancel before execution refunds the gated debit", async function () {
      await depositToken(dai, E18(500));
      const daiAddr = await dai.getAddress();

      await vault.connect(user).requestWithdrawal(daiAddr, E18(300));
      const ids = await vault.connect(user).getMyWithdrawalRequestIds();
      const requestId = ids[ids.length - 1];

      // Immediate cancel allowed before decryption starts
      await expect(vault.connect(user).cancelWithdrawal(requestId))
        .to.emit(vault, "WithdrawalCancelled");

      // Full balance restored — the entire 500 DAI is withdrawable again
      const before = await dai.balanceOf(user.address);
      await withdraw(daiAddr, E18(500));
      expect((await dai.balanceOf(user.address)) - before).to.equal(E18(500));
    });

    it("only the requester can cancel", async function () {
      await depositToken(dai, E18(100));
      await vault.connect(user).requestWithdrawal(await dai.getAddress(), E18(50));
      const ids = await vault.connect(user).getMyWithdrawalRequestIds();
      const requestId = ids[ids.length - 1];

      await expect(
        vault.connect(other).cancelWithdrawal(requestId)
      ).to.be.revertedWithCustomError(vault, "NotWithdrawalRequester");
    });
  });

  // Circuit breaker -------------------------------------------------------------

  describe("per-token circuit breaker", function () {
    it("auto-pauses when a token's 24h withdrawal limit is exceeded", async function () {
      // Tiny daily limit for LINK: 10 LINK
      const linkAddr = await link.getAddress();
      await vault.configureToken(linkAddr, 18, E18(1), E18(1_000_000), E18(1_000_000), E18(10));
      await depositToken(link, E18(100));

      // First withdrawal (8 LINK) passes
      await withdraw(linkAddr, E18(8));

      // Second withdrawal (8 LINK) exceeds the 10 LINK daily cap -> pause + pending
      const reqTx = await vault.connect(user).requestWithdrawal(linkAddr, E18(8));
      await reqTx.wait();
      const ids = await vault.connect(user).getMyWithdrawalRequestIds();
      const requestId = ids[ids.length - 1];
      const execTx = await vault.connect(user).requestWithdrawalExecution(requestId);
      const decEvent = parseDecryptionReady(await execTx.wait());
      const dec = await fhevm.publicDecrypt(decEvent!.handles);

      const before = await link.balanceOf(user.address);
      await expect(
        vault
          .connect(user)
          .executeWithdrawalCallback(requestId, dec.abiEncodedClearValues, dec.decryptionProof)
      ).to.emit(vault, "CircuitBreakerTriggered");

      // Protocol paused (V1 bug fixed: the pause used to be reverted away), no payout,
      // and the request stays pending for a retry after unpause
      expect(await vault.paused()).to.be.true;
      expect(await link.balanceOf(user.address)).to.equal(before);
      const request = await vault.getWithdrawalRequest(requestId);
      expect(request.executed).to.be.false;
    });
  });

  // Sizing ------------------------------------------------------------------------

  describe("deployability", function () {
    it("stays under the EIP-170 runtime-code limit", async function () {
      const fs = await import("fs");
      const path = await import("path");
      const artifactPath = path.join(
        __dirname,
        "../../artifacts/contracts/v2/NoctisVaultV2.sol/NoctisVaultV2.json"
      );
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      const size = (artifact.deployedBytecode.length - 2) / 2;
      expect(size).to.be.lessThan(24_576);
    });
  });
});
