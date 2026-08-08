/**
 * C4 — Print Sepolia pilot metrics (subgraph + on-chain fills).
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const ssot = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "sepolia.json"), "utf8")
  );
  const queryUrl =
    (ssot.subgraph?.queryUrl as string) ||
    "https://api.studio.thegraph.com/query/1724540/noctis-protocol/v0.9.0";
  const ex = ssot.contracts.NoctisExchange as string;
  const start = Number(ssot.subgraph?.exchangeStartBlock || 0);

  const sg = await fetch(queryUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{
        globalStats(id: "global") { totalOrders totalDeposits totalWithdrawals }
        orders(where: { status: "FILLED" }, first: 100, orderBy: filledAt, orderDirection: desc) {
          id isBuy filledTxHash
        }
      }`,
    }),
  }).then((r) => r.json());

  const stats = sg.data?.globalStats;
  const filled = sg.data?.orders || [];
  console.log("=== Subgraph", queryUrl, "===");
  console.log("globalStats", stats);
  console.log("FILLED orders", filled.length);

  const provider = ethers.provider;
  const art = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "artifacts/contracts/NoctisExchange.sol/NoctisExchange.json"),
      "utf8"
    )
  );
  const iface = new ethers.Interface(art.abi);
  const tip = await provider.getBlockNumber();
  const topic = iface.getEvent("OrderFilledSimple")!.topicHash;
  const logs = await provider.getLogs({
    address: ex,
    fromBlock: start,
    toBlock: tip,
    topics: [topic],
  });
  console.log("\n=== On-chain current Exchange", ex, "===");
  console.log("OrderFilledSimple since", start, "→", logs.length);
  console.log("\nPilot: ≥20 filled swaps · ≥1 desk with 5+ swaps");
  console.log("Progress: subgraph FILLED =", filled.length, "/ 20");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
