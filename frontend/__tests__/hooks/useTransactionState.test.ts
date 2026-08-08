/**
 * useTransactionState Hook Tests
 * 
 * Tests transaction state machine transitions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTransactionState } from "@/hooks/useTransactionState";

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

describe("useTransactionState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should initialize with idle status", () => {
    const { result } = renderHook(() => useTransactionState());
    
    expect(result.current.state.status).toBe("idle");
    expect(result.current.isLoading).toBe(false);
  });

  it("should transition to pending state", () => {
    const { result } = renderHook(() => useTransactionState());
    
    act(() => {
      result.current.setPending();
    });
    
    expect(result.current.state.status).toBe("pending");
    expect(result.current.isLoading).toBe(true);
  });

  it("should track step progress in pending state", () => {
    const { result } = renderHook(() => useTransactionState());
    
    act(() => {
      result.current.setPending(1, 3);
    });
    
    expect(result.current.state.step).toBe(1);
    expect(result.current.state.totalSteps).toBe(3);
  });

  it("should transition to confirming state with hash", () => {
    const { result } = renderHook(() => useTransactionState());
    const mockHash = "0x1234567890abcdef" as `0x${string}`;
    
    act(() => {
      result.current.setConfirming(mockHash);
    });
    
    expect(result.current.state.status).toBe("confirming");
    expect(result.current.state.hash).toBe(mockHash);
    expect(result.current.isLoading).toBe(true);
  });

  it("should transition to success state", () => {
    const { result } = renderHook(() => useTransactionState());
    
    act(() => {
      result.current.setSuccess("Transaction complete!");
    });
    
    expect(result.current.state.status).toBe("success");
    expect(result.current.isLoading).toBe(false);
  });

  it("should transition to failed state with error", () => {
    const { result } = renderHook(() => useTransactionState());
    
    act(() => {
      result.current.setFailed("Transaction reverted");
    });
    
    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.error).toBe("Transaction reverted");
    expect(result.current.isLoading).toBe(false);
  });

  it("should reset to idle state", () => {
    const { result } = renderHook(() => useTransactionState());
    
    // Set to failed first
    act(() => {
      result.current.setFailed("Error");
    });
    
    // Then reset
    act(() => {
      result.current.reset();
    });
    
    expect(result.current.state.status).toBe("idle");
    expect(result.current.state.error).toBeUndefined();
  });
});
