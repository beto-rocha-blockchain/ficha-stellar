/**
 * App chrome: sticky header (Brand + network badge + lock) and the bottom
 * navigation (phones) / inline top navigation (md and up).
 * To add a tab, edit NAV below. Screens render inside <main>.
 */
import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { History, Home, Lock, MapPinned, QrCode, Settings, type LucideIcon } from "lucide-react";
import { useT } from "@/i18n";
import { useWallet } from "@/wallet";
import { cn } from "@/lib/utils";
import { Brand } from "./Brand";
import { ChargeChip } from "./ChargeChip";
import { NetworkBadge } from "./NetworkBadge";

interface NavItem {
  to: "/" | "/pay" | "/history" | "/stations" | "/settings";
  key: string;
  icon: LucideIcon;
  /** Other paths that highlight this tab. */
  also?: string[];
}

const NAV: NavItem[] = [
  { to: "/", key: "nav.home", icon: Home, also: ["/buy", "/battery"] },
  { to: "/pay", key: "nav.pay", icon: QrCode, also: ["/scan", "/r"] },
  { to: "/history", key: "nav.history", icon: History },
  { to: "/stations", key: "nav.stations", icon: MapPinned, also: ["/estabelecimentos"] },
  { to: "/settings", key: "nav.settings", icon: Settings, also: ["/host"] },
];

function isActive(item: NavItem, path: string): boolean {
  const match = (p: string) => (p === "/" ? path === "/" : path === p || path.startsWith(`${p}/`));
  return match(item.to) || (item.also ?? []).some(match);
}

export function AppShell({ children }: { children: ReactNode }) {
  const t = useT("common");
  const path = useRouterState({ select: (s) => s.location.pathname });
  const status = useWallet((s) => s.status);
  const lock = useWallet((s) => s.lock);

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="pt-safe sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-3xl items-center gap-3 px-4">
          <Link to="/" aria-label="Ficha" className="flex items-center">
            <Brand className="h-7 w-[88px]" />
          </Link>
          <NetworkBadge />
          <ChargeChip />
          <nav className="ml-4 hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "rounded-sm px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
                  isActive(item, path) ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(item.key)}
              </Link>
            ))}
          </nav>
          <div className="ml-auto">
            {status === "unlocked" && (
              <button
                type="button"
                onClick={lock}
                title={t("lock")}
                aria-label={t("lock")}
                className="grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground transition hover:border-primary/40 hover:text-primary"
              >
                <Lock className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-24 pt-4 md:pb-10 md:pt-6">
        <div key={path} className="ep-page-in">
          {children}
        </div>
      </main>

      <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur md:hidden">
        <ul className="mx-auto grid max-w-md grid-cols-5">
          {NAV.map((item) => {
            const active = isActive(item, path);
            const Icon = item.icon;
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className={cn(
                    "relative flex h-14 flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors",
                    active ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {active && <span className="absolute inset-x-5 top-0 h-[2px] rounded-b-sm bg-primary" />}
                  <Icon className="h-5 w-5" />
                  {t(item.key)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
