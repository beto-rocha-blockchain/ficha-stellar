import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { useT } from "@/i18n";
import { useWallet } from "@/wallet";
import { UnlockForm } from "./UnlockForm";

/**
 * Renders children only while the wallet is unlocked; otherwise an inline PIN
 * prompt. Wrap any step that signs (pay confirm, trustline, SEP-10 login).
 * On the public routes (__root.tsx PUBLIC_PATHS), if auto-lock fires mid-flow,
 * the prompt comes back and state below is kept. Everywhere else the root lock
 * screen replaces the whole page, so state that must outlive a lock has to live
 * outside the route (as the Buy screen's deposit does, src/buy/session.ts).
 */
export function RequireUnlocked({ children }: { children: ReactNode }) {
  const status = useWallet((s) => s.status);
  const t = useT("wallet");
  if (status === "unlocked") return <>{children}</>;
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex items-center gap-2 font-display font-semibold">
        <Lock className="h-4 w-4 text-primary" /> {t("unlock.title")}
      </div>
      <UnlockForm />
    </div>
  );
}
