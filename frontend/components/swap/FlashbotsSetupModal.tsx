"use client";

/**
 * FlashbotsSetupModal Component
 * 
 * Asks user to paste their current RPC URL to check if it's Flashbots.
 * If not Flashbots, shows instructions to configure it.
 */

import { useState, useEffect } from "react";
import { useChainId } from "wagmi";
import { X, Shield, Zap, CheckCircle, Copy, ExternalLink, AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// LocalStorage key for user's RPC URL
const USER_RPC_KEY = "noctis:user-rpc";

// Flashbots RPC URLs
const FLASHBOTS_RPC = {
  mainnet: "https://rpc.flashbots.net",
  sepolia: "https://rpc-sepolia.flashbots.net",
};

/**
 * Check if a URL is a Flashbots RPC
 */
export function isFlashbotsUrl(url: string): boolean {
  const normalized = url.toLowerCase().trim();
  return (
    normalized.includes("flashbots.net") ||
    normalized.includes("rpc.flashbots") ||
    normalized.includes("protect.flashbots")
  );
}

/**
 * Get saved RPC URL from localStorage
 */
export function getSavedRpcUrl(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(USER_RPC_KEY) || "";
}

/**
 * Save RPC URL to localStorage
 */
export function saveRpcUrl(url: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(USER_RPC_KEY, url);
}

/**
 * Check if user has Flashbots configured (based on saved RPC)
 */
export function isFlashbotsConfigured(): boolean {
  return isFlashbotsUrl(getSavedRpcUrl());
}

interface FlashbotsSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRpcChecked: (isFlashbots: boolean) => void;
}

export function FlashbotsSetupModal({ isOpen, onClose, onRpcChecked }: FlashbotsSetupModalProps) {
  const chainId = useChainId();
  const [userRpc, setUserRpc] = useState("");
  const [copied, setCopied] = useState(false);
  const [hasChecked, setHasChecked] = useState(false);

  const isMainnet = chainId === 1;
  const networkName = isMainnet ? "Ethereum Mainnet" : "Sepolia";
  const flashbotsUrl = isMainnet ? FLASHBOTS_RPC.mainnet : FLASHBOTS_RPC.sepolia;
  
  const isProtected = isFlashbotsUrl(userRpc);

  // Load saved RPC on mount
  useEffect(() => {
    const saved = getSavedRpcUrl();
    if (saved) {
      setUserRpc(saved);
      setHasChecked(true);
    }
  }, []);

  // Check RPC when user types
  const handleRpcChange = (value: string) => {
    setUserRpc(value);
    setHasChecked(true);
    saveRpcUrl(value);
    onRpcChecked(isFlashbotsUrl(value));
  };

  const handleCopyFlashbots = () => {
    navigator.clipboard.writeText(flashbotsUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-50"
            onClick={onClose}
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className={cn(
              "fixed left-1/2 top-4 -translate-x-1/2 z-50",
              "w-full max-w-md bg-white rounded-2xl shadow-xl",
              "p-6 max-h-[calc(100vh-2rem)] overflow-y-auto"
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-full",
                  hasChecked && isProtected ? "bg-green-100" : "bg-orange-100"
                )}>
                  {hasChecked && isProtected ? (
                    <CheckCircle className="h-5 w-5 text-green-600" />
                  ) : (
                    <Zap className="h-5 w-5 text-orange-600" />
                  )}
                </div>
                <div>
                  <h2 className="text-lg font-semibold">MEV Protection</h2>
                  <p className="text-sm text-muted-foreground">
                    {hasChecked && isProtected ? "You're protected!" : "Check your RPC"}
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 hover:bg-gray-100 rounded-full transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* RPC Input */}
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2">
                Paste your current RPC URL:
              </label>
              <p className="text-xs text-muted-foreground mb-2">
                Find it in MetaMask: Network dropdown → Click on {networkName} → Copy the RPC URL
              </p>
              <input
                type="text"
                value={userRpc}
                onChange={(e) => handleRpcChange(e.target.value)}
                placeholder="https://..."
                className={cn(
                  "w-full px-3 py-2.5 rounded-lg border text-sm font-mono",
                  "focus:outline-none focus:ring-2",
                  hasChecked && userRpc
                    ? isProtected
                      ? "border-green-300 focus:ring-green-500 bg-green-50"
                      : "border-amber-300 focus:ring-amber-500 bg-amber-50"
                    : "border-gray-300 focus:ring-brand-500"
                )}
              />
            </div>

            {/* Status */}
            {hasChecked && userRpc && (
              <div className={cn(
                "mb-4 p-3 rounded-xl flex items-start gap-3",
                isProtected
                  ? "bg-green-50 border border-green-200"
                  : "bg-amber-50 border border-amber-200"
              )}>
                {isProtected ? (
                  <>
                    <CheckCircle className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-green-800">
                      <p className="font-medium">You're protected!</p>
                      <p className="mt-1 text-green-700">
                        Your transactions are sent via Flashbots and hidden from the public mempool.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-amber-800">
                      <p className="font-medium">Not protected</p>
                      <p className="mt-1 text-amber-700">
                        Your swaps can be frontrun. Configure Flashbots RPC below.
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Show setup instructions if not protected */}
            {(!hasChecked || !isProtected) && (
              <>
                {/* Network details */}
                <div className="mb-4 p-3 rounded-xl bg-brand-50 border border-brand-200">
                  <p className="text-sm font-medium text-brand-900 mb-3">
                    Flashbots Network Details:
                  </p>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-brand-700">RPC URL:</span>
                      <div className="flex items-center gap-1">
                        <code className="px-2 py-1 bg-white rounded text-xs font-mono">
                          {flashbotsUrl}
                        </code>
                        <button
                          onClick={handleCopyFlashbots}
                          className="p-1.5 hover:bg-brand-100 rounded"
                        >
                          {copied ? (
                            <CheckCircle className="h-3.5 w-3.5 text-green-600" />
                          ) : (
                            <Copy className="h-3.5 w-3.5 text-brand-600" />
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-brand-700">Chain ID:</span>
                      <code className="px-2 py-1 bg-white rounded text-xs font-mono">
                        {isMainnet ? "1" : "11155111"}
                      </code>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-brand-700">Currency:</span>
                      <code className="px-2 py-1 bg-white rounded text-xs font-mono">ETH</code>
                    </div>
                  </div>
                </div>

                {/* Quick steps */}
                <div className="mb-4">
                  <p className="text-sm font-medium mb-2">How to configure:</p>
                  <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-inside">
                    <li>Open MetaMask network dropdown</li>
                    <li>Click on {networkName} (Chain ID: {isMainnet ? "1" : "11155111"})</li>
                    <li>Paste the Flashbots RPC URL</li>
                    <li>Save and come back here to verify</li>
                  </ol>
                </div>
              </>
            )}

            {/* Footer */}
            <div className="mt-4 pt-4 border-t flex items-center justify-between">
              <a
                href="https://docs.flashbots.net/flashbots-protect/quick-start"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline"
              >
                Flashbots docs
                <ExternalLink className="h-3 w-3" />
              </a>

              <Button onClick={onClose}>
                {hasChecked && isProtected ? "Done" : "Close"}
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
