/**
 * Load relayer private key from encrypted JSON keystore or raw key file.
 * Prefer KEEPER_PRIVATE_KEY_FILE over plaintext env (Phase A4).
 */
import * as fs from "fs";
import { Wallet } from "ethers";

export function loadPrivateKey(): string {
  const filePath = process.env.KEEPER_PRIVATE_KEY_FILE || "";
  const requireFile =
    process.env.REQUIRE_KEYSTORE === "1" ||
    process.env.REQUIRE_KEYSTORE === "true";

  if (filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`KEEPER_PRIVATE_KEY_FILE not found: ${filePath}`);
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) throw new Error(`Empty key file: ${filePath}`);

    if (raw.startsWith("{")) {
      const password = process.env.KEYSTORE_PASSWORD || "";
      if (!password) {
        throw new Error(
          "Encrypted keystore requires KEYSTORE_PASSWORD (do not put the private key in .env)"
        );
      }
      const wallet = Wallet.fromEncryptedJsonSync(raw, password);
      console.log(`🔑 Loaded encrypted keystore → ${wallet.address}`);
      return wallet.privateKey;
    }

    const pk = raw.startsWith("0x") ? raw : `0x${raw}`;
    const addr = new Wallet(pk).address;
    console.log(`🔑 Loaded key file → ${addr}`);
    return pk;
  }

  const envPk = process.env.KEEPER_PRIVATE_KEY || process.env.PRIVATE_KEY || "";
  if (!envPk) {
    throw new Error(
      "Set KEEPER_PRIVATE_KEY_FILE (+ KEYSTORE_PASSWORD) or KEEPER_PRIVATE_KEY for local dev"
    );
  }

  if (requireFile) {
    throw new Error(
      "REQUIRE_KEYSTORE=1: plaintext KEEPER_PRIVATE_KEY is forbidden — use keystores/"
    );
  }

  console.warn(
    "⚠️  Using plaintext KEEPER_PRIVATE_KEY from env — migrate with: npm run keystore:create"
  );
  return envPk.startsWith("0x") ? envPk : `0x${envPk}`;
}
