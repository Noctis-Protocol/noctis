/**
 * useFhevm Hook
 * 
 * Handles FHE encryption/decryption via @zama-fhe/relayer-sdk (API routes).
 * - Uses server-side API for FHEVM operations (bypasses browser WASM issues)
 * - Provides encrypt/decrypt functions for order amounts and balance decryption
 * - Supports private reencryption for client-side balance viewing
 * - NEW: Client-side encryption with ZK proofs for privacy-first operations
 * 
 * @see https://docs.zama.ai/fhevm/client/getting_started/browser
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { useSignTypedData } from "wagmi";

// Types for relayer-sdk encrypt/decrypt surface
interface FhevmInstance {
  reencrypt: (
    handle: bigint,
    privateKey: string,
    publicKey: string,
    signature: string,
    contractAddress: string,
    userAddress: string,
    sessionId: string
  ) => Promise<bigint>;
  // Client-side encryption (if available)
  createEncryptedInput?: (
    contractAddress: string,
    userAddress: string
  ) => EncryptedInputBuilder;
}

// Encrypted input builder interface
export interface EncryptedInputBuilder {
  add128: (value: bigint) => EncryptedInputBuilder;
  addAddress: (address: string) => EncryptedInputBuilder;
  encrypt: () => EncryptedInputResult;
}

// Result of encrypting inputs
export interface EncryptedInputResult {
  handles: string[];
  inputProof: string;
}

// Result of user decryption with proof (for on-chain callbacks)
interface UserDecryptResult {
  clearValues: Record<string, bigint | boolean>;  // bigint for amounts, boolean for hasSufficientBalance
  abiEncodedClearValues: string;  // For contract callback
  decryptionProof: string;         // For contract callback
}

interface UseFhevmReturn {
  instance: FhevmInstance | null;
  isLoading: boolean;
  isReady: boolean;
  error: string | null;
  // Decryption functions
  reencrypt: (
    handle: bigint,
    contractAddress: string,
    userAddress: string
  ) => Promise<bigint | null>;
  publicDecryptWithProof: (
    handles: string[],
    contractAddress: string
  ) => Promise<UserDecryptResult | null>;
  // Client-side encryption with ZK proof (for privacy-first withdrawals)
  createEncryptedInput: (
    contractAddress: string,
    userAddress: string
  ) => Promise<EncryptedInputBuilder | null>;
}

// Cache signature + session to avoid repeated wallet popups during retries
interface SignatureCache {
  signature: string;
  publicKey: string;
  sessionId: string;
  contractAddress: string;
  timestamp: number;
  // Stateless session material (serverless-safe): sent back with each POST so
  // decryption works even when the request hits a different server instance
  // than the one that generated the keypair.
  keypairPublicKey?: string;
  keypairPrivateKey?: string;
  startTimestamp?: string;
  durationDays?: string;
}

let signatureCache: SignatureCache | null = null;
const SIGNATURE_CACHE_TTL = 60 * 1000; // 1 minute cache for retries

export function useFhevm(): UseFhevmReturn {
  const { isConnected, address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  
  const [instance, setInstance] = useState<FhevmInstance | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Connect to FHEVM API when wallet is connected
  useEffect(() => {
    if (!isConnected) {
      setInstance(null);
      return;
    }

    const connectToFhevmApi = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Test the server-side API
        const healthCheck = await fetch("/api/fhevm/decrypt");
        const healthData = await healthCheck.json();
        
        if (healthData.status !== "ok") {
          throw new Error(healthData.error || "FHEVM API not available");
        }

        // Create instance that uses server-side API for decryption
        const apiInstance: FhevmInstance = {
          reencrypt: async (
            handle: bigint,
            _privateKey: string,
            publicKey: string,
            signature: string,
            contractAddress: string,
            userAddress: string,
            sessionId: string
          ) => {
            const handleHex = "0x" + handle.toString(16).padStart(64, "0");
            
            const statelessSession =
              signatureCache && signatureCache.sessionId === sessionId
                ? {
                    keypairPublicKey: signatureCache.keypairPublicKey,
                    keypairPrivateKey: signatureCache.keypairPrivateKey,
                    startTimestamp: signatureCache.startTimestamp,
                    durationDays: signatureCache.durationDays,
                  }
                : {};

            const response = await fetch("/api/fhevm/decrypt", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                handles: [handleHex],
                mode: "user",
                sessionId,
                publicKey,
                signature,
                contractAddress,
                userAddress,
                ...statelessSession,
              }),
            });
            
            const data = await response.json();
            if (!data.success) {
              throw new Error(data.error || "Decryption failed");
            }

            const values = data.clearValuesString || {};
            // Normalize lookup — SDK may return checksum/case variants
            let clearValue =
              values[handleHex] ??
              values[handleHex.toLowerCase()] ??
              Object.entries(values).find(
                ([k]) => k.toLowerCase() === handleHex.toLowerCase()
              )?.[1];

            if (clearValue === undefined || clearValue === null) {
              throw new Error(
                `No cleartext for handle ${handleHex.slice(0, 18)}… (keys: ${Object.keys(values).length})`
              );
            }
            if (typeof clearValue === "string" && clearValue.startsWith("error:")) {
              throw new Error(clearValue.slice(7));
            }

            return BigInt(clearValue as string);
          },
        };

        setInstance(apiInstance);
        setIsLoading(false);
      } catch (err) {
        console.error("Failed to connect to FHEVM API:", err);
        setError(err instanceof Error ? err.message : "FHEVM API connection failed");
        setIsLoading(false);
      }
    };

    connectToFhevmApi();
  }, [isConnected]);

  // Reencrypt (private decryption) - decrypt encrypted balance client-side
  const reencrypt = useCallback(
    async (
      handle: bigint,
      contractAddress: string,
      userAddress: string
    ): Promise<bigint | null> => {
      if (!instance) {
        console.warn("FHEVM not initialized");
        return null;
      }

      if (!address) {
        console.warn("Wallet not connected");
        return null;
      }

      try {
        let signature: string;
        let publicKey: string;
        let sessionId: string;
        
        // Check if we have a valid cached signature for this contract
        const now = Date.now();
        if (
          signatureCache &&
          signatureCache.contractAddress === contractAddress &&
          (now - signatureCache.timestamp) < SIGNATURE_CACHE_TTL
        ) {
          // Use cached signature (no wallet popup!)
          signature = signatureCache.signature;
          publicKey = signatureCache.publicKey;
          sessionId = signatureCache.sessionId;
        } else {
          // Get keypair + EIP-712 structure from server
          const keypairResponse = await fetch(
            `/api/fhevm/decrypt?action=keypair&contract=${encodeURIComponent(contractAddress)}`
          );
          const keypairData = await keypairResponse.json();
          
          if (
            keypairData.status !== "ok" ||
            !keypairData.sessionId ||
            !keypairData.publicKey ||
            !keypairData.eip712
          ) {
            throw new Error(keypairData.error || "Failed to get keypair from server");
          }
          
          sessionId = keypairData.sessionId;
          publicKey = keypairData.publicKey;
          const eip712 = keypairData.eip712;

          // Sign EIP-712 message with wallet
          signature = await signTypedDataAsync({
            domain: eip712.domain,
            types: eip712.types,
            primaryType: eip712.primaryType || Object.keys(eip712.types).find(t => t !== "EIP712Domain") || "Reencrypt",
            message: eip712.message,
          });
          
          // Cache the signature for retries
          signatureCache = {
            signature,
            publicKey,
            sessionId,
            contractAddress,
            timestamp: now,
            keypairPublicKey: keypairData.keypairPublicKey,
            keypairPrivateKey: keypairData.keypairPrivateKey,
            startTimestamp: keypairData.startTimestamp,
            durationDays: keypairData.durationDays,
          };
        }

        // Call server with signature for user decryption
        const cleartext = await instance.reencrypt(
          handle,
          "",
          publicKey,
          signature,
          contractAddress,
          userAddress,
          sessionId
        );

        return cleartext;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Decryption failed";
        console.error("Reencrypt failed:", err);
        setError(message);
        // Drop signature cache on ACL/auth/session failures so the next retry
        // fetches a fresh keypair instead of replaying a dead sessionId.
        const m = message.toLowerCase();
        if (
          m.includes("not authorized") ||
          m.includes("acl") ||
          m.includes("signature") ||
          m.includes("session")
        ) {
          signatureCache = null;
        }
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [instance, address, signTypedDataAsync]
  );

  // Public decryption with proof - for withdrawal callback execution
  // Uses publicDecrypt (Gateway) which returns cleartexts + proof for on-chain verification
  // This is the trustless approach - no keeper needed!
  const publicDecryptWithProof = useCallback(
    async (
      handles: string[],
      contractAddress: string
    ): Promise<UserDecryptResult | null> => {
      if (!instance) {
        console.warn("FHEVM not initialized");
        return null;
      }

      try {
        console.log("🔐 Starting PUBLIC decryption (Gateway)...");
        console.log(`   Handles: ${handles.length}`);
        for (let i = 0; i < handles.length; i++) {
          console.log(`   Handle[${i}]: ${handles[i].slice(0, 20)}...`);
        }

        // Call server for public decryption (no signature needed - handles were marked publiclyDecryptable)
        const response = await fetch("/api/fhevm/decrypt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            handles,
            mode: "public",
            contractAddress,
          }),
        });
        
        const data = await response.json();
        
        if (!data.success) {
          throw new Error(data.error || "Public decryption failed");
        }

        console.log("   ✅ Gateway decryption successful");
        console.log("   📦 Server response data:", {
          success: data.success,
          hasClearValues: !!data.clearValues,
          hasClearValuesString: !!data.clearValuesString,
          hasAbiEncoded: !!data.abiEncodedClearValues,
          hasProof: !!data.decryptionProof,
        });
        console.log("   📦 clearValuesString keys:", Object.keys(data.clearValuesString || {}));

        // Convert string values to bigints (handle booleans for hasSufficientBalance)
        const clearValues: Record<string, bigint | boolean> = {};
        for (const [handle, value] of Object.entries(data.clearValuesString || {})) {
          console.log(`   📦 Processing handle ${handle.slice(0, 20)}... = ${value} (type: ${typeof value})`);
          
          // Handle boolean values (hasSufficientBalance returns true/false)
          if (value === true || value === "true") {
            clearValues[handle] = true;
          } else if (value === false || value === "false") {
            clearValues[handle] = false;
          } else if (typeof value === "string" && !value.startsWith("error")) {
            clearValues[handle] = BigInt(value);
          } else if (typeof value === "bigint") {
            clearValues[handle] = value;
          }
        }
        
        console.log("   📦 clearValues parsed:", Object.keys(clearValues).length, "values");

        // For publicDecrypt, the proof comes from the Gateway response
        // The SDK returns abiEncodedClearValues and decryptionProof
        const result = {
          clearValues,
          abiEncodedClearValues: data.abiEncodedClearValues || "",
          decryptionProof: data.decryptionProof || "",
        };
        console.log("   📦 Returning result with", Object.keys(result.clearValues).length, "clear values");
        return result;
      } catch (err) {
        console.error("Public decrypt failed:", err);
        setError(err instanceof Error ? err.message : "Decryption failed");
        return null;
      }
    },
    [instance]
  );

  // Client-side encryption with ZK proof - for privacy-first withdrawals
  // Encrypts amount and recipient BEFORE sending to contract, so they're never visible in TX data
  const createEncryptedInput = useCallback(
    async (
      contractAddress: string,
      userAddress: string
    ): Promise<EncryptedInputBuilder | null> => {
      try {
        console.log("🔐 Creating encrypted input for privacy-first operation...");
        console.log(`   Contract: ${contractAddress}`);
        console.log(`   User: ${userAddress}`);

        // Call server-side API to create encrypted inputs
        // Server uses @zama-fhe/relayer-sdk to encrypt values and generate proof
        const response = await fetch("/api/fhevm/encrypt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "init",
            contractAddress,
            userAddress,
          }),
        });
        
        const data = await response.json();
        
        if (!data.success) {
          throw new Error(data.error || "Failed to initialize encryption");
        }

        const sessionId = data.sessionId;
        console.log(`   ✅ Encryption session started: ${sessionId}`);

        // Return a builder that accumulates values and encrypts on finalize
        const values: { type: string; value: string }[] = [];
        
        const builder: EncryptedInputBuilder = {
          add128: (value: bigint) => {
            values.push({ type: "uint128", value: value.toString() });
            return builder;
          },
          addAddress: (addr: string) => {
            values.push({ type: "address", value: addr });
            return builder;
          },
          encrypt: () => {
            // This is a synchronous call, but we need async encryption
            // We'll use a workaround by returning a promise-like object
            throw new Error("Use encryptAsync() instead - see createEncryptedInputAsync");
          },
        };

        // Add async encrypt method
        (builder as EncryptedInputBuilder & { encryptAsync: () => Promise<EncryptedInputResult> }).encryptAsync = async () => {
          console.log(`   🔐 Encrypting ${values.length} values...`);
          
          const encryptResponse = await fetch("/api/fhevm/encrypt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "encrypt",
              sessionId,
              contractAddress,
              userAddress,
              values,
            }),
          });
          
          const encryptData = await encryptResponse.json();
          
          if (!encryptData.success) {
            throw new Error(encryptData.error || "Encryption failed");
          }

          console.log(`   ✅ Encrypted successfully! Handles: ${encryptData.handles.length}`);
          
          return {
            handles: encryptData.handles,
            inputProof: encryptData.inputProof,
          };
        };

        return builder;
      } catch (err) {
        console.error("Create encrypted input failed:", err);
        setError(err instanceof Error ? err.message : "Encryption failed");
        return null;
      }
    },
    []
  );

  return {
    instance,
    isLoading,
    isReady: instance !== null,
    error,
    reencrypt,
    publicDecryptWithProof,
    createEncryptedInput,
  };
}
