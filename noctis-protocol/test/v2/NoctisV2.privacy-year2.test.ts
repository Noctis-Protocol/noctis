/**
 * @file Year 2 privacy test suite — stealth exits (FHEVM v0.9 mock mode)
 * @description Withdrawals with a client-side encrypted recipient:
 * - the payout destination is an opaque FHE handle until execution
 * - ERC20 payouts land directly on the stealth address
 * - ETH payouts are pushed to the stealth address (fresh EOAs have no gas
 *   to pull), with a claimable fallback if the transfer is rejected
 * - limits/pending counts stay keyed on the requester (no cap evasion)
 * - zero / vault-address recipients fall back to the requester
 */

import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import * as hre from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { NoctisVaultV2, MockERC20 } from "../../typechain-types";

describe("NoctisV2 - Year 2 privacy (stealth exits)", function () {
  let vault: NoctisVaultV2;
  let wbtc: MockERC20;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  let vaultAddress: string;
  let wbtcAddress: string;

  const E8 = (n: number) => BigInt(Math.round(n * 1e8));
  const E18 = (n: number) => ethers.parseEther(n.toString());

  before(async function () {
    if (!hre.fhevm.isMock) {
      throw new Error("This test suite requires FHEVM mock mode (hardhat network)");
    }
  });

  beforeEach(async function () {
    [owner, user, attacker] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    wbtc = (await MockERC20Factory.deploy("Wrapped BTC", "WBTC", 8)) as MockERC20;
    wbtcAddress = await wbtc.getAddress();

    const VaultFactory = await ethers.getContractFactory("NoctisVaultV2");
    vault = (await VaultFactory.deploy(owner.address)) as NoctisVaultV2;
    vaultAddress = await vault.getAddress();

    const NATIVE = ethers.ZeroAddress;
    await vault.configureToken(NATIVE, 18, E18(0.005), E18(100), E18(100), E18(1000));
    await vault.configureToken(wbtcAddress, 8, E8(0.0001), E8(100), E8(100), E8(1000));

    await wbtc.mint(user.address, E8(5));
    await wbtc.connect(user).approve(vaultAddress, E8(5));
    await vault.connect(user).depositToken(wbtcAddress, E8(1));
    await vault.connect(user).depositETH({ value: E18(1) });
  });

  // Helpers -------------------------------------------------------------------

  /** Encrypt (amount, recipient) client-side, exactly like the browser does */
  async function requestStealthWithdrawal(
    token: string,
    amount: bigint,
    recipient: string
  ): Promise<bigint> {
    const enc = await fhevm
      .createEncryptedInput(vaultAddress, user.address)
      .add128(amount)
      .addAddress(recipient)
      .encrypt();
    await vault
      .connect(user)
      .requestWithdrawalPrivate(token, enc.handles[0], enc.handles[1], enc.inputProof);
    // Stealth exits v2: ids are random and the request event is anonymous
    const ids = await vault.connect(user).getMyWithdrawalRequestIds();
    return ids[ids.length - 1];
  }

  async function executeWithdrawal(requestId: bigint) {
    const tx = await vault.connect(user).requestWithdrawalExecution(requestId);
    const receipt = await tx.wait();
    let handles: string[] = [];
    for (const log of receipt!.logs) {
      try {
        const parsed = vault.interface.parseLog(log);
        if (parsed?.name === "DecryptionReady") handles = [...parsed.args.handles];
      } catch {}
    }
    const dec = await fhevm.publicDecrypt(handles);
    // Permissionless callback — proof is the authentication
    await vault
      .connect(user)
      .executeWithdrawalCallback(requestId, dec.abiEncodedClearValues, dec.decryptionProof);
    return handles;
  }

  // Stealth exits -------------------------------------------------------------

  it("pays an ERC20 withdrawal to the stealth recipient, not the requester", async function () {
    const stealth = ethers.Wallet.createRandom().address;

    const requestId = await requestStealthWithdrawal(wbtcAddress, E8(0.25), stealth);
    const handles = await executeWithdrawal(requestId);

    expect(handles.length).to.equal(3); // amount + sufficiency + recipient
    expect(await wbtc.balanceOf(stealth)).to.equal(E8(0.25));
    expect(await wbtc.balanceOf(user.address)).to.equal(E8(4)); // 5 minted - 1 deposited
  });

  it("pushes ETH directly to a fresh stealth EOA (no gas needed to claim)", async function () {
    const stealth = ethers.Wallet.createRandom().address;
    expect(await ethers.provider.getBalance(stealth)).to.equal(0n);

    const requestId = await requestStealthWithdrawal(ethers.ZeroAddress, E18(0.5), stealth);
    await executeWithdrawal(requestId);

    // Direct push — the fresh address holds the ETH without calling claimETH
    expect(await ethers.provider.getBalance(stealth)).to.equal(E18(0.5));
    const reader = vault.connect(ethers.provider) as NoctisVaultV2;
    expect(
      await reader.getMyClaimableETH.staticCall({ from: stealth })
    ).to.equal(0n);
  });

  it("keeps the recipient opaque until execution (handle only, no plaintext)", async function () {
    const stealth = ethers.Wallet.createRandom().address;
    const requestId = await requestStealthWithdrawal(wbtcAddress, E8(0.25), stealth);

    // Struct exposes only the FHE handle; the plaintext address appears nowhere
    const req = await vault.withdrawalRequests(requestId);
    expect(req.encRecipient).to.not.equal(ethers.ZeroHash);
    expect(req.encRecipient.toLowerCase()).to.not.include(
      stealth.toLowerCase().slice(2)
    );
  });

  it("falls back to the requester when the decrypted recipient is address(0)", async function () {
    const requestId = await requestStealthWithdrawal(wbtcAddress, E8(0.25), ethers.ZeroAddress);
    await executeWithdrawal(requestId);
    expect(await wbtc.balanceOf(user.address)).to.equal(E8(4) + E8(0.25));
  });

  it("enforces maxWithdrawal on the requester even with a stealth recipient", async function () {
    const stealth = ethers.Wallet.createRandom().address;
    // maxWithdrawal for WBTC is E8(100); over-request must fail at callback
    const requestId = await requestStealthWithdrawal(wbtcAddress, E8(150), stealth);

    const tx = await vault.connect(user).requestWithdrawalExecution(requestId);
    const receipt = await tx.wait();
    let handles: string[] = [];
    for (const log of receipt!.logs) {
      try {
        const parsed = vault.interface.parseLog(log);
        if (parsed?.name === "DecryptionReady") handles = [...parsed.args.handles];
      } catch {}
    }
    const dec = await fhevm.publicDecrypt(handles);
    await expect(
      vault
        .connect(user)
        .executeWithdrawalCallback.staticCall(requestId, dec.abiEncodedClearValues, dec.decryptionProof)
    ).to.be.revertedWithCustomError(vault, "ExceedsMaximumWithdrawal");
  });

  it("cancel refunds the REQUESTER's balance regardless of the stealth recipient", async function () {
    const stealth = ethers.Wallet.createRandom().address;
    const requestId = await requestStealthWithdrawal(wbtcAddress, E8(0.25), stealth);

    await vault.connect(user).cancelWithdrawal(requestId);

    // Full original balance withdrawable again by the requester
    const secondId = await requestStealthWithdrawal(wbtcAddress, E8(1), user.address);
    await executeWithdrawal(secondId);
    expect(await wbtc.balanceOf(user.address)).to.equal(E8(5));
  });

  // Stealth exits v2: unlink request from payout ------------------------------

  it("assigns pseudo-random, non-sequential request ids", async function () {
    const id1 = await requestStealthWithdrawal(wbtcAddress, E8(0.1), user.address);
    await vault.connect(user).cancelWithdrawal(id1);
    const id2 = await requestStealthWithdrawal(wbtcAddress, E8(0.1), user.address);

    expect(id1).to.not.equal(id2);
    expect(id2).to.not.equal(id1 + 1n); // not a counter
    expect(id1 > 1_000_000n || id2 > 1_000_000n).to.be.true; // keccak-sized draws
  });

  it("emits an anonymous request event (no requestId, no requester)", async function () {
    const enc = await fhevm
      .createEncryptedInput(vaultAddress, user.address)
      .add128(E8(0.1))
      .addAddress(user.address)
      .encrypt();
    const tx = await vault
      .connect(user)
      .requestWithdrawalPrivate(wbtcAddress, enc.handles[0], enc.handles[1], enc.inputProof);
    const receipt = await tx.wait();

    let args: any = null;
    for (const log of receipt!.logs) {
      try {
        const parsed = vault.interface.parseLog(log);
        if (parsed?.name === "WithdrawalRequested") args = parsed.args;
      } catch {}
    }
    expect(args).to.not.be.null;
    // Only (token, timestamp) — nothing joinable to the later payout
    expect(args.length).to.equal(2);
    expect(args[0]).to.equal(wbtcAddress);
  });

  it("lets a third party (keeper) execute a due withdrawal — no requester tx", async function () {
    const stealth = ethers.Wallet.createRandom().address;
    const requestId = await requestStealthWithdrawal(wbtcAddress, E8(0.25), stealth);

    // attacker/keeper — anyone — runs the execution flow
    const tx = await vault.connect(attacker).requestWithdrawalExecution(requestId);
    const receipt = await tx.wait();
    let handles: string[] = [];
    for (const log of receipt!.logs) {
      try {
        const parsed = vault.interface.parseLog(log);
        if (parsed?.name === "DecryptionReady") handles = [...parsed.args.handles];
      } catch {}
    }
    const dec = await fhevm.publicDecrypt(handles);
    await vault
      .connect(attacker)
      .executeWithdrawalCallback(requestId, dec.abiEncodedClearValues, dec.decryptionProof);

    // Payout landed although the requester signed nothing after the request
    expect(await wbtc.balanceOf(stealth)).to.equal(E8(0.25));
  });

  it("getDueWithdrawals tracks the keeper work queue across the window", async function () {
    await vault.setWithdrawalBatchWindow(600);
    const requestId = await requestStealthWithdrawal(wbtcAddress, E8(0.1), user.address);

    // Inside the window: not due yet
    expect(await vault.getDueWithdrawals()).to.deep.equal([]);

    await ethers.provider.send("evm_increaseTime", [600]);
    await ethers.provider.send("evm_mine", []);
    expect(await vault.getDueWithdrawals()).to.deep.equal([requestId]);

    // Executed -> removed from the queue
    await executeWithdrawal(requestId);
    expect(await vault.getDueWithdrawals()).to.deep.equal([]);
  });

  it("cancel removes the request from the due queue", async function () {
    const requestId = await requestStealthWithdrawal(wbtcAddress, E8(0.1), user.address);
    expect(await vault.getDueWithdrawals()).to.deep.equal([requestId]);
    await vault.connect(user).cancelWithdrawal(requestId);
    expect(await vault.getDueWithdrawals()).to.deep.equal([]);
  });

  it("plaintext self-withdrawal path is unchanged (2 handles, claimable ETH)", async function () {
    await vault.connect(user).requestWithdrawal(ethers.ZeroAddress, E18(0.5));
    const ids = await vault.connect(user).getMyWithdrawalRequestIds();
    const requestId = ids[ids.length - 1];
    const handles = await executeWithdrawal(requestId);

    expect(handles.length).to.equal(2);
    // Self path keeps the pull pattern
    expect(await vault.connect(user).getMyClaimableETH()).to.equal(E18(0.5));
  });
});
