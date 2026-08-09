import { ethers } from "hardhat";

/**
 * PRIVACY (stealth exits v2) E2E smoke — keeper-executed stealth exit on Sepolia:
 *   deposit ETH -> requestWithdrawalPrivate with CLIENT-SIDE encrypted
 *   (amount, recipient) -> the KEEPER detects the due request at the batch
 *   window boundary and executes the payout itself -> verify the fresh
 *   recipient address received the ETH directly, with the requester signing
 *   NOTHING after the request.
 *
 * What an observer sees:
 *   - request tx (user): anonymous event, no requestId/requester, encrypted payload
 *   - payout txs (keeper): pseudo-random requestId + recipient — no join key
 *     back to the request tx.
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

  // 3. Request the private withdrawal — the LAST tx the user signs
  const reqTx = await vault.requestWithdrawalPrivate(
    ethers.ZeroAddress,
    toHex(enc.handles[0]),
    toHex(enc.handles[1]),
    toHex(enc.inputProof),
    { gasLimit: 3_000_000 }
  );
  await reqTx.wait();
  // Stealth exits v2: ids are pseudo-random, the request event is anonymous —
  // recover the id via the caller-scoped getter
  const ids: bigint[] = await vault.connect(user).getMyWithdrawalRequestIds();
  const requestId = ids[ids.length - 1];
  console.log("withdrawal requested, id: …" + requestId.toString().slice(-8), "tx:", reqTx.hash);

  // 4. Hands off: the keeper's withdrawal executor picks the request up at
  //    the next batch-window boundary and pays it out from ITS wallet.
  const windowSec = Number(await vault.withdrawalBatchWindow());
  console.log(`batch window: ${windowSec}s — waiting for the KEEPER to execute (user signs nothing)...`);
  const deadline = Date.now() + (windowSec + 420) * 1000;
  for (;;) {
    const req = await vault.getWithdrawalRequest(requestId);
    if (req.executed) break;
    if (Date.now() > deadline) {
      throw new Error("keeper did not execute the withdrawal within the deadline");
    }
    process.stdout.write(".");
    await sleep(20_000);
  }
  console.log("\nkeeper executed the withdrawal");

  // 5. Verify: fresh address holds the ETH without ever sending a tx, and
  //    the requester signed nothing after the request.
  const balAfter = await ethers.provider.getBalance(stealth);
  console.log("recipient balance after:", ethers.formatEther(balAfter), "ETH");
  if (balAfter !== amount) throw new Error(`stealth recipient balance ${balAfter} != ${amount}`);

  console.log("\nKEEPER-EXECUTED STEALTH EXIT SMOKE PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
