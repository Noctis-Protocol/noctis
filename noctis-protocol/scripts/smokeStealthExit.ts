import { ethers } from "hardhat";

/**
 * PRIVACY (Year 2) E2E smoke — stealth exit on Sepolia:
 *   deposit ETH -> requestWithdrawalPrivate with CLIENT-SIDE encrypted
 *   (amount, recipient) -> wait out the batch window -> execute -> verify the
 *   fresh recipient address received the ETH directly (push, no claim tx).
 *
 * The payout destination never appears in calldata before the payout itself.
 *
 *   npx hardhat run scripts/smokeStealthExit.ts --network sepolia
 */

const DEPOSIT_ETH = "0.005";
const WITHDRAW_ETH = "0.002";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [user] = await ethers.getSigners();
  const ssot = require("../deployments/sepolia.v2.json");
  const vault = await ethers.getContractAt("NoctisVaultV2", ssot.contracts.NoctisVaultV2);
  const vaultAddress = ssot.contracts.NoctisVaultV2;

  // Fresh, never-funded recipient — the whole point of the stealth exit
  const stealth = ethers.Wallet.createRandom().address;
  console.log("user:", user.address);
  console.log("stealth recipient:", stealth);
  console.log("recipient balance before:", ethers.formatEther(await ethers.provider.getBalance(stealth)), "ETH");

  // 1. Deposit
  const dep = await vault.depositETH({ value: ethers.parseEther(DEPOSIT_ETH) });
  await dep.wait();
  console.log(`deposited ${DEPOSIT_ETH} ETH, tx:`, dep.hash);

  // 2. Encrypt (amount, recipient) client-side — proof binds to (vault, user)
  const sdk: any = await import("@zama-fhe/relayer-sdk/node");
  const cfg = sdk.SepoliaConfigV2 || sdk.SepoliaConfig;
  const instance = await sdk.createInstance({
    ...cfg,
    network: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
  });
  const toHex = (b: Uint8Array) =>
    "0x" + Array.from(b, (x: number) => x.toString(16).padStart(2, "0")).join("");

  const amount = ethers.parseEther(WITHDRAW_ETH);
  const encInput = instance.createEncryptedInput(vaultAddress, user.address);
  encInput.add128(amount);
  encInput.addAddress(stealth);
  const enc = await encInput.encrypt();
  console.log("encrypted recipient handle:", toHex(enc.handles[1]));

  // 3. Request the private withdrawal
  const reqTx = await vault.requestWithdrawalPrivate(
    ethers.ZeroAddress,
    toHex(enc.handles[0]),
    toHex(enc.handles[1]),
    toHex(enc.inputProof),
    { gasLimit: 3_000_000 }
  );
  await reqTx.wait();
  const requestId: bigint = await vault.withdrawalCounter();
  console.log("withdrawal requested, id:", requestId.toString(), "tx:", reqTx.hash);

  // 4. Wait out the batch window (claims are quantized to boundaries)
  const windowSec = Number(await vault.withdrawalBatchWindow());
  console.log(`batch window: ${windowSec}s — polling requestWithdrawalExecution...`);
  let handles: string[] = [];
  const deadline = Date.now() + (windowSec + 120) * 1000;
  for (;;) {
    try {
      const tx = await vault.requestWithdrawalExecution(requestId, { gasLimit: 1_500_000 });
      const receipt = await tx.wait();
      for (const log of receipt!.logs) {
        try {
          const parsed = vault.interface.parseLog(log);
          if (parsed?.name === "DecryptionReady") handles = [...parsed.args.handles];
        } catch {}
      }
      break;
    } catch (e: any) {
      if (Date.now() > deadline) throw e;
      const msg = String(e?.message || e);
      if (!msg.includes("WithdrawalBatchPending") && !msg.includes("revert")) throw e;
      process.stdout.write(".");
      await sleep(20_000);
    }
  }
  console.log("\ndecryption handles:", handles);
  if (handles.length !== 3) throw new Error(`expected 3 handles (amount+bool+recipient), got ${handles.length}`);

  // 5. Public decrypt + callback — this is the FIRST moment the destination
  //    becomes visible on-chain.
  const decrypted = await instance.publicDecrypt(handles);
  const execTx = await vault.executeWithdrawalCallback(
    requestId,
    decrypted.abiEncodedClearValues,
    decrypted.decryptionProof,
    { gasLimit: 1_500_000 }
  );
  await execTx.wait();
  console.log("withdrawal executed, tx:", execTx.hash);

  // 6. Verify: fresh address holds the ETH without ever sending a tx
  const balAfter = await ethers.provider.getBalance(stealth);
  console.log("recipient balance after:", ethers.formatEther(balAfter), "ETH");
  if (balAfter !== amount) throw new Error(`stealth recipient balance ${balAfter} != ${amount}`);

  console.log("\nSTEALTH EXIT SMOKE PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
