import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Fingerprint, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useWallet } from "@/wallet";
import { currentBiometricGate, MAX_BIOMETRIC_FAILURES, type BiometricFailure, type BiometricGate } from "@/wallet/biometric";

type T = ReturnType<typeof useT>;

/** Why the PIN is needed now, in words; null when the lock screen needs no explanation. */
function noticeFor(t: T, reason: BiometricFailure): string | null {
  switch (reason) {
    case "pin-due":
      return t("lock.pinDue");
    case "paused":
      return t("lock.paused", { n: MAX_BIOMETRIC_FAILURES });
    case "lockout":
      return t("lock.lockout");
    case "invalidated":
      return t("lock.invalidated");
    case "stale":
      return t("lock.stale");
    case "unavailable":
      return t("lock.unavailable");
    case "failed":
      return t("lock.failed");
    default:
      return null; // cancelled, interrupted, busy, off, unsupported
  }
}

export interface BiometricUnlockState {
  /** null while loading; "ready": offer the biometric button. */
  gate: BiometricGate | null;
  busy: boolean;
  notice: string | null;
  /** The PIN field should take the focus (biometrics are not the way right now, or the user closed the prompt). */
  wantPin: boolean;
  run: () => void;
}

/**
 * Lock screen side of src/wallet/biometric.ts: opens the biometric prompt by
 * itself once the lock screen is visible and the rules allow it, again when
 * the app comes back after the system closed it, and never again after the
 * user closed it (the button reopens it).
 */
export function useBiometricUnlock(): BiometricUnlockState {
  const t = useT("biometric");
  const unlockWithBiometric = useWallet((s) => s.unlockWithBiometric);
  const [gate, setGate] = useState<BiometricGate | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [wantPin, setWantPin] = useState(false);
  const gateRef = useRef<BiometricGate | null>(null);
  const busyRef = useRef(false);
  /** Still allowed to open the prompt without a tap. */
  const autoRef = useRef(true);

  const text = useMemo(() => ({ title: t("prompt.unlockTitle"), subtitle: t("prompt.unlockSubtitle"), cancel: t("prompt.usePin") }), [t]);

  const applyGate = useCallback((g: BiometricGate) => {
    gateRef.current = g;
    setGate(g);
    if (g !== "ready") setWantPin(true);
  }, []);

  const run = useCallback(async () => {
    if (busyRef.current || gateRef.current !== "ready") return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const r = await unlockWithBiometric(text);
      if (r.ok) return; // the root layout replaces the lock screen
      if (r.reason !== "interrupted" && r.reason !== "busy") {
        autoRef.current = false;
        setWantPin(true);
      }
      const g = await currentBiometricGate();
      applyGate(g);
      setNotice(noticeFor(t, r.reason) ?? (g === "paused" ? noticeFor(t, "paused") : null));
    } catch {
      autoRef.current = false;
      setWantPin(true);
      setNotice(t("lock.failed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [applyGate, t, text, unlockWithBiometric]);

  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    let alive = true;
    const auto = () => {
      if (alive && autoRef.current && gateRef.current === "ready" && document.visibilityState === "visible") void runRef.current();
    };
    void currentBiometricGate().then((g) => {
      if (!alive) return;
      applyGate(g);
      if (g === "pin-due" || g === "paused") setNotice(noticeFor(t, g));
      auto();
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") auto();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
    // Once per lock screen (a language change must not reopen the prompt).
  }, []);

  return { gate, busy, notice, wantPin, run: () => void run() };
}

/** The "unlock with biometrics" button and the reason the PIN is needed, if any. */
export function BiometricUnlock({ state }: { state: BiometricUnlockState }) {
  const t = useT("biometric");
  if (state.gate !== "ready" && !state.notice) return null;
  return (
    <div className="space-y-2">
      {state.gate === "ready" && (
        <Button type="button" variant="outline" className="h-11 w-full" disabled={state.busy} onClick={state.run}>
          {state.busy ? <Loader2 className="animate-spin" /> : <Fingerprint />}
          {t("lock.action")}
        </Button>
      )}
      {state.notice && (
        <p className="text-center text-[12px] text-muted-foreground" role="status">
          {state.notice}
        </p>
      )}
    </div>
  );
}
