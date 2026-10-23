/**
 * Balances of the wallet's account on the active network. Polls every 15 s
 * while the app is visible; pauses in the background. `refresh()` forces a read
 * (call it after submitting a transaction). While a new wallet's testnet
 * activation is still under way (src/stellar/horizon.ts pendingActivation),
 * `activating` is true and the account is read again as soon as it ends.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAccountSummary, pendingActivation, useNetwork, type AccountSummary } from "@/stellar";
import { useWallet } from "@/wallet";

export interface AccountSummaryState {
  data: AccountSummary | null;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  /** Friendbot is activating this account right now: "not active" is not the news to show. */
  activating: boolean;
}

export function useAccountSummary(pollMs = 15_000): AccountSummaryState {
  const net = useNetwork();
  const publicKey = useWallet((s) => s.publicKey);
  const [data, setData] = useState<AccountSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [activating, setActivating] = useState(false);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (!publicKey) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const s = await fetchAccountSummary(net, publicKey);
      if (mine === seq.current) {
        setData(s);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [net, publicKey]);

  // A new wallet's activation under way: say so, and read the account again once it ends.
  useEffect(() => {
    const run = publicKey ? pendingActivation(net, publicKey) : undefined;
    if (!run) {
      setActivating(false);
      return;
    }
    let alive = true;
    setActivating(true);
    void run.finally(async () => {
      if (!alive) return;
      await refresh();
      if (alive) setActivating(false);
    });
    return () => {
      alive = false;
    };
  }, [net, publicKey, refresh]);

  useEffect(() => {
    setData(null);
    void refresh();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, pollMs);
    const onVis = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh, pollMs]);

  return { data, loading, error, refresh, activating };
}
