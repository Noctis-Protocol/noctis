/**
 * GET /api/fhevm/balance-handle?user=0x…&token=<tokenAddress>
 *
 * Returns the on-chain encrypted balance handle via a FHE-capable RPC.
 * Browser public RPCs often mis-simulate fhEVM eth_calls.
 *
 * V2 (multi-token): `token` is the token address (address(0) = native ETH).
 * Legacy symbols "ETH" / "USDC" / "USDT" are still accepted.
 */

import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { guardFhevmApi } from "@/lib/apiGuard";

const ZERO =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const NATIVE = "0x0000000000000000000000000000000000000000";

// Minimal ABIs — keep this route free of the large frontend abi.ts bundle
const vaultReadAbi = [
  {
    type: "function",
    name: "hasUserDeposited",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "getEncryptedBalance",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
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

/** Resolve the token param to an address (legacy symbols supported). */
function resolveToken(raw: string | null): `0x${string}` | null {
  const value = (raw || "ETH").trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(value)) return value as `0x${string}`;
  const upper = value.toUpperCase();
  if (upper === "ETH") return NATIVE as `0x${string}`;
  if (upper === "USDC" || upper === "USDT") {
    const usdc =
      process.env.NEXT_PUBLIC_USDC_ADDRESS ||
      process.env.NEXT_PUBLIC_USDT_ADDRESS;
    return usdc && usdc.startsWith("0x") ? (usdc as `0x${string}`) : null;
  }
  return null;
}

export async function GET(request: NextRequest) {
  const blocked = guardFhevmApi(request, { route: "balance-handle", limit: 120 });
  if (blocked) return blocked;

  try {
    const { searchParams } = new URL(request.url);
    const user = searchParams.get("user");
    const token = resolveToken(searchParams.get("token"));

    if (!user || !/^0x[a-fA-F0-9]{40}$/.test(user)) {
      return NextResponse.json(
        { error: "Missing or invalid user address" },
        { status: 400 }
      );
    }
    if (!token) {
      return NextResponse.json(
        { error: "Missing or invalid token address" },
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

    const client = createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl()),
    });

    try {
      const deposited = (await client.readContract({
        address: vault,
        abi: vaultReadAbi,
        functionName: "hasUserDeposited",
        args: [user as Hex, token],
      })) as boolean;
      if (!deposited) {
        return NextResponse.json({
          success: true,
          handle: null,
          empty: true,
          token,
          reason: "not_deposited",
        });
      }
    } catch {
      // Vault without hasUserDeposited — fall through
    }

    const handle = (await client.readContract({
      address: vault,
      abi: vaultReadAbi,
      functionName: "getEncryptedBalance",
      args: [user as Hex, token],
    })) as string;

    if (!handle || handle === ZERO) {
      return NextResponse.json({
        success: true,
        handle: null,
        empty: true,
        token,
      });
    }

    return NextResponse.json({
      success: true,
      handle,
      empty: false,
      token,
      vault,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to read balance handle";
    console.error("balance-handle error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
