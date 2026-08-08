import { ethers } from "hardhat";

async function main() {
  const VAULT_ADDRESS = "0xB9dcA86284456300dD71DDc13c21bCa5f12bfB81";
  
  const vault = await ethers.getContractAt("NoctisVault", VAULT_ADDRESS);
  const counter = await vault.withdrawalCounter();
  
  console.log("Checking gatewayRequested status for all withdrawals:\n");
  
  for (let i = 1; i <= Number(counter); i++) {
    const request = await vault.withdrawalRequests(i);
    console.log(`Withdrawal #${i}:`);
    console.log("  gatewayRequested:", request.gatewayRequested);
    console.log("  executed:", request.executed);
    if (request.gatewayRequested) {
      const requestTime = Number(request.gatewayRequestTime);
      const now = Math.floor(Date.now() / 1000);
      const elapsed = now - requestTime;
      const remaining = 3600 - elapsed;
      console.log(`  Time since gateway request: ${elapsed}s`);
      console.log(`  Time until cancellable: ${remaining > 0 ? remaining : 0}s`);
    } else {
      console.log("  → Can be cancelled immediately!");
    }
  }
}

main().catch(console.error);
