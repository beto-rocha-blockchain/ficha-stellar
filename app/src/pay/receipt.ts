/**
 * Receipt QR (docs/station-app-contract.md §3):
 *   <APP_URL>/r?v=1&m=&n=&h=&a=&k=&f=&p=&u=&wh=&x=&vd=&c=&t=   or   ficha:/r?v=1&...
 * Unsigned: the station's statement, cross-checked against the user's own payment.
 * A custody session's receipt is v=2 (§7.6): the same fields plus the refund
 * proof, q=<unused units>&z=<c[N-q], base64url>, checked against the
 * anchor of the user's own deposit.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { isB64url32 } from "@/custody/chain";
import { isValidAmount } from "@/stellar/amount";

export type Verdict = "delivered" | "no_current" | "unverified";

export interface Receipt {
  memo: string;
  network: "testnet" | "public";
  hostKey: string;
  amount: string;
  assetCode: string;
  fichas: number;
  paidSeconds: number;
  usedSeconds: number;
  wh: number;
  maxMa: number;
  verdict: Verdict;
  cutConfirmed: boolean;
  /** Unix seconds. */
  finishedAt: number;
  /** 2 = custody, with `refund`; absent = 1, direct mode. */
  version?: 2;
  /** v2 only: the station's proof that `units` units of paid time were not delivered. */
  refund?: { units: number; proof: string };
}

/** The longest chain a custody station may use (contract §7.1): q is at most this. */
const MAX_CHAIN = 256;
const CUSTODY_MEMO_RE = /^[2-9A-HJKMNP-TV-Z]{6}\.F[2-9A-HJKMNP-TV-Z]{7}$/;

export function isCustodyReceipt(r: Receipt): r is Receipt & { version: 2; refund: { units: number; proof: string } } {
  return r.version === 2 && r.refund !== undefined;
}

export class ReceiptError extends Error {
  constructor(public field: string) {
    super(`receipt: bad or missing ${field}`);
    this.name = "ReceiptError";
  }
}

/** True for `ficha:/r?...`, `ficha://r?...`, `/r?...` or `http(s)://host/.../r?...` carrying v= and m=. */
export function isReceiptUri(text: string): boolean {
  const s = text.trim();
  const q = receiptQuery(s);
  return q !== null && q.has("v") && q.has("m");
}

function receiptQuery(s: string): URLSearchParams | null {
  const m = /^(?:ficha:\/{0,2}|https?:\/\/[^?#\s]*?)?\/?r\?([^#\s]*)$/i.exec(s);
  if (!m) return null;
  // For http(s) the path must end in /r (not e.g. /bar?...).
  if (/^https?:/i.test(s) && !/^https?:\/\/[^/?#]+(?:\/[^?#]*)?\/r\?/i.test(s)) return null;
  return new URLSearchParams(m[1]);
}

/** The query string part of a receipt URI (for routing to /r). */
export function receiptSearch(text: string): string | null {
  const s = text.trim();
  if (!isReceiptUri(s)) return null;
  return s.slice(s.indexOf("?") + 1);
}

const VERDICTS: Record<string, Verdict> = { d: "delivered", n: "no_current", u: "unverified" };

function int(q: URLSearchParams, k: string): number {
  const v = q.get(k);
  if (v === null || !/^\d+$/.test(v)) throw new ReceiptError(k);
  return Number(v);
}

/** Parse from a full URI or a bare query string (`v=1&m=...`). */
export function parseReceipt(input: string | URLSearchParams): Receipt {
  let q: URLSearchParams;
  if (typeof input === "string") {
    const s = input.trim();
    q = receiptQuery(s) ?? new URLSearchParams(s.replace(/^\?/, ""));
  } else {
    q = input;
  }
  const v = q.get("v");
  if (v !== "1" && v !== "2") throw new ReceiptError("v");
  const memo = q.get("m") ?? "";
  if (!memo || new TextEncoder().encode(memo).length > 28) throw new ReceiptError("m");
  // A custody session always has a station ID: m names the contract's station and session.
  if (v === "2" && !CUSTODY_MEMO_RE.test(memo)) throw new ReceiptError("m");
  const n = q.get("n");
  if (n !== "t" && n !== "p") throw new ReceiptError("n");
  const hostKey = q.get("h") ?? "";
  if (!StrKey.isValidEd25519PublicKey(hostKey)) throw new ReceiptError("h");
  const amount = q.get("a") ?? "";
  if (!isValidAmount(amount)) throw new ReceiptError("a");
  const assetCode = q.get("k") ?? "";
  if (!/^[A-Za-z0-9]{1,12}$/.test(assetCode)) throw new ReceiptError("k");
  const whRaw = q.get("wh") ?? "";
  if (!/^\d+(\.\d+)?$/.test(whRaw)) throw new ReceiptError("wh");
  const verdict = VERDICTS[q.get("vd") ?? ""];
  if (!verdict) throw new ReceiptError("vd");
  const c = q.get("c");
  if (c !== "0" && c !== "1") throw new ReceiptError("c");
  let refund: Receipt["refund"];
  if (v === "2") {
    const units = int(q, "q");
    if (units > MAX_CHAIN) throw new ReceiptError("q");
    const proof = q.get("z") ?? "";
    if (!isB64url32(proof)) throw new ReceiptError("z");
    refund = { units, proof };
  }
  return {
    memo,
    network: n === "p" ? "public" : "testnet",
    hostKey,
    amount,
    assetCode,
    fichas: int(q, "f"),
    paidSeconds: int(q, "p"),
    usedSeconds: int(q, "u"),
    wh: Number(whRaw),
    maxMa: int(q, "x"),
    verdict,
    cutConfirmed: c === "1",
    finishedAt: int(q, "t"),
    ...(refund ? { version: 2 as const, refund } : {}),
  };
}

const VERDICT_LETTER: Record<Verdict, string> = { delivered: "d", no_current: "n", unverified: "u" };

/** A number as the receipt writes it: plain decimals, never 1e-7. */
function plain(n: number): string {
  const s = String(n);
  return /e/i.test(s) ? n.toFixed(10).replace(/0+$/, "").replace(/\.$/, "") : s;
}

/**
 * The query string of a receipt (no "?"), the one parseReceipt reads back:
 * a receipt kept on the phone, opened again on /r (a custody claim from
 * History or /p, docs/station-app-contract.md §7.6).
 */
export function receiptToQuery(r: Receipt): string {
  const q = new URLSearchParams();
  q.set("v", r.version === 2 ? "2" : "1");
  q.set("m", r.memo);
  q.set("n", r.network === "public" ? "p" : "t");
  q.set("h", r.hostKey);
  q.set("a", r.amount);
  q.set("k", r.assetCode);
  q.set("f", String(r.fichas));
  q.set("p", String(r.paidSeconds));
  q.set("u", String(r.usedSeconds));
  q.set("wh", plain(r.wh));
  q.set("x", String(r.maxMa));
  q.set("vd", VERDICT_LETTER[r.verdict]);
  q.set("c", r.cutConfirmed ? "1" : "0");
  q.set("t", String(r.finishedAt));
  if (r.refund) {
    q.set("q", String(r.refund.units));
    q.set("z", r.refund.proof);
  }
  return q.toString();
}

/**
 * Paid seconds the station did not deliver (p - u: unused or capped), which
 * it logs for a manual refund (contract §3). Any remainder counts: a pause or
 * an ESC can leave a few seconds, and the station logs them all.
 */
export function unusedSeconds(r: Pick<Receipt, "paidSeconds" | "usedSeconds">): number {
  return Math.max(0, r.paidSeconds - r.usedSeconds);
}
