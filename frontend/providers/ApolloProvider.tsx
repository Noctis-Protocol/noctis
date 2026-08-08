"use client";

/**
 * Apollo Provider for The Graph
 * 
 * Separate provider for Apollo Client to avoid Next.js SSR issues.
 * Must be used as a client component.
 */

import { ApolloClient, InMemoryCache, HttpLink } from "@apollo/client";
import { ApolloProvider } from "@apollo/client/react";
import { useMemo, type ReactNode } from "react";
import { env } from "@/lib/env";

interface Props {
  children: ReactNode;
}

export function GraphQLProvider({ children }: Props) {
  const client = useMemo(() => {
    const SUBGRAPH_URL = env.subgraphUrl;

    // Warn if subgraph URL is not configured
    if (typeof window !== "undefined" && !SUBGRAPH_URL) {
      console.warn(
        "⚠️ NEXT_PUBLIC_SUBGRAPH_URL not set. Activity feed will be disabled."
      );
    }

    // Use a dummy URL if not configured to prevent Apollo errors
    const uri = SUBGRAPH_URL || "https://api.studio.thegraph.com/query/0/placeholder/v0.0.1";

    return new ApolloClient({
      link: new HttpLink({
        uri,
      }),
      cache: new InMemoryCache({
        typePolicies: {
          Query: {
            fields: {
              deposits: {
                keyArgs: ["where", ["depositor"]],
                merge(existing = [], incoming) {
                  return incoming;
                },
              },
              orders: {
                keyArgs: ["where", ["trader"]],
                merge(existing = [], incoming) {
                  return incoming;
                },
              },
            },
          },
        },
      }),
      defaultOptions: {
        watchQuery: {
          fetchPolicy: "cache-and-network",
        },
        query: {
          fetchPolicy: "network-only",
        },
      },
    });
  }, []);

  return <ApolloProvider client={client}>{children}</ApolloProvider>;
}
