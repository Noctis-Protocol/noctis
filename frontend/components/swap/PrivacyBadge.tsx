"use client";

/**
 * PrivacyBadge Component
 * 
 * Visual indicator showing privacy protection status:
 * - FHE encryption (ZAMA) for hidden amounts until execution
 * - Slippage protection against sandwich attacks
 * - No frontrunning possible (order is encrypted)
 */

import { Shield, Lock, Eye } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export function PrivacyBadge() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn(
        "flex items-center gap-3 p-3 rounded-xl",
        "bg-gradient-to-r from-brand-50 to-purple-50",
        "border border-brand-200"
      )}
    >
      {/* Shield icon with animation */}
      <div className="relative">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-100">
          <Shield className="h-5 w-5 text-brand-600" />
        </div>
        {/* Animated pulse */}
        <motion.div
          className="absolute inset-0 rounded-full bg-brand-400/20"
          animate={{
            scale: [1, 1.3, 1],
            opacity: [0.5, 0, 0.5],
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      </div>

      {/* Text */}
      <div className="flex-1">
        <p className="font-medium text-sm text-brand-900">
          Private Route via Noctis
        </p>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-brand-600">
          <span className="flex items-center gap-1" title="Order amounts encrypted with ZAMA FHE - hidden until execution">
            <Lock className="h-3 w-3" />
            FHE Encrypted
          </span>
          <span className="flex items-center gap-1" title="MEV protection via slippage limits">
            <Eye className="h-3 w-3" />
            Slippage Guard
          </span>
        </div>
      </div>
    </motion.div>
  );
}
