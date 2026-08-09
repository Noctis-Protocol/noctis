/**
 * Browser-side FHE input encryption (E2E privacy for relayed orders).
 *
 * The order amount is encrypted in the browser with the ZAMA relayer SDK web
 * build (WASM): the plaintext never reaches our relayer, our API routes, or
 * the public calldata — only an FHE handle + ZK input proof leave the page.
 *
 * The input proof must be bound to (contractAddress = exchange,
 * userAddress = relayer wallet): on-chain, FHE.fromExternal verifies the
 * proof against msg.sender, which is the relayer on the relayed path.
 */

type WebSdk = {
  initSDK: () => Promise<void>;
  createInstance: (config: Record<string, unknown>) => Promise<BrowserFheInstance>;
  SepoliaConfig: Record<string, unknown>;
};

interface BrowserFheInstance {
  createEncryptedInput: (
    contractAddress: string,
    userAddress: string
  ) => {
    add64: (value: bigint) => void;
    add128: (value: bigint) => void;
    addAddress: (value: string) => void;
    encrypt: () => Promise<{ handles: Uint8Array[]; inputProof: Uint8Array }>;
  };
}

let instancePromise: Promise<BrowserFheInstance> | null = null;

async function getBrowserInstance(): Promise<BrowserFheInstance> {
  if (!instancePromise) {
    instancePromise = (async () => {
      const sdk = (await import(
        "@zama-fhe/relayer-sdk/web"
      )) as unknown as WebSdk;
      await sdk.initSDK();
      return sdk.createInstance({
        ...sdk.SepoliaConfig,
        network: "https://ethereum-sepolia-rpc.publicnode.com",
      });
    })().catch((err) => {
      // Allow a retry on transient failures (CDN/WASM load, network)
      instancePromise = null;
      throw err;
    });
  }
  return instancePromise;
}

function toHex(bytes: Uint8Array): `0x${string}` {
  return ("0x" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
      ""
    )) as `0x${string}`;
}

/** Warm the WASM + FHE keys in the background (call on desk load). */
export function prewarmFheEncryption(): void {
  void getBrowserInstance().catch(() => {});
}

/**
 * Encrypt a uint128 amount fully in the browser (generic FHE external input).
 * The proof binds to (contractAddress, userAddress) where userAddress is the
 * on-chain msg.sender of the call that will consume the input.
 */
export async function encryptAmount128(
  contractAddress: string,
  userAddress: string,
  amount: bigint
): Promise<{ encryptedAmount: `0x${string}`; inputProof: `0x${string}` }> {
  const instance = await getBrowserInstance();
  const input = instance.createEncryptedInput(contractAddress, userAddress);
  input.add128(amount);
  const { handles, inputProof } = await input.encrypt();
  return { encryptedAmount: toHex(handles[0]), inputProof: toHex(inputProof) };
}

/**
 * PRIVACY (Year 2, stealth exits): encrypt a withdrawal intent — amount AND
 * payout destination — fully in the browser. The recipient stays an opaque
 * FHE handle on-chain until the payout executes, so a fresh address receives
 * the funds with no prior on-chain link to the requester.
 */
export async function encryptWithdrawalIntent(
  vaultAddress: string,
  userAddress: string,
  amount: bigint,
  recipient: string
): Promise<{
  encryptedAmount: `0x${string}`;
  encryptedRecipient: `0x${string}`;
  inputProof: `0x${string}`;
}> {
  const instance = await getBrowserInstance();
  const input = instance.createEncryptedInput(vaultAddress, userAddress);
  input.add128(amount);
  input.addAddress(recipient);
  const { handles, inputProof } = await input.encrypt();
  return {
    encryptedAmount: toHex(handles[0]),
    encryptedRecipient: toHex(handles[1]),
    inputProof: toHex(inputProof),
  };
}

/**
 * PRIVACY (V2.5, confidential deposits): encrypt a euint64 transfer amount
 * for the ERC-7984 wrapper (cUSDC). The proof binds to (wrapper, user):
 * confidentialTransferAndCall is sent by the user's own wallet.
 */
export async function encryptAmount64(
  wrapperAddress: string,
  userAddress: string,
  amount: bigint
): Promise<{ encryptedAmount: `0x${string}`; inputProof: `0x${string}` }> {
  const instance = await getBrowserInstance();
  const input = instance.createEncryptedInput(wrapperAddress, userAddress);
  input.add64(amount);
  const { handles, inputProof } = await input.encrypt();
  return { encryptedAmount: toHex(handles[0]), inputProof: toHex(inputProof) };
}

/**
 * Encrypt an order amount for the relayed path.
 * Returns the FHE handle (signed in the EIP-712 intent) and the input proof.
 */
export async function encryptAmountForRelayer(
  exchangeAddress: string,
  relayerAddress: string,
  amount: bigint
): Promise<{ encryptedAmount: `0x${string}`; inputProof: `0x${string}` }> {
  return encryptAmount128(exchangeAddress, relayerAddress, amount);
}
