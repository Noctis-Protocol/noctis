/**
 * Deploy the ERC-7984 confidential USDC wrapper (cUSDC) and wire it to the
 * V2 vault (V2.5 confidential deposits).
 *
 * - Deploys NoctisConfidentialToken(USDC)
 * - Calls vault.setConfidentialWrapper(wrapper) (underlying must already be
 *   a registered token — run deployV2/configureToken first)
 * - Records the address in deployments/<network>.v2.json (contracts.ConfidentialUSDC)
 *
 * Usage: npx hardhat run scripts/deployConfidentialWrapper.ts --network sepolia
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const ssotPath = path.join(__dirname, "..", "deployments", `${network.name}.v2.json`);
  if (!fs.existsSync(ssotPath)) {
    throw new Error(`V2 SSOT not found: ${ssotPath} — deploy V2 first`);
  }
  const ssot = JSON.parse(fs.readFileSync(ssotPath, "utf8"));
  const vaultAddress: string = ssot.contracts?.NoctisVaultV2;
  const usdcAddress: string = ssot.contracts?.USDC;
  if (!vaultAddress || !usdcAddress) {
    throw new Error("SSOT missing NoctisVaultV2 or USDC address");
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Vault:    ${vaultAddress}`);
  console.log(`USDC:     ${usdcAddress}`);

  console.log("\n1) Deploying NoctisConfidentialToken (cUSDC)...");
  const Factory = await ethers.getContractFactory("NoctisConfidentialToken");
  const wrapper = await Factory.deploy(usdcAddress, "Noctis Confidential USDC", "cUSDC", "");
  await wrapper.waitForDeployment();
  const wrapperAddress = await wrapper.getAddress();
  console.log(`   cUSDC deployed: ${wrapperAddress}`);

  console.log("2) Wiring the vault (setConfidentialWrapper)...");
  const vault = await ethers.getContractAt("NoctisVaultV2", vaultAddress);
  await (await vault.setConfidentialWrapper(wrapperAddress)).wait();
  console.log(`   confidentialWrapper = ${await vault.confidentialWrapper()}`);
  console.log(`   underlying          = ${await vault.confidentialUnderlying()}`);
  console.log(`   rate                = ${await vault.confidentialWrapperRate()}`);

  ssot.contracts.ConfidentialUSDC = wrapperAddress;
  ssot.updatedAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(ssotPath, JSON.stringify(ssot, null, 2) + "\n");
  console.log(`\nSSOT updated: contracts.ConfidentialUSDC = ${wrapperAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
