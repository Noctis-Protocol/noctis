/**
 * SwapCard Component Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SwapCard } from "@/components/swap/SwapCard";

// Mock wagmi hooks
vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnected: true, address: "0x123" }),
  useChainId: () => 421614, // Arbitrum Sepolia
  usePublicClient: () => ({}),
  useWriteContract: () => ({
    writeContractAsync: vi.fn(),
    error: null,
  }),
}));

// Mock RainbowKit
vi.mock("@rainbow-me/rainbowkit", () => ({
  ConnectButton: {
    Custom: ({ children }: { children: (props: { openConnectModal: () => void }) => React.ReactNode }) =>
      children({ openConnectModal: vi.fn() }),
  },
}));

// Mock hooks
vi.mock("@/hooks", () => ({
  useNoctisExchange: () => ({
    createMarketOrder: vi.fn(),
    isLoading: false,
    isFheReady: true,
  }),
  useFhevm: () => ({
    isReady: true,
    encrypt128: vi.fn(),
  }),
  useVaultBalances: () => ({
    hasETHBalance: true,
    hasUSDTBalance: true,
  }),
  useSwapExecution: () => ({
    executeFullSwap: vi.fn(),
    swapState: { step: "idle" },
    isLoading: false,
    reset: vi.fn(),
  }),
  useEthPrice: () => ({
    ethPrice: 2500, // Mock price for tests
    isLoading: false,
    error: null,
    isFallback: false,
  }),
}));

// Mock framer-motion
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("SwapCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render swap interface", () => {
    render(<SwapCard />);
    
    expect(screen.getByText("Swap")).toBeInTheDocument();
    expect(screen.getByText("You pay")).toBeInTheDocument();
    expect(screen.getByText("You receive")).toBeInTheDocument();
  });

  it("should show ETH and USDT tokens", () => {
    render(<SwapCard />);
    
    expect(screen.getByText("ETH")).toBeInTheDocument();
    expect(screen.getByText("USDT")).toBeInTheDocument();
  });

  it("should have amount input", () => {
    render(<SwapCard />);
    
    const input = screen.getByPlaceholderText("0");
    expect(input).toBeInTheDocument();
  });

  it("should show disabled button when no amount entered", () => {
    render(<SwapCard />);
    
    const button = screen.getByRole("button", { name: /enter amount/i });
    expect(button).toBeDisabled();
  });

  it("should update output when input changes", () => {
    render(<SwapCard />);
    
    const input = screen.getByPlaceholderText("0");
    fireEvent.change(input, { target: { value: "1" } });
    
    // Output should show calculated USDT amount
    // (1 ETH * $2500 = $2500) - using Chainlink price from mock
    expect(screen.getByText(/2500/)).toBeInTheDocument();
  });

  it("should show privacy badge when amount is entered", () => {
    render(<SwapCard />);
    
    const input = screen.getByPlaceholderText("0");
    fireEvent.change(input, { target: { value: "1" } });
    
    expect(screen.getByText(/Private Route/i)).toBeInTheDocument();
  });
});
