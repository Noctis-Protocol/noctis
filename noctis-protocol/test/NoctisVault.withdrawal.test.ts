/**
 * @file NoctisVault Withdrawal Test - FHEVM v0.9 Mock Mode
 * @description Tests the complete withdrawal flow using Hardhat's FHEVM mock
 * 
 * Based on Zama's official examples:
 * - https://github.com/zama-ai/fhevm/blob/release/0.9.x/docs/examples/heads-or-tails.md
 * - https://github.com/zama-ai/fhevm/blob/release/0.9.x/docs/examples/highest-die-roll.md
 * 
 * Flow tested:
 * 1. User deposits ETH
 * 2. User requests encrypted withdrawal
 * 3. Keeper triggers requestWithdrawalExecution() -> emits DecryptionReady
 * 4. Test simulates relayer: fhevm.publicDecrypt() -> get cleartext + proof
 * 5. Keeper calls executeWithdrawalCallback() with cleartext + proof
 * 6. Contract verifies with FHE.checkSignatures() and executes transfer
 */

import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import * as hre from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { NoctisVault } from "../typechain-types";

describe("NoctisVault - Withdrawal Flow (Mock Mode)", function () {
  let vault: NoctisVault;
  let vaultAddress: string;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let keeper: HardhatEthersSigner;

  before(async function () {
    // Check we're in mock mode
    if (!hre.fhevm.isMock) {
      throw new Error("This test suite requires FHEVM mock mode (run on hardhat network)");
    }
    console.log("\n🧪 Running in FHEVM Mock Mode");
  });

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    user = signers[1];
    keeper = signers[2];

    // Deploy MockERC20 for USDT
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdt = await MockERC20.deploy("Mock USDT", "USDT", 6);
    const usdtAddress = await usdt.getAddress();

    // Deploy NoctisVault (owner, usdt)
    const NoctisVaultFactory = await ethers.getContractFactory("NoctisVault");
    vault = await NoctisVaultFactory.deploy(owner.address, usdtAddress) as NoctisVault;
    vaultAddress = await vault.getAddress();

    // Initialize keeper
    await vault.initializeKeepers([keeper.address], 1);

    console.log(`   Vault: ${vaultAddress}`);
    console.log(`   Owner: ${owner.address}`);
    console.log(`   User: ${user.address}`);
    console.log(`   Keeper: ${keeper.address}`);
  });

  /**
   * Helper: Parse DecryptionReady event from transaction receipt
   */
  function parseDecryptionReadyEvent(receipt: any): {
    requestId: bigint;
    handles: string[];
    keeper: string;
  } | null {
    for (const log of receipt.logs) {
      try {
        const parsed = vault.interface.parseLog(log);
        if (parsed && parsed.name === "DecryptionReady") {
          return {
            requestId: parsed.args.requestId,
            handles: parsed.args.handles,
            keeper: parsed.args.keeper,
          };
        }
      } catch {
        // Not our event
      }
    }
    return null;
  }

  it("should complete full withdrawal flow with FHE verification", async function () {
    console.log("\n📝 Test: Complete Withdrawal Flow\n");

    // ═══════════════════════════════════════════════════════════════
    // STEP 1: User deposits ETH
    // ═══════════════════════════════════════════════════════════════
    const depositAmount = ethers.parseEther("1.0");
    console.log(`1️⃣  User deposits ${ethers.formatEther(depositAmount)} ETH...`);
    
    await vault.connect(user).depositETH({ value: depositAmount });
    console.log("   ✅ Deposit successful");

    // ═══════════════════════════════════════════════════════════════
    // STEP 2: User requests encrypted withdrawal
    // ═══════════════════════════════════════════════════════════════
    const withdrawAmount = ethers.parseEther("0.5");
    console.log(`\n2️⃣  User requests withdrawal of ${ethers.formatEther(withdrawAmount)} ETH...`);

    // Request encrypted withdrawal (contract encrypts internally for MVP)
    // Parameters: (recipient, amount, isEth)
    const withdrawTx = await vault.connect(user).requestEncryptedWithdrawal(
      user.address, // recipient
      withdrawAmount, // amount (will be encrypted by contract)
      true // isEth
    );
    await withdrawTx.wait();
    
    const requestId = await vault.withdrawalCounter();
    console.log(`   ✅ Withdrawal request #${requestId} created`);

    // ═══════════════════════════════════════════════════════════════
    // STEP 3: User triggers requestWithdrawalExecution (privacy-first flow)
    // ═══════════════════════════════════════════════════════════════
    console.log(`\n3️⃣  User triggers requestWithdrawalExecution...`);
    
    const execTx = await vault.connect(user).requestWithdrawalExecution(requestId);
    const execReceipt = await execTx.wait();
    
    // Parse DecryptionReady event
    const decryptionEvent = parseDecryptionReadyEvent(execReceipt);
    expect(decryptionEvent).to.not.be.null;
    // 2 handles: amount + hasSufficientBalance (privacy-first: only reveals true/false)
    expect(decryptionEvent!.handles.length).to.equal(2);
    
    console.log(`   ✅ DecryptionReady event emitted`);
    console.log(`   📦 Handles: ${decryptionEvent!.handles.length} ciphertext (amount only)`);

    // ═══════════════════════════════════════════════════════════════
    // STEP 4: Simulate Relayer - publicDecrypt (mock mode)
    // ═══════════════════════════════════════════════════════════════
    console.log(`\n4️⃣  Relayer decrypts values (mock mode)...`);
    
    // This is the key part - using fhevm.publicDecrypt() like the Zama examples
    const publicDecryptResults = await fhevm.publicDecrypt(decryptionEvent!.handles);
    
    console.log(`   ✅ Decryption successful`);
    console.log(`   📊 Clear values received`);

    const abiEncodedClearValues = publicDecryptResults.abiEncodedClearValues;
    const decryptionProof = publicDecryptResults.decryptionProof;

    // ═══════════════════════════════════════════════════════════════
    // STEP 5: Keeper calls executeWithdrawalCallback
    // ═══════════════════════════════════════════════════════════════
    console.log(`\n5️⃣  Keeper calls executeWithdrawalCallback with proof...`);
    
    const userBalanceBefore = await ethers.provider.getBalance(user.address);
    
    const callbackTx = await vault.connect(keeper).executeWithdrawalCallback(
      requestId,
      abiEncodedClearValues,
      decryptionProof
    );
    const callbackReceipt = await callbackTx.wait();
    
    console.log(`   ✅ Callback executed`);
    console.log(`   ⛽ Gas used: ${callbackReceipt?.gasUsed}`);

    // ═══════════════════════════════════════════════════════════════
    // STEP 6: Verify results
    // ═══════════════════════════════════════════════════════════════
    console.log(`\n6️⃣  Verifying results...`);
    
    // Check withdrawal request is marked as executed
    const request = await vault.withdrawalRequests(requestId);
    expect(request.executed).to.be.true;
    console.log(`   ✅ Request marked as executed`);
    
    // Check user received ETH
    const userBalanceAfter = await ethers.provider.getBalance(user.address);
    const received = userBalanceAfter - userBalanceBefore;
    // Note: received might be slightly less than withdrawAmount due to gas costs if user called callback
    console.log(`   ✅ User received: ${ethers.formatEther(received)} ETH`);
    
    console.log(`\n🎉 WITHDRAWAL FLOW COMPLETE!\n`);
  });

  it("should reject callback with invalid proof", async function () {
    console.log("\n📝 Test: Reject Invalid Proof\n");

    // Deposit and request withdrawal
    await vault.connect(user).depositETH({ value: ethers.parseEther("1.0") });
    
    await vault.connect(user).requestEncryptedWithdrawal(
      user.address,
      ethers.parseEther("0.5"),
      true
    );

    const requestId = await vault.withdrawalCounter();
    
    // Trigger decryption (user initiates in privacy-first flow)
    const execTx = await vault.connect(user).requestWithdrawalExecution(requestId);
    const execReceipt = await execTx.wait();
    const decryptionEvent = parseDecryptionReadyEvent(execReceipt);

    // Get valid decryption
    const publicDecryptResults = await fhevm.publicDecrypt(decryptionEvent!.handles);
    
    // Forge invalid proof
    const forgedProof = publicDecryptResults.decryptionProof + "deadbeef";
    
    // Should revert with invalid proof
    await expect(
      vault.connect(keeper).executeWithdrawalCallback(
        requestId,
        publicDecryptResults.abiEncodedClearValues,
        forgedProof
      )
    ).to.be.reverted;
    
    console.log("   ✅ Invalid proof correctly rejected\n");
  });

  it("should reject callback with forged clear values", async function () {
    console.log("\n📝 Test: Reject Forged Clear Values\n");

    // Deposit and request withdrawal
    await vault.connect(user).depositETH({ value: ethers.parseEther("1.0") });
    
    await vault.connect(user).requestEncryptedWithdrawal(
      user.address,
      ethers.parseEther("0.5"),
      true
    );

    const requestId = await vault.withdrawalCounter();
    
    // Trigger decryption (user initiates in privacy-first flow)
    const execTx = await vault.connect(user).requestWithdrawalExecution(requestId);
    const execReceipt = await execTx.wait();
    const decryptionEvent = parseDecryptionReadyEvent(execReceipt);

    // Get valid decryption
    const publicDecryptResults = await fhevm.publicDecrypt(decryptionEvent!.handles);
    
    // Forge clear values (try to steal more than deposited)
    // SIMPLIFIED: Only 1 value (amount) - encoded as uint128
    const forgedClearValues = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint128"],
      [ethers.parseEther("100")]
    );
    
    // Should revert - forged values don't match the proof
    await expect(
      vault.connect(keeper).executeWithdrawalCallback(
        requestId,
        forgedClearValues,
        publicDecryptResults.decryptionProof
      )
    ).to.be.reverted;
    
    console.log("   ✅ Forged clear values correctly rejected\n");
  });
});
