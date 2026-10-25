/**
 * A refund due, as the station shows it (docs/station-app-contract.md): a
 * SEP-0007 pay URI that the HOST pays back to the PAYER. A direct-mode
 * station holds no key and cannot refund, so it shows each refund as a QR
 * for the host's mobile wallet and as a link to /refund, where the Freighter
 * extension signs it (src/refund/freighter.ts).
 *
 *   web+stellar:pay?destination=<payer>&amount=<a>&memo=refund%20<REF>&memo_type=MEMO_TEXT&msg=...
 *
 * <REF> is the session ID "<STATION_ID>.<SESSION>", or for a payment the
 * station did not credit "<STATION_ID>.tx<first 8 hex of its hash>" (or
 * "tx<first 12 hex>", which names no station and is never signed here).
 * The station ID is resolved in the signed registry of the URI's network:
 * the signer must be that station's host_key. The destination is the URI's,
 * which the station writes from its own log: never one from a wallet's
 * history (address poisoning sends the host look-alike payments). The
 * ledger only limits it (checkLedger): at most what that destination paid
 * the host under REF, and nothing once the host sent it a refund with REF.
 */
import { NETWORKS, type NetworkConfig } from "@/config";
import { fetchPaymentsBetween, type HostPayment } from "@/pay/history";
import { isCustody, stationById, type Registry, type Station } from "@/registry/verify";
import { compareAmounts, fromStroops, toStroops } from "@/stellar/amount";
import { sameAsset } from "@/stellar/horizon";
import { Sep7Error, parseFichaMemo, parseSep7Pay, requestPassphrase, type PayRequest } from "@/pay/sep7";

const A = "[2-9A-HJKMNP-TV-Z]";
const PAYMENT_RE = new RegExp(`^(${A}{6})\\.tx([0-9a-fA-F]{8})$`);
const BARE_PAYMENT_RE = /^tx([0-9a-fA-F]{12})$/;

/** What a refund pays back: a session, or one payment the station did not credit. */
export type RefundRef =
  | { kind: "session"; stationId: string; session: string }
  | { kind: "payment"; stationId: string | null; tx: string };

export interface RefundRequest {
  /** The parsed URI: destination (the payer), asset, memo ("refund <REF>"). */
  req: PayRequest;
  /** Always present and > 0, at most 7 decimals. */
  amount: string;
  /** The text after "refund ". */
  refText: string;
  ref: RefundRef;
  /** The URI's network (no network_passphrase = the public one), whatever the app's own setting. */
  net: NetworkConfig;
}

export class RefundError extends Error {
  constructor(public code: Sep7Error["code"] | "not_refund" | "bad_network") {
    super(`refund: ${code}`);
    this.name = "RefundError";
  }
}

/** "<STATION_ID>.<SESSION>", "<STATION_ID>.tx<8 hex>" or "tx<12 hex>"; anything else is null. */
export function parseRefundRef(ref: string): RefundRef | null {
  const session = parseFichaMemo(ref);
  if (session?.kind === "station") return { kind: "session", stationId: session.stationId, session: session.session };
  const m = PAYMENT_RE.exec(ref);
  if (m) return { kind: "payment", stationId: m[1], tx: m[2].toLowerCase() };
  const b = BARE_PAYMENT_RE.exec(ref);
  if (b) return { kind: "payment", stationId: null, tx: b[1].toLowerCase() };
  return null;
}

/** The app's network for a passphrase, or null for one it does not know. */
export function networkFor(passphrase: string): NetworkConfig | null {
  return Object.values(NETWORKS).find((n) => n.passphrase === passphrase) ?? null;
}

/** Parse a station's refund URI. Throws RefundError; nothing that fails here is shown as payable. */
export function parseRefundUri(uri: string): RefundRequest {
  let req: PayRequest;
  try {
    req = parseSep7Pay(uri);
  } catch (e) {
    throw new RefundError(e instanceof Sep7Error ? e.code : "not_pay");
  }
  // parseSep7Pay refuses zero, negatives and more than 7 decimals; a refund must also name its amount.
  if (req.amount === null) throw new RefundError("bad_amount");
  const m = /^refund (.+)$/.exec(req.memo);
  const ref = m ? parseRefundRef(m[1]) : null;
  if (!m || !ref) throw new RefundError("not_refund");
  const net = networkFor(requestPassphrase(req));
  if (!net) throw new RefundError("bad_network");
  return { req, amount: req.amount, refText: m[1], ref, net };
}

/**
 * The most a refund of one of this station's sessions can be: a whole
 * session at the registry price, plus one ficha (a payment's change).
 * Exact in stroops, rounded up.
 */
export function refundCap(st: Pick<Station, "ficha_price" | "ficha_minutes" | "max_session_minutes">): string {
  const price = toStroops(st.ficha_price);
  const minutes = BigInt(st.ficha_minutes);
  const session = (price * BigInt(st.max_session_minutes) + minutes - 1n) / minutes;
  return fromStroops(session + price);
}

export type RefundCheck =
  | { state: "ok"; station: Station; cap: string }
  /** "tx<12 hex>": no station ID, so no host to check the signer against. */
  | { state: "no_station" }
  /** The network's signed registry could not be loaded and verified. */
  | { state: "no_registry"; stationId: string }
  | { state: "unknown_station"; stationId: string }
  | { state: "inactive"; station: Station }
  /** A custody station refunds by proof, through the contract (contract §7). */
  | { state: "custody"; station: Station }
  /** The cap is in the station's asset: a refund in another one is refunded by hand. */
  | { state: "asset_mismatch"; station: Station }
  | { state: "over_cap"; station: Station; cap: string };

/** The refund against the signed registry of its network. Only "ok" may be signed. */
export function checkRefund(r: RefundRequest, reg: Registry | null): RefundCheck {
  const id = r.ref.stationId;
  if (id === null) return { state: "no_station" };
  if (!reg || reg.network !== r.net.id) return { state: "no_registry", stationId: id };
  const station = stationById(reg, id);
  if (!station) return { state: "unknown_station", stationId: id };
  if (isCustody(station)) return { state: "custody", station };
  if (!station.active) return { state: "inactive", station };
  if (!sameAsset(station.asset, r.req.asset)) return { state: "asset_mismatch", station };
  const cap = refundCap(station);
  if (compareAmounts(r.amount, cap) > 0) return { state: "over_cap", station, cap };
  return { state: "ok", station, cap };
}

/** Pages of the host's payments read for a refund, 200 each, newest first. */
export const LEDGER_PAGES = 10;

export type LedgerCheck =
  /** `paid`: the destination's payments to the host under REF, `total` of them, which covers the amount. */
  | { state: "ok"; paid: HostPayment[]; total: string }
  /** No payment by the destination to the host under REF, in the refund's asset. `complete`: the host's whole list was read. */
  | { state: "no_payment"; complete: boolean }
  /** The amount is more than the `total` the destination paid under REF. */
  | { state: "more_than_paid"; paid: HostPayment[]; total: string }
  /** The host already sent the destination, in the refund's asset, `refunded` with this memo: signing again may pay it twice. */
  | { state: "refunded"; paid: HostPayment[]; refunds: HostPayment[]; refunded: string };

const sum = (ps: HostPayment[]) => fromStroops(ps.reduce((s, p) => s + toStroops(p.amount), 0n));

/**
 * The refund against the payments between the host and the destination
 * (fetchPaymentsBetween). Any payment the host already sent it with the
 * memo "refund <REF>", in the refund's asset, blocks: the page cannot tell
 * the same refund paid again (from a second tab, an old link, the phone's
 * QR, or the station still showing it) from a remainder the station asks
 * for after seeing that one. Otherwise the destination must have paid the
 * host under REF, in the refund's asset, at least the amount. Under REF:
 * with the session as memo, or, for a payment's REF, in a transaction whose
 * hash starts with its hex and for at least one ficha (less, naming none of
 * the station's sessions, is dust, which the station never refunds). A
 * session's count whatever their amount: below one ficha, under a session
 * the station served, it is underpaid or an orphan, refunded in full. A
 * link from anywhere can so at most return a payer's own money to that
 * payer, once. Only "ok" may be signed.
 */
export function checkLedger(r: RefundRequest, station: Pick<Station, "host_key" | "ficha_price">, payments: HostPayment[], complete: boolean): LedgerCheck {
  const host = station.host_key;
  const dest = r.req.destination;
  const ref = r.ref;
  const inAsset = (p: HostPayment) => sameAsset(r.req.asset, { code: p.assetCode, issuer: p.assetIssuer });
  const underRef = (p: HostPayment) =>
    ref.kind === "session" ? p.memo === r.refText : p.txHash.toLowerCase().startsWith(ref.tx) && compareAmounts(p.amount, station.ficha_price) >= 0;
  const paid = payments.filter((p) => p.from === dest && p.to === host && inAsset(p) && underRef(p));
  const refunds = payments.filter((p) => p.from === host && p.to === dest && inAsset(p) && p.memo === r.req.memo);
  if (refunds.length > 0) return { state: "refunded", paid, refunds, refunded: sum(refunds) };
  if (paid.length === 0) return { state: "no_payment", complete };
  const total = sum(paid);
  if (compareAmounts(r.amount, total) > 0) return { state: "more_than_paid", paid, total };
  return { state: "ok", paid, total };
}

/** checkLedger on the host's newest payments, on the refund's network. Throws when Horizon cannot be read. */
export async function readRefundLedger(r: RefundRequest, station: Pick<Station, "host_key" | "ficha_price">): Promise<LedgerCheck> {
  const { payments, complete } = await fetchPaymentsBetween(r.net, station.host_key, r.req.destination, LEDGER_PAGES);
  return checkLedger(r, station, payments, complete);
}
