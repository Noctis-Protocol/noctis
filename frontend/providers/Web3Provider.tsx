"use client";

/**
 * Web3Provider
 * 
 * Wraps the app with wagmi, RainbowKit, TanStack Query, and Apollo providers.
 * Handles wallet connection, blockchain state, and GraphQL queries.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { GraphQLProvider } from "@/providers/ApolloProvider";
import { config } from "@/lib/wagmi";
import { useState, type ReactNode } from "react";

import "@rainbow-me/rainbowkit/styles.css";

// Custom Noctis theme for RainbowKit
const noctisTheme = lightTheme({
  accentColor: "#6366f1", // Indigo-500
  accentColorForeground: "white",
  borderRadius: "large",
  fontStack: "system",
  overlayBlur: "small",
});

interface Web3ProviderProps {
  children: ReactNode;
}

export function Web3Provider({ children }: Web3ProviderProps) {
  // Create QueryClient once per component lifecycle
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 1000 * 60, // 1 minute
            gcTime: 1000 * 60 * 5, // 5 minutes
            retry: 2,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <GraphQLProvider>
          <RainbowKitProvider
            theme={noctisTheme}
            modalSize="compact"
            appInfo={{
              appName: "Noctis Protocol",
              learnMoreUrl: "/docs",
            }}
          >
            {children}
          </RainbowKitProvider>
        </GraphQLProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
