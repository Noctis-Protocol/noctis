/**
 * Minimal 1/1 Safe exec via approveHash (no protocol-kit dependency).
 */
import { Contract, Signer, ZeroAddress, ZeroHash, concat, zeroPadValue } from "ethers";

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function approveHash(bytes32 hashToApprove)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
];

export async function safeExec(
  safeAddress: string,
  signer: Signer,
  to: string,
  data: string,
  value: bigint = 0n
): Promise<string> {
  const safe = new Contract(safeAddress, SAFE_ABI, signer);
  const owner = await signer.getAddress();
  const safeNonce = await safe.nonce();
  const txHash: string = await safe.getTransactionHash(
    to,
    value,
    data,
    0, // Call
    0,
    0,
    0,
    ZeroAddress,
    ZeroAddress,
    safeNonce
  );

  // Explicit pending nonces — Sepolia RPCs often race approveHash + execTransaction
  const provider = signer.provider;
  if (!provider) throw new Error("safe exec: signer has no provider");
  let accountNonce = await provider.getTransactionCount(owner, "pending");

  const approveTx = await safe.approveHash(txHash, { nonce: accountNonce });
  await approveTx.wait();
  accountNonce += 1;

  // Pre-approved hash signature encoding (Safe v1.3+/1.4.1)
  const signatures = concat([zeroPadValue(owner, 32), ZeroHash, "0x01"]);

  const execTx = await safe.execTransaction(
    to,
    value,
    data,
    0,
    0,
    0,
    0,
    ZeroAddress,
    ZeroAddress,
    signatures,
    { nonce: accountNonce }
  );
  const receipt = await execTx.wait();
  if (!receipt) throw new Error("safe exec: no receipt");
  return execTx.hash;
}
