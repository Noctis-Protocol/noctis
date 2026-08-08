import { ethers } from "hardhat";
async function main() {
  const tx = await ethers.provider.getTransaction("0xa746a2ea3d395f5c44c1dd604ffc1c6eec9735f5a56d8ddb808c81c790c14fb1");
  console.log("Withdrawal tx block:", tx?.blockNumber);
  const current = await ethers.provider.getBlockNumber();
  console.log("Current block:", current);
  console.log("Subgraph is at: 10197488");
  console.log("Blocks behind:", current - 10197488);
}
main();
