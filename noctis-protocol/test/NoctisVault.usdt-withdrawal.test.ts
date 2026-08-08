/**
 * @file NoctisVault USDT Withdrawal Test
 * @description Quick test to verify USDT withdrawals work correctly
 */

import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import * as hre from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { NoctisVault } from "../typechain-types";
import { TEST_CONSTANTS } from "./constants";

describe("NoctisVault - USDT Withdrawal Flow", function () {
  let vault: NoctisVault;
  let usdt: any;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let keeper: HardhatEthersSigner;

  before(async function () {
    if (!hre.fhevm.isMock) {
      throw new Error("This test requires FHEVM mock mode");
    }
  });

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    user = signers[1];
    keeper = signers[2];

    // Deploy MockERC20 for USDT
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdt = await MockERC20.deploy("Mock USDT", "USDT", 6);
    const usdtAddress = await usdt.getAddress();

    // Deploy NoctisVault
    const NoctisVaultFactory = await ethers.getContractFactory("NoctisVault");
    vault = await NoctisVaultFactory.deploy(owner.address, usdtAddress) as NoctisVault;

    // Initialize keeper
    await vault.initializeKeepers([keeper.address], 1);

    // Mint and approve USDT for user
    await usdt.mint(user.address, TEST_CONSTANTS.USDT.MINT_AMOUNT);
    await usdt.connect(user).approve(await vault.getAddress(), TEST_CONSTANTS.USDT.MINT_AMOUNT);
  });

  it("should complete full USDT withdrawal flow", async function () {
    console.log("\n📝 Test: USDT Withdrawal Flow\n");

    // STEP 1: User deposits USDT
    const depositAmount = TEST_CONSTANTS.USDT.DEPOSIT_MEDIUM; // 1000 USDT
    console.log(`1️⃣  User deposits ${ethers.formatUnits(depositAmount, 6)} USDT...`);
    
    await vault.connect(user).depositUSDT(depositAmount);
    console.log("   ✅ Deposit successful");

    // STEP 2: User requests USDT withdrawal
    const withdrawAmount = TEST_CONSTANTS.USDT.WITHDRAWAL_SMALL; // 500 USDT
    console.log(`\n2️⃣  User requests withdrawal of ${ethers.formatUnits(withdrawAmount, 6)} USDT...`);

    const withdrawTx = await vault.connect(user).requestEncryptedWithdrawal(
      user.address,
      withdrawAmount,
      false // isEth = false for USDT
    );
    await withdrawTx.wait();
    
    const requestId = await vault.withdrawalCounter();
    console.log(`   ✅ Withdrawal request #${requestId} created`);

    // STEP 3: User triggers execution (privacy-first flow)
    console.log(`\n3️⃣  User triggers requestWithdrawalExecution...`);
    
    const execTx = await vault.connect(user).requestWithdrawalExecution(requestId);
    const execReceipt = await execTx.wait();
    
    // Parse DecryptionReady event
    let handles: string[] = [];
    for (const log of execReceipt!.logs) {
      try {
        const parsed = vault.interface.parseLog(log);
        if (parsed && parsed.name === "DecryptionReady") {
          handles = parsed.args.handles;
          break;
        }
      } catch {}
    }
    
    // 2 handles: amount + hasSufficientBalance (privacy-first: only reveals true/false)
    expect(handles.length).to.equal(2);
    console.log(`   ✅ DecryptionReady event emitted`);

    // STEP 4: Decrypt via mock
    console.log(`\n4️⃣  Relayer decrypts values (mock mode)...`);
    
    const publicDecryptResults = await fhevm.publicDecrypt(handles);
    console.log(`   ✅ Decryption successful`);

    // STEP 5: Execute callback
    console.log(`\n5️⃣  Keeper calls executeWithdrawalCallback...`);
    
    const userUsdtBalanceBefore = await usdt.balanceOf(user.address);
    
    const callbackTx = await vault.connect(keeper).executeWithdrawalCallback(
      requestId,
      publicDecryptResults.abiEncodedClearValues,
      publicDecryptResults.decryptionProof
    );
    await callbackTx.wait();
    
    console.log(`   ✅ Callback executed`);

    // STEP 6: Verify results
    console.log(`\n6️⃣  Verifying results...`);
    
    const request = await vault.withdrawalRequests(requestId);
    expect(request.executed).to.be.true;
    console.log(`   ✅ Request marked as executed`);
    
    // Check user received USDT
    const userUsdtBalanceAfter = await usdt.balanceOf(user.address);
    const received = userUsdtBalanceAfter - userUsdtBalanceBefore;
    expect(received).to.equal(withdrawAmount);
    console.log(`   ✅ User received: ${ethers.formatUnits(received, 6)} USDT`);
    
    console.log(`\n🎉 USDT WITHDRAWAL FLOW COMPLETE!\n`);
  });
});
