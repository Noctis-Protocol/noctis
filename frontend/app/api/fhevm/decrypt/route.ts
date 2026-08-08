/**
 * API Route: FHEVM Decrypt
 * 
 * Server-side decryption using @zama-fhe/relayer-sdk/node
 * This bypasses browser WASM loading issues.
 * 
 * Supports two modes:
 * 1. userDecrypt: Off-chain decryption with user signature (for balances)
 * 2. publicDecrypt: Gateway decryption (for withdrawal amounts already made public)
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { guardFhevmApi } from "@/lib/apiGuard";
import { getFhevmHostConfig, parseChainIdParam } from "@/lib/fhevmConfig";

// Cache instances per chain (Sepolia + Mainnet for Phase D)
const fhevmByChain = new Map<number, any>();

// generateKeypair() returns hex strings (verified with @zama-fhe/relayer-sdk 0.4.4)
type DecryptSession = {
  keypair: { publicKey: string; privateKey: string };
  eip712Params: { startTimestamp: string; durationDays: string };
  createdAt: number;
};

const decryptSessions = new Map<string, DecryptSession>();
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cleanupDecryptSessions(): void {
  const now = Date.now();
  for (const [id, session] of decryptSessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      decryptSessions.delete(id);
    }
  }
}

async function getInstance(chainId: number = 11155111) {
  const cached = fhevmByChain.get(chainId);
  if (cached) return cached;

  const { createInstance } = await import("@zama-fhe/relayer-sdk/node");
  const host = await getFhevmHostConfig(chainId);
  console.log(`🔧 Initializing FHEVM instance (${host.label})...`);
  const instance = await createInstance({
    ...host.config,
    network: host.rpc,
  });
  fhevmByChain.set(chainId, instance);
  console.log(`✅ FHEVM ready (${host.label}) relayer=${host.config.relayerUrl}`);
  return instance;
}

export async function POST(request: NextRequest) {
  const blocked = guardFhevmApi(request, { route: "decrypt", limit: 60 });
  if (blocked) return blocked;

  try {
    cleanupDecryptSessions();

    const body = await request.json();
    const {
      handles,
      mode,
      signature,
      contractAddress,
      userAddress,
      chainId,
      sessionId,
      // Stateless session material (serverless-safe): the GET ?action=keypair
      // response hands these to the client, which sends them back here. On
      // Vercel each invocation can hit a different instance, so the in-memory
      // session map alone is unreliable.
      keypairPublicKey,
      keypairPrivateKey,
      startTimestamp: bodyStartTimestamp,
      durationDays: bodyDurationDays,
    } = body;

    if (!handles || !Array.isArray(handles) || handles.length === 0) {
      return NextResponse.json(
        { error: "Missing or invalid handles array" },
        { status: 400 }
      );
    }

    const instance = await getInstance(parseChainIdParam(chainId != null ? String(chainId) : null));
    
    // User decrypt mode (off-chain with signature)
    if (mode === "user") {
      if (!signature || !contractAddress || !userAddress || !sessionId) {
        return NextResponse.json(
          { error: "Missing required fields for user decrypt: sessionId, signature, contractAddress, userAddress" },
          { status: 400 }
        );
      }

      let cachedKeypair: DecryptSession["keypair"];
      let cachedEip712Params: DecryptSession["eip712Params"];

      if (keypairPublicKey && keypairPrivateKey && bodyStartTimestamp && bodyDurationDays) {
        // Stateless path — keypair material travels with the request. Safe:
        // the ZAMA relayer verifies the user's EIP-712 signature binds
        // userAddress to this public key; the server holds no secret here.
        cachedKeypair = {
          publicKey: keypairPublicKey,
          privateKey: keypairPrivateKey,
        };
        cachedEip712Params = {
          startTimestamp: String(bodyStartTimestamp),
          durationDays: String(bodyDurationDays),
        };
      } else {
        // Legacy path — in-memory session (works only if this instance
        // created the session)
        const session = decryptSessions.get(sessionId);
        if (!session) {
          return NextResponse.json(
            { error: "Invalid or expired session. Call GET ?action=keypair first." },
            { status: 400 }
          );
        }

        if (Date.now() - session.createdAt > SESSION_TTL_MS) {
          decryptSessions.delete(sessionId);
          return NextResponse.json(
            { error: "Session expired. Call GET ?action=keypair again." },
            { status: 400 }
          );
        }

        cachedKeypair = session.keypair;
        cachedEip712Params = session.eip712Params;
      }

      console.log(
        `🔐 User decrypt: ${handles.length} handle(s) for ${userAddress.slice(0, 8)}…`
      );

      const { startTimestamp, durationDays } = cachedEip712Params;
      console.log(`   Timestamp: ${startTimestamp}, Duration: ${durationDays} days`);

      // Remove '0x' prefix from signature as SDK expects
      const cleanSignature = signature.startsWith("0x") ? signature.slice(2) : signature;

      // Prepare handle-contract pairs
      const handleContractPairs = handles.map((h: string) => ({
        handle: h,
        contractAddress: contractAddress,
      }));

      const clearValues: Record<string, string> = {};
      
      let abiEncodedClearValues: string | null = null;
      let decryptionProof: string | null = null;
      
      try {
        // Call userDecrypt with correct signature per SDK docs
        if (typeof instance.userDecrypt === "function") {
          console.log("   Calling instance.userDecrypt...");
          const result = await instance.userDecrypt(
            handleContractPairs,
            cachedKeypair.privateKey,
            cachedKeypair.publicKey,
            cleanSignature,
            [contractAddress],
            userAddress,
            startTimestamp,
            durationDays
          );
          
          // Extract values from result (keyed by handle) — never log plaintext
          for (const handle of handles) {
            const value = result[handle];
            clearValues[handle] = value !== undefined 
              ? (typeof value === "bigint" ? value.toString() : String(value))
              : "not found";
          }
          
          if (result.abiEncodedClearValues) {
            abiEncodedClearValues = result.abiEncodedClearValues;
          }
          if (result.decryptionProof) {
            decryptionProof = result.decryptionProof;
          }
        } else {
          throw new Error("userDecrypt method not found in SDK instance");
        }
        
        console.log("   ✅ userDecrypt ok");
      } catch (err: any) {
        console.error(`   ❌ userDecrypt failed: ${err.message}`);

        const msg = String(err?.message || err);
        const aclHint = msg.includes("not authorized")
          ? " ACL: wait ~15s after deposit/swap for ZAMA to index, then refresh (stale handle or ACL lag)."
          : "";

        return NextResponse.json(
          {
            success: false,
            mode: "user",
            error: msg + aclHint,
          },
          { status: 403 }
        );
      }

      // NOTE: do NOT delete the session here. The client caches the wallet
      // signature (60s) and reuses the same sessionId for follow-up decrypts
      // (second token, retries). Single-use sessions made every 2nd decrypt
      // fail with "Invalid or expired session" while the UI showed 0.0.
      // Reuse is safe: every POST still requires the user's EIP-712 signature
      // over this session's public key. The TTL cleanup expires it.

      return NextResponse.json({
        success: true,
        mode: "user",
        clearValuesString: clearValues,
        // Include callback data for withdrawal execution
        abiEncodedClearValues,
        decryptionProof,
      });
    }
    
    // Public decrypt mode (Gateway - for already public values)
    // This returns cleartexts + proof that can be verified on-chain with FHE.checkSignatures()
    console.log(`🔐 Public decrypt: ${handles.length} handle(s)`);
    
    const results = await instance.publicDecrypt(handles);
    console.log("✅ publicDecrypt ok");
    
    // Extract proof data for on-chain callback — never log plaintext balances
    let abiEncodedClearValues: string | null = null;
    let decryptionProof: string | null = null;
    
    if (results.abiEncodedClearValues) {
      abiEncodedClearValues = results.abiEncodedClearValues;
    }
    if (results.decryptionProof) {
      decryptionProof = results.decryptionProof;
    }

    // Serialize BigInts to strings for JSON compatibility
    const serializeClearValues = (obj: any): any => {
      if (obj === null || obj === undefined) return obj;
      if (typeof obj === "bigint") return obj.toString();
      if (Array.isArray(obj)) return obj.map(serializeClearValues);
      if (typeof obj === "object") {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
          result[key] = serializeClearValues(value);
        }
        return result;
      }
      return obj;
    };

    return NextResponse.json({
      success: true,
      mode: "public",
      clearValues: serializeClearValues(results.clearValues),
      clearValuesString: Object.fromEntries(
        Object.entries(results.clearValues || {}).map(([k, v]) => [
          k,
          typeof v === "bigint" ? v.toString() : String(v),
        ])
      ),
      // Include callback data for executeWithdrawalCallback()
      abiEncodedClearValues,
      decryptionProof,
    });
  } catch (error: any) {
    console.error("❌ Decryption error:", error.message);
    return NextResponse.json(
      { error: error.message || "Decryption failed" },
      { status: 500 }
    );
  }
}

// Health check + generate keypair + EIP-712
export async function GET(request: NextRequest) {
  const blocked = guardFhevmApi(request, { route: "decrypt-get", limit: 120 });
  if (blocked) return blocked;

  try {
    cleanupDecryptSessions();

    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");
    const instance = await getInstance(parseChainIdParam(searchParams.get("chainId")));
    
    // Generate keypair + EIP-712 structure for signing
    if (action === "keypair") {
      const contractAddress = searchParams.get("contract");
      
      if (!contractAddress) {
        return NextResponse.json(
          { status: "error", error: "Missing contract address" },
          { status: 400 }
        );
      }
      
      const keypair = instance.generateKeypair();
      const sessionId = randomUUID();
      console.log(`🔑 Generated keypair for reencryption (session ${sessionId})`);
      
      const startTimestamp = Math.floor(Date.now() / 1000);
      const durationDays = 1; // Valid for 1 day
      
      decryptSessions.set(sessionId, {
        keypair,
        eip712Params: {
          startTimestamp: startTimestamp.toString(),
          durationDays: durationDays.toString(),
        },
        createdAt: Date.now(),
      });
      
      let eip712;
      try {
        // Try the createEIP712 method (newer SDK versions)
        if (typeof instance.createEIP712 === "function") {
          eip712 = instance.createEIP712(
            keypair.publicKey,
            [contractAddress],
            startTimestamp,
            durationDays
          );
        }
        // Try generatePublicKey method (older SDK versions)
        else if (typeof instance.generatePublicKey === "function") {
          const result = instance.generatePublicKey(contractAddress);
          eip712 = result.eip712;
        }
        else {
          throw new Error("No EIP-712 generation method found in SDK");
        }
      } catch (err: any) {
        decryptSessions.delete(sessionId);
        console.error("EIP-712 generation error:", err);
        throw new Error(`Failed to generate EIP-712: ${err.message}`);
      }
      
      console.log("📝 Generated EIP-712 structure for contract:", contractAddress);
      
      // Convert BigInts to strings for JSON serialization
      const serializeWithBigInt = (obj: any): any => {
        if (obj === null || obj === undefined) return obj;
        if (typeof obj === "bigint") return obj.toString();
        if (Array.isArray(obj)) return obj.map(serializeWithBigInt);
        if (typeof obj === "object") {
          const result: any = {};
          for (const [key, value] of Object.entries(obj)) {
            result[key] = serializeWithBigInt(value);
          }
          return result;
        }
        return obj;
      };
      
      return NextResponse.json({
        status: "ok",
        sessionId,
        publicKey: Buffer.from(keypair.publicKey).toString("hex"),
        // Stateless session material — the client sends these back with the
        // POST so decryption works on any serverless instance. The private
        // key is the USER's ephemeral decryption keypair (in ZAMA's standard
        // browser flow it is generated client-side anyway).
        keypairPublicKey: keypair.publicKey,
        keypairPrivateKey: keypair.privateKey,
        startTimestamp: startTimestamp.toString(),
        durationDays: durationDays.toString(),
        eip712: serializeWithBigInt(eip712),
      });
    }
    
    const host = await getFhevmHostConfig(
      parseChainIdParam(searchParams.get("chainId"))
    );
    return NextResponse.json({
      status: "ok",
      relayerUrl: host.config?.relayerUrl || "not loaded",
      chainId: host.chainId,
      network: host.label,
    });
  } catch (error: any) {
    console.error("GET error:", error);
    return NextResponse.json(
      { status: "error", error: error.message },
      { status: 500 }
    );
  }
}
