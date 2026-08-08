/**
 * GET /api/fhevm/balance-handle?user=0x…&token=ETH|USDC
 *
 * Returns the on-chain encrypted balance handle via a FHE-capable RPC.
 * Browser public RPCs often mis-simulate fhEVM eth_calls.
 */

import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { guardFhevmApi } from "@/lib/apiGuard";

const ZERO =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// Minimal ABIs — keep this route free of the large frontend abi.ts bundle
const vaultReadAbi = [
  {
    type: "function",
    name: "hasUserDeposited",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "isEth", type: "bool" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "getEncryptedBalance",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "isEth", type: "bool" },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const;

function rpcUrl(): string {
  return (
    process.env.SEPOLIA_RPC ||
    process.env.NEXT_PUBLIC_SEPOLIA_RPC ||
    "https://ethereum-sepolia-rpc.publicnode.com"
  );
}

function vaultAddress(): `0x${string}` | null {
  const a = process.env.NEXT_PUBLIC_VAULT_ADDRESS;
  return a && a.startsWith("0x") ? (a as `0x${string}`) : null;
}

export async function GET(request: NextRequest) {
  const blocked = guardFhevmApi(request, { route: "balance-handle", limit: 120 });
  if (blocked) return blocked;

  try {
    const { searchParams } = new URL(request.url);
    const user = searchParams.get("user");
    const token = (searchParams.get("token") || "ETH").toUpperCase();

    if (!user || !/^0x[a-fA-F0-9]{40}$/.test(user)) {
      return NextResponse.json(
        { error: "Missing or invalid user address" },
        { status: 400 }
      );
    }

    const vault = vaultAddress();
    if (!vault) {
      return NextResponse.json(
        { error: "NEXT_PUBLIC_VAULT_ADDRESS not configured" },
        { status: 500 }
      );
    }

    const isEth = token !== "USDC" && token !== "USDT";
    const client = createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl()),
    });

    try {
      const deposited = (await client.readContract({
        address: vault,
        abi: vaultReadAbi,
        functionName: "hasUserDeposited",
        args: [user as Hex, isEth],
      })) as boolean;
      if (!deposited) {
        return NextResponse.json({
          success: true,
          handle: null,
          empty: true,
          token: isEth ? "ETH" : "USDC",
          reason: "not_deposited",
        });
      }
    } catch {
      // Older vault without hasUserDeposited — fall through
    }

    const handle = (await client.readContract({
      address: vault,
      abi: vaultReadAbi,
      functionName: "getEncryptedBalance",
      args: [user as Hex, isEth],
    })) as string;

    if (!handle || handle === ZERO) {
      return NextResponse.json({
        success: true,
        handle: null,
        empty: true,
        token: isEth ? "ETH" : "USDC",
      });
    }

    return NextResponse.json({
      success: true,
      handle,
      empty: false,
      token: isEth ? "ETH" : "USDC",
      vault,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to read balance handle";
    console.error("balance-handle error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
