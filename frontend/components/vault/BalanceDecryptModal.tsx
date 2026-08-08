/**
 * BalanceDecryptModal Component
 * 
 * Modal for privately decrypting and viewing exact encrypted balances.
 * Users can decrypt their ETH and USDC balances client-side without
 * revealing them on-chain.
 * 
 * Privacy: Decrypted balances are only stored in React state (memory)
 * and cleared when the modal closes.
 */

"use client";

import { useEffect } from "react";
import { X, Eye, Lock, AlertCircle, Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBalanceDecryption, TokenType } from "@/hooks";

interface BalanceDecryptModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function BalanceDecryptModal({ isOpen, onClose }: BalanceDecryptModalProps) {
  const { decrypted, decryptBalance, clearDecrypted, canDecrypt } = useBalanceDecryption();

  // Clear decrypted balances when modal closes
  useEffect(() => {
    if (!isOpen) {
      clearDecrypted();
    }
  }, [isOpen, clearDecrypted]);

  if (!isOpen) return null;

  const handleDecrypt = async (token: TokenType) => {
    await decryptBalance(token);
  };

  const handleClose = () => {
    clearDecrypted();
    onClose();
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-50 animate-in fade-in"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg animate-in zoom-in-95 slide-in-from-bottom-2">
        <Card className="border-2 shadow-2xl">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <CardTitle className="text-xl flex items-center gap-2">
                  <Eye className="h-5 w-5" />
                  View Exact Balance
                </CardTitle>
                <CardDescription>
                  Decrypt your balance privately in your browser
                </CardDescription>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={handleClose}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {/* Privacy Notice */}
            <div className="flex items-start gap-3 rounded-lg bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-900 p-3">
              <Lock className="h-4 w-4 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
              <div className="text-sm text-blue-900 dark:text-blue-100">
                <p className="font-medium mb-1">Private Decryption</p>
                <p className="text-blue-700 dark:text-blue-300">
                  Your balance is decrypted privately using your signature. 
                  The plaintext value never touches the blockchain.
                </p>
              </div>
            </div>

            {/* Error Message */}
            {decrypted.error && (
              <div className="flex items-start gap-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 p-3">
                <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
                <div className="text-sm">
                  <p className="font-medium text-red-900 dark:text-red-100 mb-1">
                    Decryption Failed
                  </p>
                  <p className="text-red-700 dark:text-red-300">
                    {decrypted.error}
                  </p>
                </div>
              </div>
            )}

            {/* ETH Balance */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">ETH Balance</h3>
                {decrypted.eth ? (
                  <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                    {decrypted.eth.formatted} ETH
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {decrypted.isDecrypting ? "Decrypting..." : "🔒 Encrypted"}
                  </p>
                )}
              </div>
              <Button
                variant={decrypted.eth ? "outline" : "default"}
                className="w-full"
                onClick={() => handleDecrypt("ETH")}
                disabled={!canDecrypt || decrypted.isDecrypting}
              >
                {decrypted.isDecrypting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Decrypting...
                  </>
                ) : decrypted.eth ? (
                  <>
                    <Eye className="mr-2 h-4 w-4" />
                    Decrypt Again
                  </>
                ) : (
                  <>
                    <Eye className="mr-2 h-4 w-4" />
                    Decrypt ETH Balance
                  </>
                )}
              </Button>
            </div>

            <div className="border-t" />

            {/* USDC Balance */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">USDC Balance</h3>
                {decrypted.usdt ? (
                  <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                    {decrypted.usdt.formatted} USDC
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {decrypted.isDecrypting ? "Decrypting..." : "🔒 Encrypted"}
                  </p>
                )}
              </div>
              <Button
                variant={decrypted.usdt ? "outline" : "default"}
                className="w-full"
                onClick={() => handleDecrypt("USDC")}
                disabled={!canDecrypt || decrypted.isDecrypting}
              >
                {decrypted.isDecrypting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Decrypting...
                  </>
                ) : decrypted.usdt ? (
                  <>
                    <Eye className="mr-2 h-4 w-4" />
                    Decrypt Again
                  </>
                ) : (
                  <>
                    <Eye className="mr-2 h-4 w-4" />
                    Decrypt USDC Balance
                  </>
                )}
              </Button>
            </div>

            {/* Info Text */}
            <p className="text-xs text-muted-foreground text-center">
              Decrypted balances are cleared when you close this modal
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
