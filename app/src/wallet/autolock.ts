/**
 * Auto-lock: drop the in-memory key after WALLET.hiddenLockMs in the
 * background, so the wallet asks again only when the user opens the app. In
 * the Android app that is all: it never locks while in use (unlocking there is
 * a biometric check). On the web, with no biometrics, it also locks after
 * WALLET.idleLockMs without a touch or key press. Mounted once in the root
 * layout. Timers can be frozen in the background, so the elapsed
 * time is also checked when the app becomes visible again.
 */
import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { WALLET } from "@/config";
import { useWallet } from "./store";

export function useAutoLock(): void {
  const status = useWallet((s) => s.status);
  const lock = useWallet((s) => s.lock);

  useEffect(() => {
    if (status !== "unlocked") return;
    let lastActivity = Date.now();
    let hiddenAt: number | null = null;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;

    const touch = () => {
      lastActivity = Date.now();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        hiddenTimer = setTimeout(lock, WALLET.hiddenLockMs);
      } else {
        clearTimeout(hiddenTimer);
        if (hiddenAt !== null && Date.now() - hiddenAt >= WALLET.hiddenLockMs) lock();
        hiddenAt = null;
        touch();
      }
    };
    const idleCheck = Capacitor.isNativePlatform()
      ? undefined
      : setInterval(() => {
          if (Date.now() - lastActivity >= WALLET.idleLockMs) lock();
        }, 10_000);

    const events = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(idleCheck);
      clearTimeout(hiddenTimer);
      events.forEach((e) => window.removeEventListener(e, touch));
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [status, lock]);
}
