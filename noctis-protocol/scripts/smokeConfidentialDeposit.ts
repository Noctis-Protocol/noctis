/**
 * E2E smoke — confidential USDC deposit (V2.5, Sepolia)
 *
 * 1. approve + wrap 5 USDC -> cUSDC (the only public amount)
 * 2. confidentialTransferAndCall(vault, encAmount) — encrypted end to end
 * 3. verify the anonymous ConfidentialDeposited event fired
 * 4. wait for the keeper to flush the pooled buffer (vault public USDC
 *    reserve grows by the pooled sum) — proves the whole loop
 *
 * Usage: SKIP_FHEVM=1 npx hardhat run scripts/smokeConfidentialDeposit.ts --network sepolia
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const AMOUNT = 5_000_000n; // 5 USDC (6 decimals)

async function main() {
  const ssot = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.v2.json`), "utf8")
  );
  const vaultAddress = ssot.contracts.NoctisVaultV2;
  const usdcAddress = ssot.contracts.USDC;
  const wrapperAddress = ssot.contracts.ConfidentialUSDC;
  if (!wrapperAddress) throw new Error("SSOT missing contracts.ConfidentialUSDC");

  const [user] = await ethers.getSigners();
  console.log(`User:    ${user.address}`);
  console.log(`Vault:   ${vaultAddress}`);
  console.log(`cUSDC:   ${wrapperAddress}`);

  const usdc = await ethers.getContractAt(
    ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function mint(address,uint256)"],
    usdcAddress
  );
  const wrapper = await ethers.getContractAt("NoctisConfidentialToken", wrapperAddress);
  const vault = await ethers.getContractAt("NoctisVaultV2", vaultAddress);

  const userUsdc = await usdc.balanceOf(user.address);
  if (userUsdc < AMOUNT) {
    console.log("Minting test USDC...");
    await (await usdc.mint(user.address, AMOUNT * 2n)).wait();
  }

  const reserveBefore: bigint = await usdc.balanceOf(vaultAddress);
  console.log(`\nVault public USDC reserve before: ${ethers.formatUnits(reserveBefore, 6)}`);

  console.log("1) approve + wrap 5 USDC -> cUSDC ...");
  await (await usdc.approve(wrapperAddress, AMOUNT)).wait();
  await (await wrapper.wrap(user.address, AMOUNT)).wait();
  console.log("   wrapped ✅");

  console.log("2) encrypting amount (relayer SDK) ...");
  const sdk: any = await import("@zama-fhe/relayer-sdk/node");
  const cfg = sdk.SepoliaConfigV2 || sdk.SepoliaConfig;
  const instance = await sdk.createInstance({
    ...cfg,
    network: process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
  });
  const input = instance.createEncryptedInput(wrapperAddress, user.address);
  input.add64(AMOUNT);
  const { handles, inputProof } = await input.encrypt();
  console.log("   encrypted ✅ (amount is now an opaque handle)");

  console.log("3) confidentialTransferAndCall -> vault ...");
  const tx = await wrapper["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
    vaultAddress,
    handles[0],
    inputProof,
    "0x"
  );
  const receipt = await tx.wait();
  const sawEvent = receipt!.logs.some((log) => {
    try {
      return vault.interface.parseLog(log)?.name === "ConfidentialDeposited";
    } catch {
      return false;
    }
  });
  console.log(`   deposit tx: ${tx.hash}`);
  console.log(`   ConfidentialDeposited (anonymous) event: ${sawEvent ? "✅" : "❌"}`);
  if (!sawEvent) throw new Error("vault hook did not fire");

  console.log("4) waiting for the keeper to flush the pooled buffer (max ~5 min) ...");
  const deadline = Date.now() + 5 * 60_000;
  let reserveAfter = reserveBefore;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20_000));
    reserveAfter = await usdc.balanceOf(vaultAddress);
    if (reserveAfter > reserveBefore) break;
    process.stdout.write(".");
  }
  console.log();
  if (reserveAfter > reserveBefore) {
    console.log(
      `   flushed ✅ — vault reserve +${ethers.formatUnits(reserveAfter - reserveBefore, 6)} USDC (pooled sum only)`
    );
    console.log("\n✨ Confidential deposit smoke PASSED");
  } else {
    console.log("   keeper flush not observed within the window — check keeper logs");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
