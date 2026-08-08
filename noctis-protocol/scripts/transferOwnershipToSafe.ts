/**
 * @notice B1 — Transfer Vault Ownable + Exchange AccessControl admin to Safe.
 * @dev Safe must already be deployed (feeRecipient). Deployer remains Safe owner (1/1)
 *      so admin ops go through Safe.execTransaction, not the EOA directly.
 *
 *   npx hardhat run scripts/transferOwnershipToSafe.ts --network sepolia
 *   npx hardhat run scripts/transferOwnershipToSafe.ts --network mainnet
 *
 * Env:
 *   SAFE_ADDRESS — optional override (defaults to SSOT feeRecipient)
 *   KEEP_EOA_PAUSER=1 — leave PAUSER_ROLE on deployer for emergency (default: revoke)
 */
import { ethers } from "hardhat";
import { loadSsot, saveSsot } from "./lib/ssot";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const { path: ssotPath, data: ssot, network: netName } = loadSsot(
    network.chainId
  );
  const exchangeAddress = ssot.contracts.NoctisExchange as string;
  const vaultAddress = ssot.contracts.NoctisVault as string;
  const safe =
    process.env.SAFE_ADDRESS ||
    (ssot.contracts.feeRecipient as string) ||
    (ssot.ops?.feeRecipientSafe as string);

  if (!safe || !ethers.isAddress(safe)) {
    throw new Error("SAFE_ADDRESS / feeRecipient missing");
  }

  const code = await ethers.provider.getCode(safe);
  if (code === "0x") throw new Error(`Safe has no code: ${safe}`);

  console.log("Network:", netName, `(${network.chainId})`);
  console.log("Deployer EOA:", deployer.address);
  console.log("Safe:", safe);
  console.log("Exchange:", exchangeAddress);
  console.log("Vault:", vaultAddress);

  const exchange = await ethers.getContractAt("NoctisExchange", exchangeAddress);
  const vault = await ethers.getContractAt("NoctisVault", vaultAddress);

  const DEFAULT_ADMIN_ROLE = await exchange.DEFAULT_ADMIN_ROLE();
  const PAUSER_ROLE = await exchange.PAUSER_ROLE();
  const KEEPER_MANAGER_ROLE = await exchange.KEEPER_MANAGER_ROLE();
  const PARAMS_ROLE = await exchange.PARAMS_ROLE();

  const rolesToGrant = [
    ["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN_ROLE],
    ["PAUSER_ROLE", PAUSER_ROLE],
    ["KEEPER_MANAGER_ROLE", KEEPER_MANAGER_ROLE],
    ["PARAMS_ROLE", PARAMS_ROLE],
  ] as const;

  console.log("\n1️⃣ Grant Exchange roles → Safe");
  for (const [name, role] of rolesToGrant) {
    const has = await exchange.hasRole(role, safe);
    if (has) {
      console.log(`   ${name}: already ✅`);
      continue;
    }
    const tx = await exchange.grantRole(role, safe);
    await tx.wait();
    console.log(`   ${name}: granted ✅ ${tx.hash}`);
  }

  console.log("\n2️⃣ Vault transferOwnership → Safe");
  const currentOwner = await vault.owner();
  if (currentOwner.toLowerCase() === safe.toLowerCase()) {
    console.log("   already Safe ✅");
  } else {
    if (currentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(`Vault owner is ${currentOwner}, not deployer — abort`);
    }
    const tx = await vault.transferOwnership(safe);
    await tx.wait();
    console.log("   transferOwnership ✅", tx.hash);
    console.log("   new owner:", await vault.owner());
  }

  const keepPauser = process.env.KEEP_EOA_PAUSER === "1";
  console.log("\n3️⃣ Revoke Exchange roles from deployer EOA");
  for (const [name, role] of rolesToGrant) {
    if (name === "PAUSER_ROLE" && keepPauser) {
      console.log("   PAUSER_ROLE: kept on EOA (KEEP_EOA_PAUSER=1)");
      continue;
    }
    // Revoke DEFAULT_ADMIN last
    if (name === "DEFAULT_ADMIN_ROLE") continue;
    const has = await exchange.hasRole(role, deployer.address);
    if (!has) {
      console.log(`   ${name}: already revoked`);
      continue;
    }
    const tx = await exchange.revokeRole(role, deployer.address);
    await tx.wait();
    console.log(`   ${name}: revoked ✅ ${tx.hash}`);
  }

  // DEFAULT_ADMIN last — after this, only Safe can grant/revoke
  {
    const hasSafe = await exchange.hasRole(DEFAULT_ADMIN_ROLE, safe);
    if (!hasSafe) throw new Error("Abort: Safe missing DEFAULT_ADMIN_ROLE");
    const hasDep = await exchange.hasRole(DEFAULT_ADMIN_ROLE, deployer.address);
    if (hasDep) {
      const tx = await exchange.revokeRole(DEFAULT_ADMIN_ROLE, deployer.address);
      await tx.wait();
      console.log("   DEFAULT_ADMIN_ROLE: revoked from EOA ✅", tx.hash);
    } else {
      console.log("   DEFAULT_ADMIN_ROLE: already revoked from EOA");
    }
  }

  // Verify
  console.log("\n🔍 Verification");
  const vaultOwner = await vault.owner();
  console.log("  vault.owner:", vaultOwner, vaultOwner.toLowerCase() === safe.toLowerCase() ? "✅" : "❌");
  for (const [name, role] of rolesToGrant) {
    const onSafe = await exchange.hasRole(role, safe);
    const onEoa = await exchange.hasRole(role, deployer.address);
    console.log(`  ${name}: Safe=${onSafe ? "✅" : "❌"} EOA=${onEoa ? "still set" : "revoked ✅"}`);
  }

  // Relayer must still work
  const RELAYER_ROLE = await exchange.RELAYER_ROLE();
  const relayer = ssot.ops?.relayer as string;
  if (relayer) {
    console.log(
      "  RELAYER_ROLE(keeper):",
      (await exchange.hasRole(RELAYER_ROLE, relayer)) ? "✅" : "❌"
    );
  }

  ssot.ops = {
    ...(ssot.ops || {}),
    ownerSafe: safe,
    ownershipTransferredAt: new Date().toISOString(),
    note:
      "Vault owner + Exchange DEFAULT_ADMIN/PAUSER/KEEPER_MANAGER/PARAMS = Safe. Admin via Safe UI. Relayer key unchanged.",
  };
  ssot.updatedAt = new Date().toISOString().slice(0, 10);
  ssot.notes =
    "SSOT. feeRecipient + contract ownership = Safe. Relayer is dedicated keystore key. Sync frontend/keeper from this file.";
  saveSsot(ssotPath, ssot);
  console.log("\n📝 Updated", ssotPath);
  console.log(
    `\n✨ B1 done. Admin actions: app.safe.global → ${netName} →`,
    safe
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
