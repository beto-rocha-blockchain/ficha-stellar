import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { useT } from "@/i18n";
import { useWallet } from "@/wallet";
import { shortAddress } from "@/lib/format";
import { setLockScreenIdle } from "@/native/service-worker";
import { BiometricUnlock, useBiometricUnlock } from "./BiometricUnlock";
import { Brand } from "./Brand";
import { RemoveWalletDialog } from "./RemoveWalletDialog";
import { UnlockForm } from "./UnlockForm";

/**
 * Full-screen lock shown by the root layout while the wallet is locked. It
 * covers Ajustes too, so "forgot the PIN" (remove, then import with the words)
 * is offered here. In the Android app it opens the biometric prompt by itself
 * when biometrics are on and the PIN is not due (src/wallet/biometric.ts).
 * While idle (nothing typed, no dialog open) it tells the service worker
 * gate: after a site publish the page may reload into the new build there.
 */
export function LockScreen() {
  const t = useT("wallet");
  const tb = useT("biometric");
  const bio = useBiometricUnlock();
  const publicKey = useWallet((s) => s.publicKey);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [formIdle, setFormIdle] = useState(false);
  const idle = formIdle && !forgotOpen && !bio.busy;
  useEffect(() => {
    setLockScreenIdle(idle);
    return () => setLockScreenIdle(false);
  }, [idle]);
  return (
    <div className="ep-page-in-fade grid min-h-dvh place-items-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl">
        <div className="flex flex-col items-center text-center">
          <Brand className="h-10 w-[125px]" />
          <div className="mt-5 inline-flex items-center gap-2 font-display text-lg font-semibold">
            <Lock className="h-4 w-4 text-primary" /> {t("unlock.title")}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{bio.gate === "ready" ? tb("lock.body") : t("unlock.body")}</p>
          {publicKey && <p className="mt-2 font-mono text-[11px] text-muted-foreground/80">{shortAddress(publicKey)}</p>}
        </div>
        <div className="mt-5 space-y-3">
          <BiometricUnlock state={bio} />
          <UnlockForm autoFocus={bio.wantPin} onIdleChange={setFormIdle} />
        </div>
        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          {t("unlock.forgot")}{" "}
          <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setForgotOpen(true)}>
            {t("unlock.forgotAction")}
          </button>
        </p>
      </div>
      <RemoveWalletDialog open={forgotOpen} onOpenChange={setForgotOpen} requirePin={false} />
    </div>
  );
}
