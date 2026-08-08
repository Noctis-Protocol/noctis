"use client";

/**
 * In-app Sepolia ↔ Mainnet switch.
 * Mainnet stays selectable in the wallet sense once live; until Phase D it is disabled.
 */

import { useAccount, useSwitchChain } from "wagmi";
import { cn } from "@/lib/utils";
import { DESK_NETWORKS, getDeskNetwork } from "@/lib/networks";

export function NetworkSwitcher() {
  const { chainId, isConnected } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const active = getDeskNetwork(chainId);

  return (
    <div
      className="flex items-center rounded-full border border-ink-200/80 bg-white/70 p-0.5"
      role="group"
      aria-label="Network"
    >
      {DESK_NETWORKS.map((net) => {
        const selected = active?.id === net.id;
        // Allow switching to Mainnet so the desk can show the "not live yet" banner.
        const canClick = isConnected && !!switchChain && !isPending;

        return (
          <button
            key={net.id}
            type="button"
            disabled={!canClick && !selected}
            title={
              net.live
                ? net.label
                : `${net.label} — ${net.comingSoonNote ?? "Coming soon"}`
            }
            onClick={() => {
              if (!switchChain || chainId === net.chain.id) return;
              switchChain({ chainId: net.chain.id });
            }}
            className={cn(
              "rounded-full px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.12em] transition",
              selected
                ? "bg-ink-900 text-white"
                : net.live
                  ? "text-ink-500 hover:text-ink-800"
                  : "text-ink-400 hover:text-ink-600",
              isPending && "opacity-60"
            )}
          >
            {net.shortLabel}
            {!net.live && (
              <span className="ml-1 normal-case tracking-normal text-[0.65rem] opacity-80">
                soon
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
