/**
 * The last payment the Pay screen sent, kept outside the route.
 *
 * Auto-lock swaps the page for the root lock screen, and Back from History
 * mounts it again: with the success screen only in the page's state, the same
 * session's Pay form came back with its button enabled. Paid again once the
 * session has ended, the station logs it as orphan and delivers nothing (no
 * automatic refund). Kept here, the page shows the payment it already sent.
 * Scanning a station QR is a new request (more fichas while the session
 * runs) and forgets it.
 *
 * Memory only, as src/buy/session.ts. Keyed by network, account, host key and
 * memo, so another wallet, network or session never sees it. A custody
 * deposit (src/routes/p.tsx) is kept the same way, under its session's name
 * (`<STATION_ID>.<SESSION>`), with its deadline.
 */
import type { NetworkId } from "@/config";

export interface LastPayment {
  hash: string;
  n: number;
  amount: string;
  minutes: number | null;
  at: number;
  /** This wallet had already paid the session: the fichas add to its time left. */
  extended: boolean;
  /** Custody mode: the session's deadline (ledger unix seconds), the last moment to claim the unused time. */
  deadline?: number;
}

type Key = { net: NetworkId; account: string; hostKey: string; memo: string };

let current: (LastPayment & Key) | null = null;

export function loadLastPayment(net: NetworkId, account: string, hostKey: string, memo: string): LastPayment | null {
  if (!current || current.net !== net || current.account !== account || current.hostKey !== hostKey || current.memo !== memo) return null;
  const { hash, n, amount, minutes, at, extended, deadline } = current;
  return { hash, n, amount, minutes, at, extended, ...(deadline !== undefined ? { deadline } : {}) };
}

export function saveLastPayment(net: NetworkId, account: string, hostKey: string, memo: string, payment: LastPayment): void {
  current = { ...payment, net, account, hostKey, memo };
}

export function forgetLastPayment(): void {
  current = null;
}
