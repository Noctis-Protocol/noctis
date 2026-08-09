/**
 * useNoctisVault Hook (V2 — multi-token)
 *
 * Handles interactions with NoctisVaultV2:
 * - Deposit native ETH (depositETH) or any registered ERC-20 (approve + depositToken)
 * - Request withdrawals per token (encrypted amount when possible)
 * - Execute withdrawals via the v0.9 self-relay decrypt flow
 * - Claim ETH (pull-over-push pattern)
 *
 * Native ETH is address(0) on-chain; callers pass a TokenInfo from the registry.
 */

"use client";

import { useCallback, useMemo } from "react";
import {
  useAccount,
  useWriteContract,
  usePublicClient,
} from "wagmi";
import { parseEther, decodeEventLog } from "viem";
import { NoctisVaultABI, ERC20ABI } from "@/lib/contracts/abi";
import { useContractAddresses } from "@/lib/wagmi";
import { useTransactionState } from "./useTransactionState";
import { useFhevm } from "./useFhevm";
import { encryptWithdrawalIntent } from "@/lib/fheEncryptClient";
import {
  parseTokenAmount,
  formatTokenAmount,
  type TokenInfo,
} from "./useTokenRegistry";

interface UseNoctisVaultOptions {
  // Callback called after successful deposit (use for balance refetch)
  onDepositSuccess?: () => void;
  // Balance tracker callback (for local estimation)
  onDepositTracked?: (amount: number, token: string, txHash: string) => void;
  // Callback called after successful withdrawal request
  onWithdrawalSuccess?: () => void;
}

interface UseNoctisVaultReturn {
  /** Deposit native ETH — returns true once confirmed */
  depositETH: (amount: string) => Promise<boolean>;
  /** Deposit a registered ERC-20 (approve + depositToken) — raw units */
  depositToken: (token: TokenInfo, amount: bigint) => Promise<boolean>;
  /** Request a withdrawal — optional stealth recipient (Year 2) — returns requestId */
  requestWithdrawal: (token: TokenInfo, amount: string, recipient?: string) => Promise<bigint | null>;
  /** Execute withdrawal via self-relay public decrypt — returns true on success */
  executeWithdrawal: (requestId: bigint) => Promise<boolean>;
  cancelWithdrawal: (requestId: bigint) => Promise<boolean>;
  claimETH: () => Promise<boolean>;
  isLoading: boolean;
  error: string | null;
}

export function useNoctisVault(options?: UseNoctisVaultOptions): UseNoctisVaultReturn {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { state, setPending, setConfirming, setSuccess, setFailed } = useTransactionState();
  const { publicDecryptWithProof, isReady: fhevmReady } = useFhevm();

  const contracts = useContractAddresses();

  const { writeContractAsync, error: writeError } = useWriteContract();

  const errorMessage = useMemo(() => {
    if (!writeError) return null;
    return writeError.message?.slice(0, 100) || "Transaction failed";
  }, [writeError]);

  // Shared post-deposit flow: wait for 1 confirmation, then notify UI,
  // track locally and schedule balance refetches (RPC state can lag inclusion).
  const finalizeDeposit = useCallback(
    async (
      hash: `0x${string}`,
      tokenSymbol: string,
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
      options?.onDepositTracked?.(amountNumber, tokenSymbol, hash);
      window.dispatchEvent(new CustomEvent("noctis:transaction-success", {
        detail: { type: "deposit", hash, token: tokenSymbol },
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

  // Deposit native ETH - returns true once the transaction is confirmed on-chain
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

  // Deposit a registered ERC-20 (requires approval first) - waits for confirmation
  const depositToken = useCallback(
    async (token: TokenInfo, amount: bigint): Promise<boolean> => {
      if (!contracts?.vaultAddress) {
        setFailed("Vault contract not configured for this chain");
        return false;
      }
      if (token.isNative) {
        setFailed("Use depositETH for native ETH");
        return false;
      }
      if (!publicClient) {
        setFailed("No public client available");
        return false;
      }

      try {
        // Step 1: Approve
        setPending(1, 2);

        const approveHash = await writeContractAsync({
          abi: ERC20ABI,
          address: token.address,
          functionName: "approve",
          args: [contracts.vaultAddress as `0x${string}`, amount],
        });

        setConfirming(approveHash);

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
          functionName: "depositToken",
          args: [token.address, amount],
        });
        return await finalizeDeposit(
          depositHash,
          token.symbol,
          Number(formatTokenAmount(amount, token.decimals, Math.min(token.decimals, 8))),
          `Deposited ${token.symbol} successfully!`
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

  // Request withdrawal - returns requestId or null
  // PRIVACY (Year 2, stealth exits): amount AND payout destination encrypted
  // in the browser. `recipient` defaults to the connected wallet; pass a fresh
  // address for a stealth exit (revealed only when the payout executes).
  // Falls back to the plaintext self-only path if encryption is unavailable.
  const requestWithdrawal = useCallback(
    async (token: TokenInfo, amount: string, recipient?: string): Promise<bigint | null> => {
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

      const amountFloat = parseFloat(amount);
      if (isNaN(amountFloat) || amountFloat <= 0) {
        setFailed("Invalid amount");
        return null;
      }
      const amountBigInt = parseTokenAmount(amount, token.decimals);
      if (amountBigInt <= 0n) {
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
        );

        const submitAndExtract = async (hash: `0x${string}`): Promise<bigint | null> => {
          setConfirming(hash);
          const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
          if (receipt.status !== "success") {
            setFailed("Withdrawal request transaction reverted");
            return null;
          }

          // Extract requestId from WithdrawalRequested logs
          let requestId: bigint | null = null;
          for (const log of receipt.logs) {
            try {
              const decoded = decodeEventLog({
                abi: NoctisVaultABI,
                data: log.data,
                topics: log.topics,
              });
              if (decoded.eventName === "WithdrawalRequested") {
                requestId = (decoded.args as { requestId: bigint }).requestId;
                break;
              }
            } catch {
              continue;
            }
          }
          // Fallback: first indexed topic
          if (requestId == null) {
            for (const log of receipt.logs) {
              if (log.topics.length > 1 && log.topics[1]) {
                try {
                  requestId = BigInt(log.topics[1] as string);
                  break;
                } catch { /* continue */ }
              }
            }
          }

          setSuccess(
            `Withdrawal request #${requestId?.toString() || "pending"} submitted! Click Execute to complete privately.`
          );
          window.dispatchEvent(new CustomEvent("noctis:transaction-success", {
            detail: { type: "withdrawal", hash, token: token.symbol, requestId: requestId?.toString() },
          }));

          if (options?.onWithdrawalSuccess) {
            setTimeout(() => {
              options.onWithdrawalSuccess?.();
              setTimeout(() => options.onWithdrawalSuccess?.(), 3000);
            }, 1000);
          }
          return requestId;
        };

        // PRIVACY (Year 2): encrypt amount AND recipient IN THE BROWSER — the
        // payout destination stays an opaque handle on-chain until execution.
        // Default recipient = self; a stealth exit passes a fresh address.
        const payoutRecipient = recipient && /^0x[a-fA-F0-9]{40}$/.test(recipient)
          ? recipient
          : address;
        let encrypted: {
          encryptedAmount: `0x${string}`;
          encryptedRecipient: `0x${string}`;
          inputProof: `0x${string}`;
        };
        try {
          encrypted = await encryptWithdrawalIntent(
            contracts.vaultAddress,
            address,
            amountBigInt,
            payoutRecipient
          );
        } catch (encErr) {
          if (payoutRecipient !== address) {
            // NEVER downgrade a stealth exit to a plaintext self-withdrawal
            setFailed("Encryption unavailable — cannot do a private-destination withdrawal right now.");
            return null;
          }
          // Fallback: plaintext self path (amount visible in calldata)
          console.warn("⚠️ Browser-side encryption unavailable, using plaintext requestWithdrawal", encErr);
          const hash = await writeContractAsync({
            abi: NoctisVaultABI,
            address: contracts.vaultAddress as `0x${string}`,
            functionName: "requestWithdrawal",
            args: [token.address, amountBigInt],
            gas: 3_000_000n,
          });
          return await submitAndExtract(hash);
        }

        setPending(
          2, 2,
          "Sign in wallet",
          "✅ Encryption complete! Please confirm the transaction in your wallet."
        );

        const hash = await writeContractAsync({
          abi: NoctisVaultABI,
          address: contracts.vaultAddress as `0x${string}`,
          functionName: "requestWithdrawalPrivate",
          args: [
            token.address,
            encrypted.encryptedAmount, // externalEuint128
            encrypted.encryptedRecipient, // externalEaddress (stealth exit)
            encrypted.inputProof,
          ],
          gas: 3_000_000n,
        });

        return await submitAndExtract(hash);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Withdrawal request failed";
        const lower = message.toLowerCase();

        if (
          message.includes("TooManyPendingWithdrawals") ||
          (lower.includes("rpc 0x") && lower.includes("revert"))
        ) {
          setFailed(
            "You already have a pending withdrawal. Click Execute in Activity, or Cancel it first."
          );
        } else if (message.includes("ExceedsMaximumWithdrawal")) {
          setFailed(`Amount exceeds the per-request ${token.symbol} withdrawal cap.`);
        } else {
          setFailed(message.slice(0, 120));
        }
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contracts, publicClient, writeContractAsync, address, setPending, setConfirming, setSuccess, setFailed]
  );

  /**
   * Execute withdrawal via the v0.9 self-relay flow:
   * 1. requestWithdrawalExecution(requestId) → DecryptionReady(handles)
   * 2. publicDecrypt(handles) via the ZAMA gateway (amount + sufficiency ebool)
   * 3. executeWithdrawalCallback(requestId, cleartexts, proof)
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
        // Step 1: mark the handles publicly decryptable
        setPending(1, 3);

        const execHash = await writeContractAsync({
          abi: NoctisVaultABI,
          address: contracts.vaultAddress as `0x${string}`,
          functionName: "requestWithdrawalExecution",
          args: [requestId],
          gas: 3_000_000n,
        });

        setConfirming(execHash);

        const execReceipt = await publicClient.waitForTransactionReceipt({
          hash: execHash,
          confirmations: 1,
        });

        if (execReceipt.status !== "success") {
          setFailed("Request execution transaction reverted");
          return false;
        }

        // Extract handles from DecryptionReady event
        let handles: string[] = [];

        for (const log of execReceipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: NoctisVaultABI,
              data: log.data,
              topics: log.topics,
            });

            if (decoded.eventName === "DecryptionReady") {
              const eventHandles = (decoded.args as unknown as { handles: readonly `0x${string}`[] }).handles;
              handles = [...eventHandles];
              break;
            }
          } catch {
            continue;
          }
        }

        // Fallback: read handles from contract state
        if (handles.length === 0) {
          const request = await publicClient.readContract({
            abi: NoctisVaultABI,
            address: contracts.vaultAddress as `0x${string}`,
            functionName: "getWithdrawalRequest",
            args: [requestId],
          }) as { encryptedAmount: `0x${string}`; hasSufficientBalance: `0x${string}` };

          handles = [request.encryptedAmount, request.hasSufficientBalance];
        }

        // Step 2: public decrypt via the Gateway (trustless — proof verified on-chain).
        // The Gateway needs time to index the makePubliclyDecryptable ACL change.
        setPending(2, 3);

        let decryptResult = null;
        const delays = [15000, 20000, 30000, 45000, 60000];

        for (let attempt = 0; attempt < delays.length; attempt++) {
          await new Promise(resolve => setTimeout(resolve, delays[attempt]));

          try {
            decryptResult = await publicDecryptWithProof(handles, contracts.vaultAddress);
            if (decryptResult) break;
          } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : "";
            if (errorMsg.includes("not allowed for public decryption") && attempt < delays.length - 1) {
              continue;
            }
            throw err;
          }
        }

        if (!decryptResult) {
          setFailed("Gateway decryption failed after retries. Try again later.");
          return false;
        }

        // Step 3: callback with proven cleartexts
        setPending(3, 3);

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
          gas: 5_000_000n,
        });

        setConfirming(callbackHash);

        const callbackReceipt = await publicClient.waitForTransactionReceipt({
          hash: callbackHash,
          confirmations: 1,
        });

        if (callbackReceipt.status === "success") {
          setSuccess("Withdrawal executed! ETH goes to Ready to claim; tokens are sent directly.");

          window.dispatchEvent(new CustomEvent("noctis:transaction-success", {
            detail: { type: "withdrawal-executed", hash: callbackHash },
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

        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
        });

        if (receipt.status === "success") {
          setSuccess("Withdrawal cancelled. Funds returned to your vault balance.");

          window.dispatchEvent(new CustomEvent("noctis:transaction-success", {
            detail: { type: "withdrawal-cancelled", hash, requestId: requestId.toString() },
          }));

          return true;
        } else {
          setFailed("Cancel transaction reverted");
          return false;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Cancel failed";

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

  // Claim ETH after withdrawal (pull pattern) - returns true on success
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

        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
        });

        if (receipt.status === "success") {
          setSuccess("ETH claimed successfully!");

          window.dispatchEvent(new CustomEvent("noctis:transaction-success", {
            detail: { type: "claim", hash, token: "ETH" },
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
    depositToken,
    requestWithdrawal,
    executeWithdrawal,
    cancelWithdrawal,
    claimETH,
    isLoading: state.status === "pending" || state.status === "confirming",
    error: errorMessage,
  };
}
