import { ethers } from "hardhat";

async function main() {
  const VAULT_ADDRESS = "0xB9dcA86284456300dD71DDc13c21bCa5f12bfB81";
  
  const [signer] = await ethers.getSigners();
  console.log("Using account:", signer.address);
  
  const vault = await ethers.getContractAt("NoctisVault", VAULT_ADDRESS);
  
  // Check pending withdrawals
  const counter = await vault.withdrawalCounter();
  console.log("Total withdrawals:", counter.toString());
  
  for (let i = 1; i <= Number(counter); i++) {
    const request = await vault.withdrawalRequests(i);
    console.log(`\nWithdrawal #${i}:`);
    console.log("  Requester:", request.requester);
    console.log("  Executed:", request.executed);
    console.log("  IsEth:", request.isEth);
    
    // Check if this is our withdrawal and not executed
    if (request.requester === signer.address && !request.executed) {
      console.log("  → Can be cancelled!");
      
      // Check if enough time has passed (usually 1 hour timeout)
      const requestTime = Number(request.requestTime);
      const now = Math.floor(Date.now() / 1000);
      const elapsed = now - requestTime;
      console.log(`  → Time elapsed: ${elapsed}s (need 3600s for cancel)`);
    }
  }
}

main().catch(console.error);
