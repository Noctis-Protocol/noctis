// Polyfill for indexedDB (SSR compatibility)
// This file must run before any React component

if (typeof window === "undefined") {
  // Server-side: create mock to prevent errors during SSR
  if (typeof global !== "undefined" && !(global as any).indexedDB) {
    (global as any).indexedDB = {
      open: () => ({
        addEventListener: () => {},
        onerror: null,
        onsuccess: null,
      }),
    };
  }
}
