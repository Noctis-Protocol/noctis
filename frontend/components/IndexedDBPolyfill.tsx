"use client";

/**
 * IndexedDB Polyfill Component
 * 
 * Fixes indexedDB not defined errors for WalletConnect / FHE browser deps
 * Must run before wallet + encrypt/decrypt code paths
 */

import { useEffect } from "react";

// Global polyfill for SSR (before React hydration)
if (typeof window === "undefined") {
  // Server-side: create mock indexedDB to prevent errors during SSR
  (global as any).indexedDB = {
    open: () => ({
      addEventListener: () => {},
      onerror: null,
      onsuccess: null,
    }),
  };
} else if (!window.indexedDB) {
  // Client-side: use browser's indexedDB with fallbacks
  (window as any).indexedDB =
    (window as any).mozIndexedDB ||
    (window as any).webkitIndexedDB ||
    (window as any).msIndexedDB;
}

export function IndexedDBPolyfill() {
  useEffect(() => {
    // Double-check client-side after hydration
    if (typeof window !== "undefined" && !window.indexedDB) {
      console.warn("⚠️ indexedDB not available in this browser");
    }
  }, []);

  return null;
}
