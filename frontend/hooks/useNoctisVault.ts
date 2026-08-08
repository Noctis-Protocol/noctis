/**
 * useNoctisVault Hook
 * 
 * Handles interactions with NoctisVault contract:
 * - Deposit ETH/USDT
 * - Request encrypted withdrawals
 * - Read encrypted balances
 * 
 * Now properly waits for transaction confirmation before showing success.
 */

"use client";

import { useCallback, useMemo } from "react";
import { 
  useAccount, 
  useChainId,
  useWriteContract,
  usePublicClient,
} from "wagmi";
import { parseEther, formatEther, decodeEventLog } from "viem";
import { NoctisVaultABI, ERC20ABI } from "@/lib/contracts/abi";
import { useContractAddresses } from "@/lib/wagmi";
import { useTransactionState } from "./useTransactionState";
import { useFhevm } from "./useFhevm";

interface UseNoctisVaultOptions {
  // Callback called after successful deposit (use for balance refetch)
  onDepositSuccess?: () => void;
  // Balance tracker callback (for local estimation)
  onDepositTracked?: (amount: number, token: "ETH" | "USDT", txHash: string) => void;
  // Callback called after successful withdrawal request
  onWithdrawalSuccess?: () => void;
}

interface UseNoctisVaultReturn {
  // Deposit functions - return true on success, false on failure
  depositETH: (amount: string) => Promise<boolean>;
  depositUSDT: (amount: bigint) => Promise<boolean>;
  // Withdrawal function - returns requestId on success, null on failure
  requestWithdrawal: (recipient: string, amount: string, isEth: boolean) => Promise<bigint | null>;
  // Execute withdrawal (user-initiated private decryption) - returns true on success
  executeWithdrawal: (requestId: bigint) => Promise<boolean>;
  // Cancel pending withdrawal - returns true on success
  cancelWithdrawal: (requestId: bigint) => Promise<boolean>;
  // Claim ETH after withdrawal completion
  claimETH: () => Promise<boolean>;
  // State
  isLoading: boolean;
  error: string | null;
}

export function useNoctisVault(options?: UseNoctisVaultOptions): UseNoctisVaultReturn {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { state, setPending, setConfirming, setSuccess, setFailed, reset } = useTransactionState();
  const { publicDecryptWithProof, createEncryptedInput, isReady: fhevmReady } = useFhevm();
  
  const contracts = useContractAddresses();
  
  const { writeContractAsync, error: writeError } = useWriteContract();
  
  // Parse error message (wagmi v2 pattern)
  const errorMessage = useMemo(() => {
    if (!writeError) return null;
    return writeError.message?.slice(0, 100) || "Transaction failed";
  }, [writeError]);

  // Shared post-deposit flow: wait for 1 confirmation, then notify UI,
  // track locally and schedule balance refetches (RPC state can lag inclusion).
  const finalizeDeposit = useCallback(
    async (
      hash: `0x${string}`,
      token: "ETH" | "USDT",
      amountNumber: number,
      successMessage: string
    ): Promise<boolean> => {
      setConfirming(hash);
      const receipt = await publicClient!.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });

      if (receipt.status !== "success") {
        setFailed("Deposit transaction reverted");
        return false;
      }

      setSuccess(successMessage);
      options?.onDepositTracked?.(amountNumber, token, hash);
      window.dispatchEvent(new CustomEvent("noctis:transaction-success", {
        detail: { type: "deposit", hash, token },
      }));

      if (options?.onDepositSuccess) {
        // Refetch twice: once after propagation, again for slower RPCs
        setTimeout(() => {
          options.onDepositSuccess?.();
          setTimeout(() => options.onDepositSuccess?.(), 3000);
        }, 1000);
      }
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicClient, setConfirming, setSuccess, setFailed]
  );

  // Deposit ETH - returns true once the transaction is confirmed on-chain
  const depositETH = useCallback(
    async (amount: string): Promise<boolean> => {
      if (!contracts?.vaultAddress) {
        setFailed("Vault contract not configured for this chain");
        return false;
      }
      if (!publicClient) {
        setFailed("No public client available");
        return false;
      }

      try {
        setPending(1, 1);
        const hash = await writeContractAsync({
          abi: NoctisVaultABI,
          address: contracts.vaultAddress as `0x${string}`,
          functionName: "depositETH",
          value: parseEther(amount),
        });
        return await finalizeDeposit(
          hash,
          "ETH",
          parseFloat(amount),
          `Deposited ${amount} ETH successfully!`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Deposit failed";
        setFailed(message.slice(0, 100));
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contracts, publicClient, writeContractAsync, finalizeDeposit, setPending, setFailed]
  );

  // Deposit USDT (requires approval first) - now waits for actual confirmation
  // Returns true on success, false on failure
  const depositUSDT = useCallback(
    async (amount: bigint): Promise<boolean> => {
      if (!contracts?.vaultAddress || !contracts?.usdtAddress) {
        setFailed("Contracts not configured for this chain");
        return false;
      }

      if (!publicClient) {
        setFailed("No public client available");
        return false;
      }

      try {
        // Step 1: Approve USDT
        setPending(1, 2);
        
        const approveHash = await writeContractAsync({
          abi: ERC20ABI,
          address: contracts.usdtAddress as `0x${string}`,
          functionName: "approve",
          args: [contracts.vaultAddress as `0x${string}`, amount],
        });
        
        setConfirming(approveHash);
        
        // Wait for approval confirmation
        console.log("⏳ Waiting for approval confirmation:", approveHash);
        const approveReceipt = await publicClient.waitForTransactionReceipt({
          hash: approveHash,
          confirmations: 1,
        });
        
        if (approveReceipt.status !== "success") {
          setFailed("Approval transaction reverted");
          return false;
        }
        
        // Step 2: Deposit
        setPending(2, 2);
        
        const depositHash = await writeContractAsync({
          abi: NoctisVaultABI,
          address: contracts.vaultAddress as `0x${string}`,
          functionName: "depositUSDT",
          args: [amount],
        });
        return await finalizeDeposit(
          depositHash,
          "USDT",
          Number(amount) / 1e6, // 6 decimals
          "Deposited USDT successfully!"
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Deposit failed";
        setFailed(message.slice(0, 100));
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contracts, publicClient, writeContractAsync, finalizeDeposit, setPending, setConfirming, setFailed]
  );

  // Request withdrawal - returns requestId on success, null on failure
  // PRIVACY-FIRST: Uses client-side encryption so amount and recipient are never visible in TX data
  const requestWithdrawal = useCallback(
    async (recipient: string, amount: string, isEth: boolean): Promise<bigint | null> => {
      if (!contracts?.vaultAddress) {
        setFailed("Vault contract not configured for this chain");
        return null;
      }

      if (!publicClient) {
        setFailed("No public client available");
        return null;
      }

      if (!address) {
        setFailed("Wallet not connected");
        return null;
      }

      // Validation
      if (!recipient || recipient.length !== 42 || !recipient.startsWith("0x")) {
        setFailed("Invalid recipient address");
        return null;
      }

      const amountFloat = parseFloat(amount);
      if (isNaN(amountFloat) || amountFloat <= 0) {
        setFailed("Invalid amount");
        return null;
      }

      try {
        // MAX_PENDING_WITHDRAWALS_PER_USER = 1 — fail fast before 60–90s encrypt
        const pendingCount = (await publicClient.readContract({
          address: contracts.vaultAddress as `0x${string}`,
          abi: NoctisVaultABI,
          functionName: "getMyPendingCount",
          account: address,
        })) as bigint;
        if (pendingCount >= 1n) {
          setFailed(
            "You already have a pending withdrawal (#1). Click Execute in Activity, or Cancel it first."
          );
          return null;
        }

        setPending(
          1, 2, 
          "Encrypting your data...", 
          "🔐 FHE encryption protects your privacy. This takes 60-90 seconds. Please wait..."
        ); // 2 steps: encrypt + send TX
        
        // Convert amount to uint128 format (wei for ETH, 6 decimals for USDT)
        const amountBigInt = isEth 
          ? parseEther(amount)
          : BigInt(Math.floor(amountFloat * 1e6)); // USDT has 6 decimals

        // PRIVACY-FIRST: Encrypt amount and recipient client-side
        // This ensures they're never visible in transaction input data or mempool
        console.log("🔐 Encrypting withdrawal parameters client-side (may take 60-90 seconds)...");
        const encryptedInput = await createEncryptedInput(
          contracts.vaultAddress,
          address
        );

        if (!encryptedInput) {
          // Fallback to legacy method if encryption fails
          console.warn("⚠️ Client-side encryption not available, using legacy method");
          const hash = await writeContractAsync({
            abi: NoctisVaultABI,
            address: contracts.vaultAddress as `0x${string}`,
            functionName: "requestEncryptedWithdrawal",
            args: [recipient as `0x${string}`, amountBigInt, isEth],
          });
          
          setConfirming(hash);
          const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
          
          if (receipt.status === "success") {
            let requestId: bigint | null = null;
            for (const log of receipt.logs) {
              if (log.topics.length > 1 && log.topics[1]) {
                try {
                  requestId = BigInt(log.topics[1] as string);
                  break;
                } catch (e) { /* Continue */ }
              }
            }
            setSuccess(`Withdrawal request #${requestId?.toString() || "pending"} submitted!`);
            return requestId;
          }
          setFailed("Transaction reverted");
          return null;
        }

        // Add values to encrypt
        encryptedInput.add128(amountBigInt);
        encryptedInput.addAddress(recipient);

        // Encrypt with ZK proof
        // Use encryptAsync since encrypt() is synchronous and we need server-side encryption
        const encryptAsync = (encryptedInput as any).encryptAsync;
        if (!encryptAsync) {
          throw new Error("encryptAsync not available on encrypted input builder");
        }
        
        const encrypted = await encryptAsync();
        console.log("✅ Encryption successful! Handles:", encrypted.handles.length);

        setPending(
          2, 2, 
          "Sign in wallet", 
          "✅ Encryption complete! Please confirm the transaction in your wallet."
        ); // Step 2: Send TX

        // Call privacy-first function with encrypted inputs
        const hash = await writeContractAsync({
          abi: NoctisVaultABI,
          address: contracts.vaultAddress as `0x${string}`,
          functionName: "requestEncryptedWithdrawalPrivate",
          args: [
            encrypted.handles[0] as `0x${string}`,  // encryptedAmount
            encrypted.handles[1] as `0x${string}`,  // encryptedRecipient
            encrypted.inputProof as `0x${string}`,  // ZK proof
            isEth
          ],
        });
        
        setConfirming(hash);
        
        // Wait for actual transaction confirmation
        console.log("⏳ Waiting for withdrawal request confirmation:", hash);
        const receipt = await publicClient.waitForTransactionReceipt({ 
          hash,
          confirmations: 1,
        });
        
        if (receipt.status === "success") {
          console.log("✅ Withdrawal request confirmed:", hash);
          
          // Extract requestId from logs
          let requestId: bigint | null = null;
          for (const log of receipt.logs) {
            // WithdrawalRequested event has requestId as first indexed parameter
            if (log.topics.length > 1 && log.topics[1]) {
              try {
                requestId = BigInt(log.topics[1] as string);
                break;
              } catch (e) {
                // Continue searching
              }
            }
          }
          
          const token = isEth ? "ETH" : "USDT";
          setSuccess(`Withdrawal request #${requestId?.toString() || "pending"} submitted! Click Execute to complete privately.`);
          
          // Dispatch event for activity feed refresh
          console.log("📡 Dispatching transaction-success event for withdrawal request");
          window.dispatchEvent(new CustomEvent("noctis:transaction-success", { 
            detail: { type: "withdrawal", hash, token, requestId: requestId?.toString() } 
          }));
          
          // Trigger balance refetch callback
          if (options?.onWithdrawalSuccess) {
            setTimeout(() => {
              console.log("🔄 Triggering balance refetch after withdrawal request");
              options.onWithdrawalSuccess?.();
              
              // Try again after 3 seconds
              setTimeout(() => {
                options.onWithdrawalSuccess?.();
              }, 3000);
            }, 1000);
          }
          
          return requestId;
        } else {
          setFailed("Withdrawal request transaction reverted");
          return null;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Withdrawal request failed";
        const lower = message.toLowerCase();
        
        // Check for specific contract errors (ABI decode or raw selector)
        if (
          message.includes("TooManyPendingWithdrawals") ||
          lower.includes("0xb0053072") ||
          (lower.includes("rpc 0x") && lower.includes("revert"))
        ) {
          setFailed(
            "You already have a pending withdrawal. Click Execute in Activity, or Cancel it first."
          );
        } else {
          setFailed(message.slice(0, 120));
        }
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contracts, publicClient, writeContractAsync, address, createEncryptedInput, setPending, setConfirming, setSuccess, setFailed]
  );

  /**
   * Execute withdrawal using user-initiated private decryption
   * 
   * PRIVACY-FIRST FLOW:
   * 1. User calls requestWithdrawalExecution() on contract
   * 2. Contract emits DecryptionReady event with handles
   * 3. User decrypts using userDecrypt() - ONLY USER SEES VALUES
   * 4. User calls executeWithdrawalCallback() with cleartexts + proof
   * 
   * This ensures no keeper or third party ever sees the decrypted amounts!
   */
  const executeWithdrawal = useCallback(
    async (requestId: bigint): Promise<boolean> => {
      if (!contracts?.vaultAddress) {
        setFailed("Vault contract not configured for this chain");
        return false;
      }

      if (!publicClient) {
        setFailed("No public client available");
        return false;
      }

      if (!address) {
        setFailed("Wallet not connected");
        return false;
      }

      if (!fhevmReady) {
        setFailed("FHEVM not ready");
        return false;
      }

      try {
        // Step 1: Call requestWithdrawalExecution to mark values for decryption
        setPending(1, 3);
        console.log("🔐 Step 1/3: Requesting withdrawal execution...");
        
        const execHash = await writeContractAsync({
          abi: NoctisVaultABI,
          address: contracts.vaultAddress as `0x${string}`,
          functionName: "requestWithdrawalExecution",
          args: [requestId],
        });
        
        setConfirming(execHash);
        
        console.log("⏳ Waiting for requestWithdrawalExecution confirmation:", execHash);
        const execReceipt = await publicClient.waitForTransactionReceipt({ 
          hash: execHash,
          confirmations: 1,
        });
        
        if (execReceipt.status !== "success") {
          setFailed("Request execution transaction reverted");
          return false;
        }

        // Extract handles from DecryptionReady event
        // The contract emits handles with proper FHE.toBytes32() conversion
        let handles: string[] = [];
        
        for (const log of execReceipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: NoctisVaultABI,
              data: log.data,
              topics: log.topics,
            });
            
            if (decoded.eventName === "DecryptionReady") {
              // Extract handles directly from event (already properly formatted as bytes32)
              const eventHandles = (decoded.args as any).handles;
              handles = eventHandles.map((h: `0x${string}`) => h);
              console.log("   ✅ Extracted handles from DecryptionReady event:", handles.length);
              break;
            }
          } catch {
            // Not our event, continue
            continue;
          }
        }

        // Fallback: If event parsing failed, read from contract state
        if (handles.length === 0) {
          console.log("   ⚠️ Event parsing failed, falling back to contract state...");
          
          const request = await publicClient.readContract({
            abi: NoctisVaultABI,
            address: contracts.vaultAddress as `0x${string}`,
            functionName: "withdrawalRequests",
            args: [requestId],
          }) as any;

          // Convert encrypted handles to hex strings
          // Struct fields: [0]=requestId, [1]=requester, [2]=plaintextRecipient, [3]=encryptedRecipient,
          //                [4]=encryptedAmount, [5]=originalBalance, [6]=hasSufficientBalance, [7]=isEth, ...
          // PRIVACY FIX: We now decrypt hasSufficientBalance (ebool) instead of originalBalance (euint128)
          const encryptedAmount = request.encryptedAmount ?? request[4];
          const hasSufficientBalance = request.hasSufficientBalance ?? request[6];
          
          console.log("   Raw encryptedAmount:", encryptedAmount);
          console.log("   Raw hasSufficientBalance:", hasSufficientBalance);
          
          // If bytes32, use directly; otherwise format as hex string
          const amountHandle = typeof encryptedAmount === "string" && encryptedAmount.startsWith("0x")
            ? encryptedAmount
            : "0x" + BigInt(encryptedAmount).toString(16).padStart(64, "0");
          const hasSufficientHandle = typeof hasSufficientBalance === "string" && hasSufficientBalance.startsWith("0x")
            ? hasSufficientBalance
            : "0x" + BigInt(hasSufficientBalance).toString(16).padStart(64, "0");
          handles = [amountHandle, hasSufficientHandle];
          
          console.log("   ✅ Got handles from contract state:", handles.length);
        }

        console.log("   📦 Handle[0] (amount):", handles[0]?.slice(0, 20) + "...");
        console.log("   📦 Handle[1] (hasSufficientBalance):", handles[1]?.slice(0, 20) + "...");

        // IMPORTANT: Wait for Gateway to index the makePubliclyDecryptable() call
        // The Gateway needs time to synchronize ACL changes from the blockchain
        // Step 2: Decrypt using publicDecrypt (Gateway - returns on-chain verifiable proof)
        setPending(2, 3);
        console.log("🔐 Step 2/3: Decrypting via Gateway (trustless, no keeper needed)...");
        
        // Retry logic with increasing delays
        let decryptResult = null;
        const maxRetries = 5;
        const delays = [15000, 20000, 30000, 45000, 60000]; // 15s, 20s, 30s, 45s, 60s
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          console.log(`   ⏳ Waiting ${delays[attempt]/1000}s for Gateway to index ACL... (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delays[attempt]));
          
          try {
            decryptResult = await publicDecryptWithProof(handles, contracts.vaultAddress);
            if (decryptResult) {
              console.log("   ✅ Decryption successful!");
              break;
            }
          } catch (err: any) {
            const errorMsg = err?.message || "";
            if (errorMsg.includes("not allowed for public decryption") && attempt < maxRetries - 1) {
              console.log(`   ⚠️ Gateway not ready yet, retrying...`);
              continue;
            }
            throw err;
          }
        }

        if (!decryptResult) {
          setFailed("Gateway decryption failed after retries. Try again later.");
          return false;
        }

        console.log("   ✅ Decrypted privately!");
        const amountHandle = handles[0];
        const hasSufficientHandle = handles[1];
        const amountValue = decryptResult.clearValues[amountHandle];
        const amount = typeof amountValue === "bigint" ? amountValue : 0n;
        console.log("   Amount:", formatEther(amount), "ETH");
        // PRIVACY FIX: We now get hasSufficientBalance (boolean), not the actual balance
        const hasSufficient = decryptResult.clearValues[hasSufficientHandle];
        console.log("   Has sufficient balance:", hasSufficient === true ? "YES ✅" : "NO ❌");

        // Step 3: Call executeWithdrawalCallback with cleartexts + proof
        setPending(3, 3);
        console.log("🔐 Step 3/3: Executing withdrawal callback...");
        
        const callbackHash = await writeContractAsync({
          abi: NoctisVaultABI,
          address: contracts.vaultAddress as `0x${string}`,
          functionName: "executeWithdrawalCallback",
          args: [
            requestId,
            decryptResult.abiEncodedClearValues as `0x${string}`,
            decryptResult.decryptionProof as `0x${string}`,
          ],
          // FHE.checkSignatures requires significant gas (~1-2M)
          // Cap at 5M to avoid "gas limit too high" errors from MetaMask
          gas: 5_000_000n,
        });
        
        setConfirming(callbackHash);
        
        console.log("⏳ Waiting for callback confirmation:", callbackHash);
        const callbackReceipt = await publicClient.waitForTransactionReceipt({ 
          hash: callbackHash,
          confirmations: 1,
        });
        
        if (callbackReceipt.status === "success") {
          console.log("✅ Withdrawal executed successfully!");
          setSuccess("Withdrawal executed! Your funds are ready to claim.");
          
          // Dispatch event for balance refresh
          window.dispatchEvent(new CustomEvent("noctis:transaction-success", { 
            detail: { type: "withdrawal-executed", hash: callbackHash } 
          }));
          
          if (options?.onWithdrawalSuccess) {
            setTimeout(() => options.onWithdrawalSuccess?.(), 1000);
          }
          
          return true;
        } else {
          setFailed("Withdrawal callback transaction reverted");
          return false;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Withdrawal execution failed";
        console.error("❌ Withdrawal execution error:", err);
        setFailed(message.slice(0, 100));
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contracts, publicClient, address, fhevmReady, writeContractAsync, publicDecryptWithProof, setPending, setConfirming, setSuccess, setFailed]
  );

  // Cancel pending withdrawal - returns true on success
  const cancelWithdrawal = useCallback(
    async (requestId: bigint): Promise<boolean> => {
      if (!contracts?.vaultAddress) {
        setFailed("Vault contract not configured for this chain");
        return false;
      }

      if (!publicClient) {
        setFailed("No public client available");
        return false;
      }

      try {
        setPending(1, 1);
        
        const hash = await writeContractAsync({
          abi: NoctisVaultABI,
          address: contracts.vaultAddress as `0x${string}`,
          functionName: "cancelWithdrawal",
          args: [requestId],
          // FHE operations require more gas
          gas: 3_000_000n,
        });
        
        setConfirming(hash);
        
        console.log("⏳ Waiting for cancel confirmation:", hash);
        const receipt = await publicClient.waitForTransactionReceipt({ 
          hash,
          confirmations: 1,
        });
        
        if (receipt.status === "success") {
          console.log("✅ Withdrawal cancelled:", hash);
          setSuccess("Withdrawal cancelled. Funds returned to your vault balance.");
          
          // Dispatch event for balance refresh
          window.dispatchEvent(new CustomEvent("noctis:transaction-success", { 
            detail: { type: "withdrawal-cancelled", hash, requestId: requestId.toString() } 
          }));
          
          return true;
        } else {
          setFailed("Cancel transaction reverted");
          return false;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Cancel failed";
        
        // Check for specific contract errors
        if (message.includes("CancellationTooEarly") || message.includes("reverted")) {
          setFailed("Cannot cancel yet. Wait 1 hour after requesting execution, or cancel before clicking Execute.");
        } else {
          setFailed(message.slice(0, 100));
        }
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contracts, publicClient, writeContractAsync, setPending, setConfirming, setSuccess, setFailed]
  );

  // Claim ETH after withdrawal - returns true on success
  const claimETH = useCallback(
    async (): Promise<boolean> => {
      if (!contracts?.vaultAddress) {
        setFailed("Vault contract not configured for this chain");
        return false;
      }

      if (!publicClient) {
        setFailed("No public client available");
        return false;
      }

      try {
        setPending(1, 1);
        
        const hash = await writeContractAsync({
          abi: NoctisVaultABI,
          address: contracts.vaultAddress as `0x${string}`,
          functionName: "claimETH",
        });
        
        setConfirming(hash);
        
        console.log("⏳ Waiting for claim confirmation:", hash);
        const receipt = await publicClient.waitForTransactionReceipt({ 
          hash,
          confirmations: 1,
        });
        
        if (receipt.status === "success") {
          console.log("✅ ETH claimed successfully:", hash);
          setSuccess("ETH claimed successfully!");
          
          // Dispatch event for balance refresh
          window.dispatchEvent(new CustomEvent("noctis:transaction-success", { 
            detail: { type: "claim", hash, token: "ETH" } 
          }));
          
          return true;
        } else {
          setFailed("Claim transaction reverted");
          return false;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Claim failed";
        setFailed(message.slice(0, 100));
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contracts, publicClient, writeContractAsync, setPending, setConfirming, setSuccess, setFailed]
  );

  return {
    depositETH,
    depositUSDT,
    requestWithdrawal,
    executeWithdrawal,
    cancelWithdrawal,
    claimETH,
    isLoading: state.status === "pending" || state.status === "confirming",
    error: errorMessage,
  };
}
