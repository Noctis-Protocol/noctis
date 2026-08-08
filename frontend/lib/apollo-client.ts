/**
 * Apollo Client for The Graph
 * 
 * Connects to Noctis Protocol subgraph for querying on-chain activity.
 * Replaces direct RPC calls with fast, cached GraphQL queries.
 * 
 * IMPORTANT: Set NEXT_PUBLIC_SUBGRAPH_URL in your .env.local file
 */

import { ApolloClient, InMemoryCache, HttpLink } from "@apollo/client";
import { env } from "./env";

// The Graph Studio URL - MUST be set in .env.local
const SUBGRAPH_URL = env.subgraphUrl;

// Warn if subgraph URL is not configured
if (typeof window !== "undefined" && !SUBGRAPH_URL) {
  console.warn(
    "⚠️ NEXT_PUBLIC_SUBGRAPH_URL not set. Activity feed and balances will not work.\n" +
    "Please deploy your subgraph and add the URL to .env.local"
  );
}

export function createApolloClient() {
  return new ApolloClient({
    link: new HttpLink({
      uri: SUBGRAPH_URL,
      // No authentication needed for public subgraphs
    }),
    cache: new InMemoryCache({
      typePolicies: {
        Query: {
          fields: {
            // Cache deposits by user address
            deposits: {
              keyArgs: ["where", ["depositor"]],
              merge(existing = [], incoming) {
                return incoming;
              },
            },
            // Cache orders by user address
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
}
