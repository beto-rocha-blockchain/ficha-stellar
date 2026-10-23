/**
 * Milliseconds left before the next PIN try is allowed (0: right away), ticking
 * every second. Every PIN prompt disables its button and shows the wait while
 * this is above 0; useWallet refuses the try anyway (PinLockedError).
 */
import { useEffect, useState } from "react";
import { useWallet } from "./store";

export function usePinWait(): number {
  const retryAt = useWallet((s) => s.pinRetryAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (retryAt === null) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= retryAt) clearInterval(id);
    }, 1000);
    setNow(Date.now());
    return () => clearInterval(id);
  }, [retryAt]);

  return retryAt === null ? 0 : Math.max(0, retryAt - now);
}
