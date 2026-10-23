/**
 * The user's own charging sessions, read from Horizon (no Ficha backend):
 * payments FROM the wallet TO a station's host key, grouped by memo.
 */
import type { AssetRef, NetworkConfig } from "@/config";
import { addAmounts, compareAmounts, subtractAmounts, toStroops } from "@/stellar/amount";
import { sameAsset } from "@/stellar/horizon";
import type { StoredReceipt } from "./receipts-store";
import { parseFichaMemo } from "./sep7";

export interface MyPayment {
  id: string;
  txHash: string;
  createdAt: string;
  to: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  memo: string | null;
}

interface HorizonPayment {
  id: string;
  type: string;
  transaction_successful?: boolean;
  transaction_hash: string;
  created_at: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  transaction?: { memo_type?: string; memo?: string };
}

/**
 * Operation types the station credits (stellar.py ACCEPTED_TYPES). For both
 * path payments Horizon's `amount` and `asset_*` are the destination side.
 */
const PAYMENT_TYPES = new Set(["payment", "path_payment_strict_send", "path_payment_strict_receive"]);

/** A payment to a host key, from whichever account paid it. */
export interface HostPayment extends MyPayment {
  from: string;
}

interface ReadOpts {
  maxPages: number;
  /** Horizon paging token to start below (order=desc); none = from the newest. */
  cursor?: string;
  /** Stop after the page holding the first payment that closed before this time (ms). */
  stopBeforeMs?: number;
}

/**
 * Successful payment operations of `account` (newest first) that `keep`
 * wants, with their tx memo. `complete` is false when maxPages ran out before
 * the list (or stopBeforeMs) was reached.
 */
async function readPayments(net: NetworkConfig, account: string, opts: ReadOpts, keep: (r: HorizonPayment) => boolean): Promise<{ payments: HostPayment[]; complete: boolean }> {
  const out: HostPayment[] = [];
  let url: string | null =
    `${net.horizonUrl}/accounts/${account}/payments?join=transactions&order=desc&limit=200` + (opts.cursor ? `&cursor=${encodeURIComponent(opts.cursor)}` : "");
  for (let page = 0; url && page < opts.maxPages; page++) {
    const res: Response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return { payments: out, complete: true }; // account not on the ledger yet
    if (!res.ok) throw new Error(`Horizon HTTP ${res.status}`);
    const body = (await res.json()) as { _embedded?: { records?: HorizonPayment[] }; _links?: { next?: { href?: string } } };
    const records = body._embedded?.records ?? [];
    let reachedStop = false;
    for (const r of records) {
      if (opts.stopBeforeMs !== undefined && Date.parse(r.created_at) < opts.stopBeforeMs) reachedStop = true;
      if (!PAYMENT_TYPES.has(r.type) || r.transaction_successful === false || !r.from || !r.to || !r.amount || !keep(r)) continue;
      out.push({
        id: r.id,
        txHash: r.transaction_hash,
        createdAt: r.created_at,
        from: r.from,
        to: r.to,
        amount: r.amount,
        assetCode: r.asset_type === "native" ? "XLM" : (r.asset_code ?? ""),
        assetIssuer: r.asset_type === "native" ? null : (r.asset_issuer ?? null),
        memo: r.transaction?.memo_type === "text" ? (r.transaction.memo ?? null) : null,
      });
    }
    url = records.length === 200 && !reachedStop ? (body._links?.next?.href ?? null) : null;
  }
  return { payments: out, complete: url === null };
}

/** Outgoing payment operations of `account` (newest first), with their tx memo. */
export async function fetchMyPayments(net: NetworkConfig, account: string, maxPages = 5): Promise<MyPayment[]> {
  return (await readPayments(net, account, { maxPages }, (r) => r.from === account)).payments;
}

const sessionPayment = (hostKey: string, memo: string) => (r: HorizonPayment) =>
  r.to === hostKey && r.transaction?.memo_type === "text" && r.transaction.memo === memo;

/**
 * Every payment to `hostKey` with this session memo, whoever sent it (the
 * host's payments are public). The station caps a session as a whole, so
 * another wallet's fichas count against the cap too. Reads the host's newest
 * payments only: a session that can still take fichas is recent.
 */
export async function fetchSessionPayments(net: NetworkConfig, hostKey: string, memo: string, maxPages = 1): Promise<HostPayment[]> {
  return (await readPayments(net, hostKey, { maxPages }, sessionPayment(hostKey, memo))).payments;
}

/** Ledgers close about every 5 to 6 s: counting 4 s per ledger puts an estimate past the time asked. */
const MIN_LEDGER_SECONDS = 4;
/** Seconds after the receipt's finish time still read: the station's clock and the ledger's differ a little. */
const FINISH_GRACE_SECONDS = 120;
/**
 * How long before its paid time a session's first payment can have closed:
 * the wait for the phone before the countdown (usb_vbus), Horizon's lag to
 * the station and clock differences. Paid time never exceeds paidSeconds.
 */
const SESSION_SLACK_SECONDS = 15 * 60;

/**
 * A Horizon cursor (order=desc) just above the ledgers that can close by
 * `untilSec`, estimated from a payment whose ledger is known: an operation
 * id is its TOID, ledger sequence << 32. undefined when the id is not a TOID.
 */
export function cursorAfter(pivot: Pick<MyPayment, "id" | "createdAt">, untilSec: number): string | undefined {
  let ledger: bigint;
  try {
    ledger = BigInt(pivot.id) >> 32n;
  } catch {
    return undefined;
  }
  const at = Date.parse(pivot.createdAt) / 1000;
  if (ledger <= 0n || !Number.isFinite(at)) return undefined;
  const ahead = Math.max(0, Math.ceil((untilSec - at) / MIN_LEDGER_SECONDS)) + 2;
  return ((ledger + BigInt(ahead)) << 32n).toString();
}

type ReceiptRef = { memo: string; hostKey: string; assetCode: string; amount: string; finishedAt: number; paidSeconds: number };

/**
 * Every payment on the ledger to the receipt's host with its memo, from
 * whichever wallet, for a session paid by several wallets. Reads the HOST's
 * payments (join=transactions for the memo) from just after the receipt's
 * finish time back to the session's earliest possible start, bounded by
 * maxPages; the cursor comes from this wallet's own payment to the session.
 * `complete` is false when the pages ran out first.
 */
export async function fetchReceiptPayments(net: NetworkConfig, r: ReceiptRef, mine: MyPayment[], maxPages = 5): Promise<{ payments: HostPayment[]; complete: boolean }> {
  const own = paymentsFor(mine, r.memo, r.hostKey, r.assetCode).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const pivot = own.filter((p) => !paidAfter(p, r.finishedAt)).pop() ?? own.pop();
  return readPayments(
    net,
    r.hostKey,
    {
      maxPages,
      cursor: pivot ? cursorAfter(pivot, r.finishedAt + FINISH_GRACE_SECONDS) : undefined,
      stopBeforeMs: (r.finishedAt - r.paidSeconds - SESSION_SLACK_SECONDS) * 1000,
    },
    sessionPayment(r.hostKey, r.memo),
  );
}

/**
 * The session's payments from other accounts than `me` that the station
 * credits: its own asset only (stellar.py _matches_asset, code and issuer).
 */
export function othersFor(payments: HostPayment[], me: string, asset: AssetRef): HostPayment[] {
  return payments.filter((p) => p.from !== me && sameAsset(asset, { code: p.assetCode, issuer: p.assetIssuer }));
}

export interface Session {
  memo: string;
  /** Station ID from the memo prefix; null for a legacy memo. */
  stationId: string | null;
  hostKey: string;
  assetCode: string;
  assetIssuer: string | null;
  /** Sum of the user's payments with this memo. */
  amount: string;
  startedAt: string;
  txHashes: string[];
}

/**
 * The host keys whose payments are sessions: the registry's, those of stored
 * receipts, and every address this wallet paid with a legacy session memo.
 * The pay screen lets a legacy QR to a host outside the registry through
 * (override, one ficha) and then points to History, so that payment must be
 * listed before its receipt is scanned.
 */
export function sessionHosts(known: Iterable<string>, payments: MyPayment[]): Set<string> {
  const hosts = new Set(known);
  for (const p of payments) if (p.memo && parseFichaMemo(p.memo)?.kind === "legacy") hosts.add(p.to);
  return hosts;
}

/**
 * Payments to `hosts` with a Ficha session memo, grouped by memo (newest
 * first). Other memos to a host key (a tip, a bill) are not sessions.
 */
export function groupSessions(payments: MyPayment[], hosts: Set<string>): Session[] {
  const byMemo = new Map<string, Session>();
  for (const p of payments) {
    const fm = p.memo ? parseFichaMemo(p.memo) : null;
    if (!fm || !hosts.has(p.to)) continue;
    const key = `${p.to}|${fm.memo}`;
    const s = byMemo.get(key);
    if (s) {
      if (s.assetCode === p.assetCode && s.assetIssuer === p.assetIssuer) s.amount = addAmounts(s.amount, p.amount);
      if (p.createdAt < s.startedAt) s.startedAt = p.createdAt;
      s.txHashes.push(p.txHash);
    } else {
      byMemo.set(key, {
        memo: fm.memo,
        stationId: fm.kind === "station" ? fm.stationId : null,
        hostKey: p.to,
        assetCode: p.assetCode,
        assetIssuer: p.assetIssuer,
        amount: p.amount,
        startedAt: p.createdAt,
        txHashes: [p.txHash],
      });
    }
  }
  return [...byMemo.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** The user's payments that match a receipt's memo, host and asset code. */
export function paymentsFor(payments: MyPayment[], memo: string, hostKey: string, assetCode: string): MyPayment[] {
  return payments.filter((p) => p.memo === memo && p.to === hostKey && p.assetCode === assetCode);
}

export interface CrossCheck {
  check: "confirmed" | "not_confirmed";
  /** i18n key suffix under pay.check.* when not confirmed. */
  reason?: "noPayment" | "amountDiffers";
  /** When confirmed: what the user paid with this memo after the session ended (not credited). */
  uncredited?: string;
  /** When confirmed: the user's own payments the station credited, out of `total` (the receipt amount). */
  share?: string;
  total?: string;
  payments: MyPayment[];
}

function sumAmounts(ps: Pick<MyPayment, "amount">[]): string {
  let total = "0";
  for (const p of ps) total = addAmounts(total, p.amount);
  return total;
}

/** Closed on the ledger after the receipt's finish time: the station logged it as orphan. */
function paidAfter(p: Pick<MyPayment, "createdAt">, finishedAt: number): boolean {
  return Date.parse(p.createdAt) > finishedAt * 1000;
}

/**
 * The session's payments on the ledger, from every wallet (fetchReceiptPayments),
 * and what the registry says the station credits: its asset (code AND issuer)
 * and, per payment, at least one ficha (stellar.py / session.py).
 */
export interface SessionLedger {
  payments: HostPayment[];
  asset?: AssetRef;
  fichaPrice?: string;
}

/**
 * 'Conferido na blockchain' when the payments with this memo to this host
 * add up to the receipt amount:
 *  - the user's own payments (one wallet paid the session), or
 *  - with `ledger`, every wallet's payments the station credits (several
 *    wallets paid it); the user's `share` is then less than the `total`.
 * A payment that closed on the ledger after the receipt's finish time (paid
 * in the last seconds of the countdown, say) was logged by the station as
 * orphan, not credited: the receipt is then confirmed by the payments up to
 * its finish time, and the user's later ones are returned as `uncredited`
 * (refund only by hand).
 */
export function crossCheckReceipt(
  r: { memo: string; hostKey: string; assetCode: string; amount: string; finishedAt: number },
  payments: MyPayment[],
  ledger?: SessionLedger,
): CrossCheck {
  const mine = paymentsFor(payments, r.memo, r.hostKey, r.assetCode);
  if (mine.length === 0) return { check: "not_confirmed", reason: "noPayment", payments: mine };
  const late = mine.filter((p) => paidAfter(p, r.finishedAt));
  const onTime = mine.filter((p) => !late.includes(p));
  const uncredited = late.length > 0 ? sumAmounts(late) : undefined;
  if (compareAmounts(sumAmounts(mine), r.amount) === 0) return { check: "confirmed", share: r.amount, total: r.amount, payments: mine };
  if (late.length > 0 && onTime.length > 0 && compareAmounts(sumAmounts(onTime), r.amount) === 0) {
    return { check: "confirmed", uncredited, share: r.amount, total: r.amount, payments: mine };
  }
  if (ledger && onTime.length > 0) {
    const credits = (p: MyPayment) =>
      p.to === r.hostKey &&
      p.memo === r.memo &&
      !paidAfter(p, r.finishedAt) &&
      (ledger.asset ? sameAsset(ledger.asset, { code: p.assetCode, issuer: p.assetIssuer }) : p.assetCode === r.assetCode && (r.assetCode !== "XLM" || p.assetIssuer === null)) &&
      (!ledger.fichaPrice || compareAmounts(p.amount, ledger.fichaPrice) >= 0);
    // This wallet's own payments are in the host's list too; Horizon may lag on one of the two.
    const byId = new Map<string, MyPayment>();
    for (const p of [...ledger.payments, ...onTime]) if (credits(p)) byId.set(p.id, p);
    const share = sumAmounts(onTime.filter(credits));
    if (compareAmounts(share, "0") > 0 && compareAmounts(sumAmounts([...byId.values()]), r.amount) === 0) {
      return { check: "confirmed", uncredited, share, total: r.amount, payments: mine };
    }
  }
  return { check: "not_confirmed", reason: "amountDiffers", payments: mine };
}

/**
 * A receipt the user's own payments do not add up to, though some of them
 * were paid before it finished: another wallet may have paid the session
 * too, and only the host's payments (fetchReceiptPayments) can tell.
 */
export function mayBeShared(r: { memo: string; hostKey: string; assetCode: string; amount: string; finishedAt: number }, payments: MyPayment[]): boolean {
  const onTime = paymentsFor(payments, r.memo, r.hostKey, r.assetCode).filter((p) => !paidAfter(p, r.finishedAt));
  return onTime.length > 0 && compareAmounts(sumAmounts(onTime), r.amount) < 0;
}

/**
 * A stored receipt checked again against freshly fetched payments (and, for
 * a shared session, the host's): confirmed when they now add up (it was
 * scanned offline, or before its payment reached Horizon, or before a late
 * payment was split off by the receipt's finish time), else returned
 * unchanged. A confirmation is never taken back here.
 */
export function recheckReceipt(stored: StoredReceipt, payments: MyPayment[], ledger?: SessionLedger): StoredReceipt {
  if (stored.check === "confirmed") return stored;
  const c = crossCheckReceipt(stored.receipt, payments, ledger);
  if (c.check !== "confirmed") return stored;
  return { ...stored, check: "confirmed", reason: undefined, share: c.share };
}

/**
 * This wallet's part of a session, as a fraction of its receipt: share /
 * total when several wallets paid it (confirmed), else 1. History counts only
 * the user's own payments (contract §3), so it scales the session's unused
 * paid time and energy by it: each payer is not told to ask for the whole.
 */
export function receiptShareFraction(stored: Pick<StoredReceipt, "check" | "share" | "receipt">): number {
  if (stored.check !== "confirmed" || !stored.share) return 1;
  const share = toStroops(stored.share);
  const total = toStroops(stored.receipt.amount);
  if (total <= 0n || share >= total) return 1;
  return Number(share) / Number(total);
}

export type ReceiptStanding = { state: "confirmed" } | { state: "not_confirmed" } | { state: "uncredited"; extra: string };

/**
 * What History shows for a session with a stored receipt. A stored
 * confirmation is never downgraded (saveReceipt), so it is compared here with
 * what the wallet paid in total for the session against its own share of the
 * receipt (the whole receipt unless several wallets paid it): more means
 * payments made after the station closed the session, which it logged as
 * orphan and did not credit (refund only by hand). That holds whether they
 * were paid before the receipt was scanned or after (crossCheckReceipt).
 */
export function receiptStanding(row: Pick<Session, "amount" | "assetCode">, stored: StoredReceipt): ReceiptStanding {
  if (stored.check !== "confirmed" || row.assetCode !== stored.receipt.assetCode) return { state: "not_confirmed" };
  const share = stored.share ?? stored.receipt.amount;
  const cmp = compareAmounts(row.amount, share);
  if (cmp === 0) return { state: "confirmed" };
  if (cmp > 0) return { state: "uncredited", extra: subtractAmounts(row.amount, share) };
  return { state: "not_confirmed" };
}
