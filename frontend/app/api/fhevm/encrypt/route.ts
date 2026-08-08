/**
 * API Route: FHEVM Encrypt
 * 
 * Server-side encryption using @zama-fhe/relayer-sdk/node
 * This enables client-side encryption with ZK proofs for privacy-first operations.
 * 
 * Encrypts values before they're sent to the blockchain, ensuring:
 * - Amount and recipient are never visible in transaction input data
 * - ZK proof validates the encrypted values without revealing them
 * - MEV bots cannot see withdrawal details in the mempool
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { guardFhevmApi } from "@/lib/apiGuard";

// Cache the instance (swap when chainId changes)
let fhevmInstance: any = null;
let fhevmChainId: number | null = null;

// Session storage for multi-step encryption
const encryptionSessions: Map<string, {
  contractAddress: string;
  userAddress: string;
  values: { type: string; value: string }[];
  createdAt: number;
}> = new Map();

// Clean up old sessions (older than 5 minutes)
function cleanupSessions() {
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutes
  
  for (const [sessionId, session] of encryptionSessions.entries()) {
    if (now - session.createdAt > maxAge) {
      encryptionSessions.delete(sessionId);
    }
  }
}

async function getInstance(chainId: number = 11155111) {
  if (!fhevmInstance || fhevmChainId !== chainId) {
    const { createInstance } = await import("@zama-fhe/relayer-sdk/node");
    const { getFhevmHostConfig } = await import("@/lib/fhevmConfig");
    const host = await getFhevmHostConfig(chainId);
    console.log(`🔧 FHEVM encrypt instance (${host.label})...`);
    fhevmInstance = await createInstance({
      ...host.config,
      network: host.rpc,
    });
    fhevmChainId = chainId;
    console.log(`✅ FHEVM encrypt ready (${host.label})`);
  }
  return fhevmInstance;
}

export async function POST(request: NextRequest) {
  const blocked = guardFhevmApi(request, { route: "encrypt", limit: 40 });
  if (blocked) return blocked;

  try {
    const body = await request.json();
    const { action, sessionId, contractAddress, userAddress, values, chainId } = body;
    const { parseChainIdParam } = await import("@/lib/fhevmConfig");
    const resolvedChain = parseChainIdParam(chainId != null ? String(chainId) : null);

    // Clean up old sessions periodically
    cleanupSessions();

    // Initialize encryption session
    if (action === "init") {
      if (!contractAddress || !userAddress) {
        return NextResponse.json(
          { error: "Missing contractAddress or userAddress" },
          { status: 400 }
        );
      }

      const newSessionId = randomUUID();
      encryptionSessions.set(newSessionId, {
        contractAddress,
        userAddress,
        values: [],
        createdAt: Date.now(),
      });

      console.log(`🔐 Encryption session created: ${newSessionId}`);
      console.log(`   Contract: ${contractAddress}`);
      console.log(`   User: ${userAddress}`);

      return NextResponse.json({
        success: true,
        sessionId: newSessionId,
      });
    }

    // Encrypt values
    if (action === "encrypt") {
      if (!sessionId || !values || !Array.isArray(values)) {
        return NextResponse.json(
          { error: "Missing sessionId or values array" },
          { status: 400 }
        );
      }

      const session = encryptionSessions.get(sessionId);
      if (!session) {
        return NextResponse.json(
          { error: "Invalid or expired session" },
          { status: 400 }
        );
      }

      const instance = await getInstance(resolvedChain);

      console.log(`🔐 Encrypting ${values.length} values for session ${sessionId}...`);

      // Create encrypted input using @zama-fhe/relayer-sdk
      const input = instance.createEncryptedInput(
        session.contractAddress,
        session.userAddress
      );

      // Add values to the input
      for (const { type, value } of values) {
        console.log(`   Adding value type: ${type}`);
        
        if (type === "uint128") {
          input.add128(BigInt(value));
        } else if (type === "address") {
          input.addAddress(value);
        } else if (type === "uint64") {
          input.add64(BigInt(value));
        } else if (type === "uint32") {
          input.add32(Number(value));
        } else if (type === "bool") {
          input.addBool(value === "true");
        } else {
          console.warn(`   Unknown type: ${type}, skipping`);
        }
      }

      // Encrypt and get handles + proof (async operation!)
      console.log(`   🔄 Calling input.encrypt() (this may take 30-90 seconds)...`);
      const encrypted = await input.encrypt();

      console.log(`   ✅ Encryption call completed!`);
      console.log(`   Raw encrypted result:`, JSON.stringify(Object.keys(encrypted)));
      console.log(`   Result has handles:`, !!encrypted.handles);
      console.log(`   Result has inputProof:`, !!encrypted.inputProof);

      // SDK returns { handles: Uint8Array[], inputProof: Uint8Array }
      const handles = encrypted.handles || [];
      const inputProof = encrypted.inputProof || new Uint8Array();

      console.log(`   Handles: ${handles.length}`);
      
      // Validate that encryption actually succeeded
      if (handles.length === 0) {
        console.error(`   ❌ Encryption returned 0 handles - this is a failure!`);
        return NextResponse.json(
          { error: "Encryption failed - no handles returned. Please retry." },
          { status: 500 }
        );
      }
      
      if (handles.length !== values.length) {
        console.warn(`   ⚠️ Warning: Expected ${values.length} handles, got ${handles.length}`);
      }
      for (let i = 0; i < handles.length; i++) {
        const handle = handles[i];
        const handleHex = typeof handle === "string" ? handle : "0x" + Buffer.from(handle).toString("hex");
        console.log(`   Handle[${i}]: ${handleHex.slice(0, 40)}...`);
      }

      // Convert handles to hex strings
      const handleStrings = handles.map((h: Uint8Array | string) => {
        if (typeof h === "string") return h;
        return "0x" + Buffer.from(h).toString("hex");
      });

      // Convert proof to hex string
      const proofString = typeof inputProof === "string" 
        ? inputProof 
        : "0x" + Buffer.from(inputProof).toString("hex");

      // Clean up session
      encryptionSessions.delete(sessionId);

      return NextResponse.json({
        success: true,
        handles: handleStrings,
        inputProof: proofString,
      });
    }

    return NextResponse.json(
      { error: "Invalid action. Use 'init' or 'encrypt'" },
      { status: 400 }
    );

  } catch (error) {
    console.error("Encryption API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Encryption failed" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    status: "ok",
    message: "FHEVM Encryption API ready",
    usage: {
      init: "POST with { action: 'init', contractAddress, userAddress }",
      encrypt: "POST with { action: 'encrypt', sessionId, values: [{ type, value }] }",
    },
  });
}
