/**
 * Button Component Tests
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("should render with text", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: /click me/i })).toBeInTheDocument();
  });

  it("should call onClick when clicked", () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click me</Button>);
    
    fireEvent.click(screen.getByRole("button"));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("should be disabled when disabled prop is true", () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("should show loading state", () => {
    render(<Button loading>Submit</Button>);
    
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("should apply variant classes", () => {
    const { container } = render(<Button variant="gradient">Gradient</Button>);
    
    const button = container.querySelector("button");
    expect(button?.className).toContain("from-brand-500");
  });

  it("should apply size classes", () => {
    const { container } = render(<Button size="xl">Large</Button>);
    
    const button = container.querySelector("button");
    expect(button?.className).toContain("h-14");
  });
});
