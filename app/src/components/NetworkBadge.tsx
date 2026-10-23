import { useNetwork } from "@/stellar";
import { cn } from "@/lib/utils";

/** TESTNET (brand lime) / MAINNET (primary cyan) status pill. */
export function NetworkBadge({ className }: { className?: string }) {
  const net = useNetwork();
  const tone =
    net.id === "testnet"
      ? "border-brand-lime/40 bg-brand-lime/10 text-brand-lime"
      : "border-primary/40 bg-primary/10 text-primary";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-[2px] font-mono text-[9px] uppercase tracking-widest",
        tone,
        className,
      )}
    >
      <span className="ep-status-dot h-1.5 w-1.5 rounded-full bg-current" />
      {net.label}
    </span>
  );
}
