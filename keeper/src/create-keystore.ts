/**
 * Migrate KEEPER_PRIVATE_KEY from .env → encrypted JSON under keystores/
 *
 *   KEYSTORE_PASSWORD=... npm run keystore:create
 *
 * Then set in .env:
 *   KEEPER_PRIVATE_KEY_FILE=./keystores/keeper.json
 *   KEYSTORE_PASSWORD=...
 *   # KEEPER_PRIVATE_KEY=   (remove or comment out)
 */
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { Wallet } from "ethers";
import * as readline from "readline";

dotenv.config();

async function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(q, (a) => {
      rl.close();
      resolve(a);
    });
  });
}

async function main() {
  const pk = process.env.KEEPER_PRIVATE_KEY || process.env.PRIVATE_KEY || "";
  if (!pk) {
    console.error("No KEEPER_PRIVATE_KEY / PRIVATE_KEY in env to migrate");
    process.exit(1);
  }

  let password = process.env.KEYSTORE_PASSWORD || "";
  if (!password) {
    password = await ask("Keystore password (min 8 chars): ");
  }
  if (password.length < 8) {
    console.error("Password too short (min 8)");
    process.exit(1);
  }

  const wallet = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  const dir = path.join(__dirname, "..", "keystores");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const outPath = process.env.KEYSTORE_OUT || path.join(dir, "keeper.json");

  console.log("Encrypting keystore for", wallet.address, "…");
  const json = await wallet.encrypt(password);
  fs.writeFileSync(outPath, json, { mode: 0o600 });
  fs.chmodSync(outPath, 0o400);
  console.log("✅ Wrote", outPath);
  console.log("");
  console.log("Update keeper/.env:");
  console.log(`  KEEPER_PRIVATE_KEY_FILE=${path.relative(path.join(__dirname, ".."), outPath) || "./keystores/keeper.json"}`);
  console.log("  KEYSTORE_PASSWORD=<your password>");
  console.log("  REQUIRE_KEYSTORE=1");
  console.log("  # comment out KEEPER_PRIVATE_KEY");
  console.log("");
  console.log("Docker perms (container uid 1001 must read the file):");
  console.log("  sudo chown 1001:1001 keystores/keeper.json && sudo chmod 444 keystores/keeper.json");
  console.log("Then: docker compose --profile monitor up -d --build");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
