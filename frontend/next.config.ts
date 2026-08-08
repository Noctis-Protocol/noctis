import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // CI runs `next lint` as a separate step; skip the second pass in `next build`
  eslint: {
    ignoreDuringBuilds: true,
  },
  
  // Don't bundle these packages - let Node.js resolve them directly
  // This fixes WASM loading issues for @zama-fhe/relayer-sdk
  serverExternalPackages: ["@zama-fhe/relayer-sdk"],
  
  // Optimize for Web3 dependencies
  webpack: (config, { isServer }) => {
    config.resolve.fallback = { 
      fs: false, 
      net: false, 
      tls: false,
      crypto: false,
    };
    
    // Handle missing optional dependencies
    config.resolve.alias = {
      ...config.resolve.alias,
      "@react-native-async-storage/async-storage": false,
    };
    
    config.externals.push("pino-pretty", "encoding");
    
    return config;
  },

  // Security headers (CSP allows WalletConnect / wagmi + local relayer)
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.walletconnect.com https://*.walletconnect.org",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' http://localhost:3001 http://127.0.0.1:3001 https: wss:",
      "frame-src 'self' https://*.walletconnect.com https://*.walletconnect.org",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
