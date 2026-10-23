import { useEffect, useRef, useState, type FormEvent } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n";
import { formatWait } from "@/lib/format";
import { PinLockedError, usePinWait, useWallet } from "@/wallet";
import { offerBiometricAfterPin } from "@/wallet/biometric-offer";

/**
 * PIN prompt that unlocks the wallet. Used by the lock screen and <RequireUnlocked>.
 * `autoFocus` focuses the field when it turns true (the lock screen keeps it
 * false while the biometric prompt is the way in). After a PIN unlock the app
 * may ask, once, whether to use biometrics from then on. `onIdleChange`: the
 * field is empty, no check is running and no error is shown.
 */
export function UnlockForm({
  onUnlocked,
  autoFocus = true,
  onIdleChange,
}: {
  onUnlocked?: () => void;
  autoFocus?: boolean;
  onIdleChange?: (idle: boolean) => void;
}) {
  const t = useT("wallet");
  const unlock = useWallet((s) => s.unlock);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wait = usePinWait();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const idle = pin === "" && !busy && !error;
  useEffect(() => {
    onIdleChange?.(idle);
  }, [idle, onIdleChange]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pin || busy || wait > 0) return;
    setBusy(true);
    setError(null);
    try {
      if (await unlock(pin)) {
        void offerBiometricAfterPin(pin).catch(() => {});
        onUnlocked?.();
      } else setError(t("pin.wrong"));
    } catch (err) {
      // PinLockedError: the wait below says it all.
      if (!(err instanceof PinLockedError)) setError(String(err));
    } finally {
      setBusy(false);
      setPin("");
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="unlock-pin">{t("pin.label")}</Label>
        <Input
          id="unlock-pin"
          type="password"
          autoComplete="current-password"
          ref={inputRef}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          className="h-11 text-center font-mono tracking-[0.3em]"
        />
        {wait > 0 ? (
          <p className="text-[12px] text-destructive" role="alert">
            {t("pin.wait", { time: formatWait(wait) })}
          </p>
        ) : (
          error && <p className="text-[12px] text-destructive">{error}</p>
        )}
      </div>
      <Button type="submit" className="h-11 w-full" disabled={busy || !pin || wait > 0}>
        {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
        {busy ? t("pin.checking") : t("unlock.action")}
      </Button>
    </form>
  );
}
