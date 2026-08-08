"use client";

/**
 * Header — brand-forward, minimal chrome
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { useFhevm } from "@/hooks/useFhevm";
import { NetworkSwitcher } from "@/components/layout/NetworkSwitcher";
import { getDeskNetwork } from "@/lib/networks";

const navLinks = [
  { href: "/about", label: "About" },
  { href: "/docs", label: "Docs" },
  { href: "/metrics", label: "Metrics" },
];

export function Header() {
  const { isConnected, chainId } = useAccount();
  const { isReady: isFheReady } = useFhevm();
  const pathname = usePathname();
  const deskNet = getDeskNetwork(chainId);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/50 bg-[hsl(var(--background)/0.72)] backdrop-blur-md">
      <div className="mx-auto flex h-[4.25rem] max-w-5xl items-center justify-between px-5">
        <div className="flex items-center gap-6 sm:gap-8">
          <a href="/" className="group flex items-baseline gap-3">
            <span className="font-display text-[1.65rem] font-bold tracking-[-0.04em] text-ink-900 transition-colors group-hover:text-brand-700">
              Noctis
            </span>
            <span className="hidden text-[0.7rem] font-medium uppercase tracking-[0.18em] text-ink-400 sm:inline">
              Desk
            </span>
          </a>

          <nav className="flex items-center gap-4 sm:gap-5" aria-label="Main">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`text-sm transition-colors ${
                  pathname === link.href
                    ? "font-medium text-ink-900"
                    : "text-ink-500 hover:text-ink-900"
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2.5 sm:gap-4">
          <NetworkSwitcher />

          {isConnected && (
            <div className="hidden items-center gap-2 sm:flex">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  isFheReady && deskNet?.live
                    ? "bg-brand-500 animate-soft-pulse"
                    : "bg-amber-500 animate-soft-pulse"
                }`}
                aria-hidden
              />
              <span className="text-xs font-medium text-ink-500">
                {!deskNet?.live
                  ? deskNet?.shortLabel ?? "Network"
                  : isFheReady
                    ? "FHE ready"
                    : "Warming up"}
              </span>
            </div>
          )}

          <ConnectButton
            chainStatus="none"
            showBalance={false}
            accountStatus={{
              smallScreen: "avatar",
              largeScreen: "full",
            }}
          />
        </div>
      </div>
    </header>
  );
}
