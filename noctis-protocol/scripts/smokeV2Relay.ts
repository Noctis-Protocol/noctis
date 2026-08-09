import { ethers } from "hardhat";

/**
 * V2 E2E smoke test through the relayer HTTP API (production path):
 *   deposit ETH -> E2E-ENCRYPTED relayed SELL order (client-side FHE input,
 *   the relayer never sees the amount) -> requestSwap -> ZAMA publicDecrypt ->
 *   executeSwap -> verify fill + fee/gas-refund split.
 */

const RELAY = "http://127.0.0.1:3001";
const SELL_ETH = "0.005";

async function post(pathName: string, body: Record<string, unknown>) {
  const res = await fetch(`${RELAY}/api/relay/${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${pathName} failed (${res.status}): ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  const [user] = await ethers.getSigners();
  const ssot = require("../deployments/sepolia.v2.json");
  const c = ssot.contracts;

  const vault = await ethers.getContractAt("NoctisVaultV2", c.NoctisVaultV2);
  const exchange = await ethers.getContractAt("NoctisExchangeV2", c.NoctisExchangeV2);
  const usdc = await ethers.getContractAt("MockERC20", c.USDC);

  const gasRecipient = await exchange.gasRecipient();
  const feeRecipient = await exchange.feeRecipient();
  const relayerUsdcBefore = await usdc.balanceOf(gasRecipient);
  const safeUsdcBefore = await usdc.balanceOf(feeRecipient);
  console.log("user:", user.address);
  console.log("gasRecipient USDC before:", ethers.formatUnits(relayerUsdcBefore, 6));
  console.log("feeRecipient USDC before:", ethers.formatUnits(safeUsdcBefore, 6));

  // 1. Deposit ETH
  const dep = await vault.depositETH({ value: ethers.parseEther("0.005") });
  await dep.wait();
  console.log("deposited 0.005 ETH, tx:", dep.hash);

  const vaultId: bigint = await vault.getMyVaultId();
  console.log("vaultId:", vaultId.toString());

  // 2. Gas quote + relayer address (the FHE input proof must bind to it)
  const quote = await (await fetch(`${RELAY}/api/relay/gasQuote`)).json();
  const gasRefundWei = BigInt(quote.gasRefundWei);
  console.log("gasQuote:", quote);
  const health = await (await fetch(`${RELAY}/api/relay/health`)).json();
  const relayerAddress: string = health.relayer;
  if (!relayerAddress) throw new Error("relayer address missing from /health");

  // ZAMA relayer SDK instance (used for input encryption AND public decrypt)
  const sdk: any = await import("@zama-fhe/relayer-sdk/node");
  const cfg = sdk.SepoliaConfigV2 || sdk.SepoliaConfig;
  const instance = await sdk.createInstance({
    ...cfg,
    network: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
  });
  const toHex = (b: Uint8Array) =>
    "0x" + Array.from(b, (x: number) => x.toString(16).padStart(2, "0")).join("");

  // 3. EIP-712 v2
  const domain = {
    name: "NoctisExchange",
    version: "2",
    chainId: 11155111,
    verifyingContract: c.NoctisExchangeV2,
  };
  const T = {
    CreateOrder: [
      { name: "vaultId", type: "uint256" },
      { name: "baseToken", type: "address" },
      { name: "encryptedAmount", type: "bytes32" },
      { name: "isBuy", type: "bool" },
      { name: "slippageToleranceBPS", type: "uint16" },
      { name: "maxPriceDeviationBPS", type: "uint16" },
      { name: "gasRefundWei", type: "uint128" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
    SwapRequest: [
      { name: "orderId", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
    SwapExecution: [
      { name: "orderId", type: "uint256" },
      { name: "amount", type: "uint128" },
      { name: "minAmountOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };
  const deadline = () => Math.floor(Date.now() / 1000) + 600;
  let nonceSeq = Date.now();

  // 4. Relayed SELL order (native ETH -> USDC), E2E-encrypted amount:
  //    the plaintext never appears in the HTTP body nor in calldata.
  const amountBase = ethers.parseEther(SELL_ETH);
  const encInput = instance.createEncryptedInput(c.NoctisExchangeV2, relayerAddress);
  encInput.add128(amountBase);
  const encrypted = await encInput.encrypt();
  const encryptedAmount = toHex(encrypted.handles[0]);
  const inputProof = toHex(encrypted.inputProof);
  console.log("encrypted amount handle:", encryptedAmount);

  const createMsg = {
    vaultId,
    baseToken: ethers.ZeroAddress,
    encryptedAmount,
    isBuy: false,
    slippageToleranceBPS: 100,
    maxPriceDeviationBPS: 200,
    gasRefundWei,
    deadline: BigInt(deadline()),
    nonce: BigInt(++nonceSeq),
  };
  const createSig = await user.signTypedData(domain, { CreateOrder: T.CreateOrder }, createMsg);
  const created = await post("createOrder", {
    vaultId: vaultId.toString(),
    baseToken: ethers.ZeroAddress,
    encryptedAmount,
    inputProof,
    isBuy: false,
    slippageBPS: 100,
    maxDeviationBPS: 200,
    gasRefundWei: gasRefundWei.toString(),
    deadline: createMsg.deadline.toString(),
    nonce: createMsg.nonce.toString(),
    signature: createSig,
  });
  console.log("order created:", created);
  const orderId = BigInt(created.orderId);

  // 5. Request swap execution
  const reqMsg = { orderId, deadline: BigInt(deadline()), nonce: BigInt(++nonceSeq) };
  const reqSig = await user.signTypedData(domain, { SwapRequest: T.SwapRequest }, reqMsg);
  const requested = await post("requestSwap", {
    orderId: orderId.toString(),
    vaultId: vaultId.toString(),
    deadline: reqMsg.deadline.toString(),
    nonce: reqMsg.nonce.toString(),
    signature: reqSig,
  });
  console.log("swap requested, handles:", requested.handles);
  if (!requested.handles?.length) throw new Error("no decryption handles returned");

  // 6. Public decrypt via ZAMA relayer SDK
  const decrypted = await instance.publicDecrypt(requested.handles);
  const cleartexts = decrypted.abiEncodedClearValues;
  const proof = decrypted.decryptionProof;
  const amountClear = BigInt(Object.values(decrypted.clearValues)[0] as any);
  console.log("decrypted amountBase:", ethers.formatEther(amountClear), "ETH");
  if (amountClear !== amountBase) throw new Error("decrypted amount mismatch");

  // 7. Execute swap (contract enforces its own oracle slippage floor; pass 0)
  const execMsg = {
    orderId,
    amount: amountClear,
    minAmountOut: 0n,
    deadline: BigInt(deadline()),
    nonce: BigInt(++nonceSeq),
  };
  const execSig = await user.signTypedData(domain, { SwapExecution: T.SwapExecution }, execMsg);
  const executed = await post("executeSwap", {
    orderId: orderId.toString(),
    vaultId: vaultId.toString(),
    amount: amountClear.toString(),
    minAmountOut: "0",
    cleartexts,
    decryptionProof: proof,
    deadline: execMsg.deadline.toString(),
    nonce: execMsg.nonce.toString(),
    signature: execSig,
  });
  console.log("swap executed:", executed.txHash);

  // 8. Verify
  const [exists, baseToken, isBuy, status] = await exchange.getOrderPublic(orderId);
  console.log("order status:", { exists, baseToken, isBuy, status });
  if (Number(status) !== 2 /* Filled */) throw new Error(`unexpected status ${status}`);

  const relayerUsdcAfter = await usdc.balanceOf(gasRecipient);
  const safeUsdcAfter = await usdc.balanceOf(feeRecipient);
  console.log("gasRecipient USDC delta:", ethers.formatUnits(relayerUsdcAfter - relayerUsdcBefore, 6));
  console.log("feeRecipient USDC delta:", ethers.formatUnits(safeUsdcAfter - safeUsdcBefore, 6));
  console.log("\nSMOKE TEST PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
