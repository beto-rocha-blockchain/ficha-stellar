/**
 * A custody receipt (v=2) checked against the payer's OWN deposit
 * (docs/station-app-contract.md §7.6, steps 1 to 4 and 6): the deposit kept
 * on the phone (or, failing that, the session or the events on the ledger),
 * the proof hashed forward to that deposit's anchor, q against p, u and the
 * unit, and the session's state on the contract.
 */
import type { NetworkConfig } from "@/config";
import { isCustodyReceipt, receiptToQuery, type Receipt } from "@/pay/receipt";
import type { StoredReceipt } from "@/pay/receipts-store";
import { isCustody, stationById, type Registry } from "@/registry/verify";
import { isValidAmount, toStroops } from "@/stellar/amount";
import { MAX_CHAIN, fromB64url, hashForward, paidUnits, payerShare, proofLeadsToAnchor, sameBytes, toB64url, unusedUnits } from "./chain";
import { findDeposits, saveDeposit, type DepositRecord } from "./deposits-store";
import {
  fetchEscrowEvents,
  ledgerTime,
  parseEscrowEvent,
  readEscrow,
  scanEvents,
  sessionEventFilters,
  type DepositEvent,
  type EscrowSession,
  type Rpc,
  type SettleEvent,
} from "./escrow";
import { ledgerWasReset } from "./check";
import { applyEvents, findSettle, maybeOpen, registryContext, settledFrom, withSession } from "./sessions";

export interface ReceiptFacts {
  /** The receipt's amount, fichas, asset and paid time are the deposit's. */
  matches: boolean;
  /** U by §7.7 from the receipt's p and u: what q should be. */
  expectedUnits: number;
  /**
   * q is what the station owes: the formula's U, or, for a session it could
   * not serve (§7.5, u = 0), its whole chain: q = the station's own N, which
   * is the session's N, or another when the station runs with other terms
   * than the deposit was signed under (§7.10), but never fewer than the paid
   * units nor more than MAX_CHAIN. Otherwise a station error, and the claim
   * still uses q: it is the only proof there is.
   */
  unitsOk: boolean;
  /** q, as the receipt carries it. */
  units: number;
  paidUnits: number;
  /** What a claim with q pays (stroops): the contract's split of the session's amount. */
  toPayer: bigint;
  toHost: bigint;
  /**
   * q = 0: the proof is the anchor itself, which the pay QR and the deposit
   * event made public. Anyone can make such a receipt, so it confirms nothing.
   */
  provesNothing: boolean;
}

export type CustodyReceiptCheck =
  | { state: "not_mine"; reason: "noWallet" | "otherNetwork" | "noCustody" | "noDeposit" }
  /** The proof does not lead to this wallet's anchor: no claim. */
  | { state: "bad_proof"; record: DepositRecord; facts: ReceiptFacts }
  /** Open, before its deadline: claim. */
  | { state: "open"; record: DepositRecord; facts: ReceiptFacts }
  /** Open, but a receipt read before for this session gives back more (`best`): this one is not claimed. */
  | { state: "superseded"; record: DepositRecord; facts: ReceiptFacts; best: Receipt }
  /** Open, past its deadline: the host gets everything at release. */
  | { state: "expired"; record: DepositRecord; facts: ReceiptFacts }
  /** Already settled (record.settled says how, when known). */
  | { state: "settled"; record: DepositRecord; facts: ReceiptFacts };

export function receiptFacts(r: Receipt, record: DepositRecord): ReceiptFacts {
  const t = record.terms;
  const paid = paidUnits(record.fichas, t);
  const units = r.refund?.units ?? 0;
  const amount = BigInt(record.amount);
  const split = paid > 0 ? payerShare(amount, units, paid) : { toPayer: 0n, toHost: amount };
  const expectedUnits = unusedUnits(r.paidSeconds, r.usedSeconds, t.unitSecs);
  return {
    matches:
      isValidAmount(r.amount) &&
      toStroops(r.amount) === amount &&
      r.fichas === record.fichas &&
      r.assetCode === record.asset.code &&
      r.paidSeconds === record.fichas * t.fichaSecs,
    expectedUnits,
    unitsOk: units === expectedUnits || (r.usedSeconds === 0 && units >= paid && units <= MAX_CHAIN),
    units,
    paidUnits: paid,
    ...split,
    provesNothing: units === 0,
  };
}

/**
 * The asset the claim screen names: the deposit's, once the deposit is known
 * (the contract moves that one), else the receipt's own k (unsigned).
 */
export function depositAssetCode(c: CustodyReceiptCheck, r: Pick<Receipt, "assetCode">): string {
  return "record" in c ? c.record.asset.code : r.assetCode;
}

/** Whether a receipt counts as "Conferido na blockchain" (and is kept as confirmed). */
export function receiptConfirmed(c: CustodyReceiptCheck): boolean {
  return (c.state === "open" || c.state === "expired" || c.state === "settled") && c.facts.matches && !c.facts.provesNothing;
}

/** Why a receipt is not confirmed (the reason kept with it). */
export function notConfirmedReason(c: CustodyReceiptCheck): string {
  if (c.state === "not_mine") return c.reason;
  if (c.state === "bad_proof") return "badProof";
  if (c.state === "superseded") return "superseded";
  if (c.facts.provesNothing) return "zeroProof";
  return "amountDiffers";
}

/**
 * The /r link that claims a session's refund again (History, or /p once the
 * session is over): the best receipt kept for it, when it gives anything
 * back. `stored` is the receipt kept by the receipt screen (one per session
 * ID, whatever its anchor), used unless its proof was found not to lead to
 * the deposit, or, with the record's anchor known, does not lead to it.
 */
export function claimHref(record: (Pick<DepositRecord, "bestReceipt"> & Partial<Pick<DepositRecord, "anchor">>) | undefined, stored?: StoredReceipt): string | null {
  const storedOk = stored !== undefined && stored.reason !== "badProof" && (record?.anchor === undefined || proofMatches(stored.receipt, { anchor: record.anchor }));
  const candidates = [record?.bestReceipt, storedOk ? stored.receipt : undefined].filter(
    (x): x is Receipt & { refund: { units: number; proof: string } } => x !== undefined && isCustodyReceipt(x),
  );
  const best = candidates.sort((a, b) => b.refund.units - a.refund.units)[0];
  return best && best.refund.units > 0 ? `/r?${receiptToQuery(best)}` : null;
}

/**
 * Where an unsettled custody session stands for the History line, by the
 * phone's clock (display only: the receipt screen asks the ledger): before
 * its deadline, or past it with the money still in the contract until
 * someone releases it.
 */
export function refundWindow(d: Pick<DepositRecord, "deadline" | "settled">, nowSec: number): "open" | "past" | "settled" {
  if (d.settled) return "settled";
  return nowSec > d.deadline ? "past" : "open";
}

/**
 * Whether a receipt kept for a session's name is this session's (its ID and
 * anchor): a v2 receipt whose proof leads to the anchor. One that does not
 * (a crafted /r link with the public session ID and a random proof, or a v1
 * receipt, which a custody station never shows) must not end the session on
 * this phone and refuse its top-ups. A proof of q = 0 is the anchor itself:
 * it leads there and still counts, since a genuine receipt may give nothing
 * back, and the station shows one only once the session is over.
 */
export function receiptLeadsTo(r: Receipt, anchor: Uint8Array): boolean {
  if (!isCustodyReceipt(r) || !r.refund) return false;
  try {
    return proofLeadsToAnchor(anchor, r.refund.units, fromB64url(r.refund.proof));
  } catch {
    return false;
  }
}

/** The proof of a receipt leads to the deposit's anchor (step 2, offline). */
export function proofMatches(r: Receipt, record: Pick<DepositRecord, "anchor">): boolean {
  if (!r.refund) return false;
  try {
    return proofLeadsToAnchor(fromB64url(record.anchor), r.refund.units, fromB64url(r.refund.proof));
  } catch {
    return false;
  }
}

/**
 * The anchor a receipt's proof leads to (SHA-256 applied q times to z), or
 * null: what names its session on the contract when the phone kept no
 * record of the deposit. Trusted only as far as the session read with it is
 * this wallet's.
 */
export function receiptAnchor(r: Receipt): Uint8Array | null {
  if (!r.refund || !Number.isInteger(r.refund.units) || r.refund.units < 0 || r.refund.units > MAX_CHAIN) return null;
  try {
    return hashForward(fromB64url(r.refund.proof), r.refund.units);
  } catch {
    return null;
  }
}

/** A record for this wallet's open session found on the ledger but not on the phone. */
function recordFromSession(net: NetworkConfig, escrow: string, r: Receipt, stationId: string, session: string, s: EscrowSession, reg: Registry | null, seenAt: number): DepositRecord {
  const st = stationById(reg, stationId);
  const asset = st?.asset ?? { code: r.assetCode, issuer: null };
  return {
    network: net.id,
    escrow,
    payer: s.payer,
    hostKey: r.hostKey,
    stationId,
    session,
    anchor: toB64url(s.anchor),
    asset,
    token: s.token,
    terms: { price: s.price.toString(), fichaSecs: s.fichaSecs, unitSecs: s.unitSecs, maxFichas: s.maxFichas, graceSecs: s.graceSecs, chainLen: s.chainLen },
    fichas: s.fichas,
    amount: s.amount.toString(),
    deadline: s.deadline,
    txHashes: [],
    // A ledger the session was open at (its first deposit's is not known): no later read may call it lagging.
    ledger: seenAt,
    createdAt: s.opened * 1000,
  };
}

/**
 * Check a v2 receipt for `me`. Reads the ledger (one getLedgerEntries; the
 * ledger's time when the session is open; the events only when the phone
 * has no record of the deposit, or to show a settle), and saves what it
 * learns to the phone's deposit record. `ledgerNow` is the ledger's time
 * (unix seconds), read from the RPC when not given; null = unknown, and the
 * claim's simulation decides (it refuses Expired).
 */
export async function checkCustodyReceipt(
  server: Rpc,
  net: NetworkConfig,
  r: Receipt,
  me: string | null,
  reg: Registry | null,
  ledgerNow?: number | null,
): Promise<CustodyReceiptCheck> {
  if (r.network !== net.id) return { state: "not_mine", reason: "otherNetwork" };
  if (!net.custody) return { state: "not_mine", reason: "noCustody" };
  if (!me) return { state: "not_mine", reason: "noWallet" };
  const [stationId, session] = r.memo.split(".");
  // This wallet's deposits under the session ID, one per anchor (a session is its ID and its anchor).
  const deposits = await findDeposits(net.id, me, r.hostKey, stationId, session);
  // The one the receipt's proof leads to: the station's proof names its own session's anchor. A
  // deposit under the same ID with another anchor (a pay link with another chain) is another session.
  const proofAnchor = receiptAnchor(r);
  let record = proofAnchor ? deposits.find((d) => d.anchor === toB64url(proofAnchor)) : undefined;
  // A proof that leads to none of this wallet's deposits under the ID, nor to one on the ledger: a bad proof.
  const badProof = (): CustodyReceiptCheck => (deposits[0] ? { state: "bad_proof", record: deposits[0], facts: receiptFacts(r, deposits[0]) } : { state: "not_mine", reason: "noDeposit" });
  const st = stationById(reg, stationId);
  const escrow = record?.escrow ?? (isCustody(st) && st.host_key === r.hostKey ? st.escrow : deposits[0]?.escrow);
  if (!escrow) return { state: "not_mine", reason: "noDeposit" };
  if (!record && !proofAnchor) return badProof();
  // The session is its ID and its anchor: the deposit's, else the one the receipt's proof leads to.
  const anchor = record ? fromB64url(record.anchor) : proofAnchor!;
  const view = await readEscrow(server, escrow, r.hostKey, stationId, { session, anchor });

  if (!record) {
    if (view.session?.payer === me) {
      record = recordFromSession(net, escrow, r, stationId, session, view.session, reg, view.latestLedger);
    } else if (!view.session) {
      // Not on the phone and not open: this wallet's deposit and settle, if the RPC still holds them.
      const scan = await fetchEscrowEvents(server, escrow, [{ host: r.hostKey, station: stationId }], {});
      const found = new Map<string, DepositRecord>();
      const ctx = registryContext(reg, net);
      const fallback = view.station && {
        asset: st?.asset ?? { code: r.assetCode, issuer: null },
        token: view.station.token,
        fichaSecs: view.station.fichaSecs,
        unitSecs: view.station.unitSecs,
        maxFichas: view.station.maxFichas,
        graceSecs: view.station.graceSecs,
      };
      applyEvents(found, scan.events.filter((e) => e.session === session && sameBytes(e.anchor, anchor)), { network: net.id, escrow, payer: me }, (h, s) => ctx(h, s) ?? fallback ?? undefined);
      record = [...found.values()][0];
    }
    if (!record) return badProof();
    await saveDeposit(record);
  }

  const mine = view.session !== null && view.session.payer === me && sameBytes(view.session.anchor, fromB64url(record.anchor));
  if (mine) {
    // The contract's totals (a top-up made elsewhere) and the terms it froze are what a claim splits.
    const synced = withSession(record, view.session!);
    if (synced !== record || record.settled) {
      const { settled: _settled, ...open } = synced;
      record = open;
      await saveDeposit(record);
    }
  }
  const facts = receiptFacts(r, record);
  if (!proofMatches(r, record)) return { state: "bad_proof", record, facts };
  const best = record.bestReceipt?.refund;
  if (!best || best.units < r.refund!.units) {
    record = { ...record, bestReceipt: r };
    await saveDeposit(record);
  }
  if (mine) {
    if (best && best.units > r.refund!.units) return { state: "superseded", record, facts, best: record.bestReceipt! };
    // Past the deadline by the ledger's clock, not the phone's.
    const now = ledgerNow === undefined ? await ledgerTime(server) : ledgerNow;
    return now !== null && now > record.deadline ? { state: "expired", record, facts } : { state: "open", record, facts };
  }

  // Not open (or reopened by someone else): settled. Show how, when the events still say.
  if (maybeOpen(record) && ledgerWasReset(record.ledger, view.latestLedger)) {
    // The network was reset since the deposit (testnet): the session went with the old ledger.
    record = { ...record, settled: { how: "reset" } };
    await saveDeposit(record);
  } else if (!record.settled || record.settled.how === "unknown") {
    let settled = record.settled ?? { how: "unknown" as const };
    try {
      const e = await findSettle(server, record);
      if (e) settled = settledFrom(e);
    } catch {
      /* the RPC is down: settled, details unknown */
    }
    record = { ...record, settled };
    await saveDeposit(record);
  }
  return { state: "settled", record, facts };
}

// ---------------------------------------------------------------- the public view of a receipt

export type PublicReceipt =
  /** Not a custody station of the registry under this host, the contract runs other code, or nothing on the ledger names this session and proof. */
  | { state: "unknown" }
  /** Open: the proof leads to the anchor of a session open on the contract; what a claim with it would split. */
  | { state: "open"; escrow: string; session: EscrowSession; units: number; paidUnits: number; toPayer: bigint; toHost: bigint; amountMatches: boolean }
  /** Settled (its settle event, by session and anchor), with the deposits the RPC still holds. */
  | { state: "settled"; escrow: string; settle: SettleEvent; deposits: DepositEvent[]; amountMatches: boolean }
  /** Deposited (the proof leads to a deposit's anchor) and no longer open; its settle is past the RPC's window. */
  | { state: "deposited"; escrow: string; deposits: DepositEvent[]; amountMatches: boolean };

/**
 * A v2 receipt anyone can check, with no wallet and no key (contract §7.2:
 * all of it is public and read-only): the anchor its proof leads to names
 * the session, and the ledger says whether a deposit opened it (the proof
 * then leads to a real deposit's anchor), whether it is still open, and how
 * it settled. What a judge who did not pay sees on a receipt link, instead
 * of only "not checked".
 */
export async function publicReceipt(server: Rpc, net: NetworkConfig, r: Receipt, reg: Registry | null): Promise<PublicReceipt> {
  const unknown = { state: "unknown" } as const;
  if (r.network !== net.id || !net.custody || !r.refund) return unknown;
  const [stationId, session] = r.memo.split(".");
  const st = stationById(reg, stationId);
  if (!isCustody(st) || st.host_key !== r.hostKey) return unknown;
  const anchor = receiptAnchor(r);
  if (!anchor) return unknown;
  const view = await readEscrow(server, st.escrow, r.hostKey, stationId, { session, anchor });
  if (!view.wasmHash || !net.custody.escrowWasm.includes(view.wasmHash)) return unknown;
  const amount = isValidAmount(r.amount) ? toStroops(r.amount) : -1n;
  if (view.session) {
    const s = view.session;
    const paid = paidUnits(s.fichas, s);
    return { state: "open", escrow: st.escrow, session: s, units: r.refund.units, paidUnits: paid, ...payerShare(s.amount, r.refund.units, paid), amountMatches: amount === s.amount };
  }
  const scan = await scanEvents(server, sessionEventFilters(st.escrow, r.hostKey, stationId, session), parseEscrowEvent);
  const mine = scan.events.filter((e) => sameBytes(e.anchor, anchor));
  const deposits = mine.filter((e): e is DepositEvent => e.kind === "deposit");
  const settle = mine.filter((e): e is SettleEvent => e.kind === "settle").pop();
  if (settle) return { state: "settled", escrow: st.escrow, settle, deposits, amountMatches: amount === settle.toHost + settle.toPayer };
  const last = deposits[deposits.length - 1];
  if (last) return { state: "deposited", escrow: st.escrow, deposits, amountMatches: amount === last.totalAmount };
  return unknown;
}
