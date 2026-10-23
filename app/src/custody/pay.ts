/**
 * The payer's two custody calls, end to end (docs/station-app-contract.md
 * §7.4 step 6 and §7.6 step 5), in two halves so the screen can check the
 * balance against the real fee in between:
 *
 *   const p = await prepareDeposit(rpc, net, req);           // simulated: refuses before anything is signed
 *   const done = await sendDeposit(rpc, net, req, p, sign);  // signed on the phone, sent, followed; the record to keep
 *
 *   const c = await prepareClaim(rpc, net, record, refund);
 *   const settled = await sendClaim(rpc, record, c, sign);
 *
 * `sign` is the wallet's signTransaction (or a Keypair in the testnet test).
 */
import { scValToNative, type Transaction, type xdr } from "@stellar/stellar-sdk";
import type { AssetRef, NetworkConfig } from "@/config";
import { chainLength, fromB64url, toB64url } from "./chain";
import { planDeposit, staleSession } from "./check";
import type { DepositRecord } from "./deposits-store";
import { EscrowError } from "./errors";
import {
  claimArgs,
  claimAuth,
  depositArgs,
  depositAuth,
  depositTerms,
  ledgerTime,
  prepareCall,
  readEscrow,
  sendAndWait,
  sessionEvents,
  type ClaimArgs,
  type EscrowSession,
  type PreparedCall,
  type Rpc,
  type StationTerms,
} from "./escrow";
import type { PayLink } from "./link";

export type Signer = (tx: Transaction) => Transaction;

export interface DepositRequest {
  escrow: string;
  /** The asset's contract: the station's terms' token. */
  token: string;
  asset: AssetRef;
  payer: string;
  link: PayLink;
  fichas: number;
  /** The station's terms for a new session; a top-up keeps the open session's own. */
  terms: StationTerms;
  /** The open session this deposit tops up, as read from the contract. */
  open?: EscrowSession | null;
  /** This phone's record of that session, if any. */
  previous?: DepositRecord;
  /**
   * The ledger's time read with `open` (recheckDeposit): a new session's
   * simulated deadline is checked against it. Absent or null: only a
   * top-up's is checked.
   */
  ledgerNow?: number | null;
}

export interface PreparedDeposit extends PreparedCall {
  /** fichas x price, in stroops: what moves to the escrow. */
  amount: bigint;
}

/** The price a deposit pays per ficha: the open session's (frozen), else the station's. */
function priceOf(req: Pick<DepositRequest, "terms" | "open">): bigint {
  return req.open ? req.open.price : req.terms.price;
}

/**
 * Right before a deposit is built (contract §7.4 step 4, again): a pay page
 * may have stayed open for minutes while its session was paid and settled
 * (another judge at the table, the station's E key, a claim from another
 * tab), and the contract would then open a NEW session under the old ID that
 * no station serves. The session is read again, and for a new one the ID's
 * events too. A top-up must still be this wallet's open session before the
 * station's end; a new one must still be unpaid. Throws EscrowError
 * "session_changed" (read the page again), "stale_qr" (paid and settled
 * since: the QR is old) or "unchecked" (the events could not all be read:
 * nothing goes in on a guess). Returns the open session (a top-up's) and the
 * ledger's time, for prepareDeposit.
 */
export async function recheckDeposit(
  server: Rpc,
  escrow: string,
  link: PayLink,
  me: string,
  kind: "new" | "topup",
  terms: StationTerms,
): Promise<{ open: EscrowSession | null; ledgerNow: number | null }> {
  const [view, ledgerNow] = await Promise.all([readEscrow(server, escrow, link.hostKey, link.stationId, { session: link.session, anchor: link.anchor }), ledgerTime(server)]);
  const plan = planDeposit(view.session, me, link, terms, ledgerNow);
  if (plan.kind !== kind) throw new EscrowError("session_changed", plan.kind);
  if (plan.kind === "topup") return { open: plan.session, ledgerNow };
  if (staleSession(await sessionEvents(server, escrow, link.hostKey, link.stationId, link.session), link)) throw new EscrowError("stale_qr");
  return { open: null, ledgerNow };
}

/** How far a new session's simulated deadline may be from ledgerNow + paid time + grace: a few ledgers between the read and the simulation. */
export const NEW_DEADLINE_SLACK_SECONDS = 120;

/**
 * The deadline a simulated deposit returns must be the one this deposit
 * makes (contract §7.7): a top-up moves the open session's deadline by its
 * own fichas x ficha_secs; a new session's is the ledger's time + fichas x
 * ficha_secs + grace_secs (checked when `ledgerNow` is known). Anything else
 * means the contract would do something other than what the page shows (a
 * top-up whose session settled since would open a new session): refused,
 * "session_changed", before anything is signed. Returns the deadline.
 */
export function checkDepositDeadline(ret: xdr.ScVal | undefined, req: Pick<DepositRequest, "open" | "terms" | "fichas" | "ledgerNow">): number {
  const v = ret ? (scValToNative(ret) as unknown) : undefined;
  if (typeof v !== "bigint") throw new EscrowError("session_changed", "no deadline");
  const deadline = Number(v);
  if (req.open) {
    if (deadline !== req.open.deadline + req.fichas * req.open.fichaSecs) throw new EscrowError("session_changed", "deadline " + deadline);
  } else if (req.ledgerNow !== undefined && req.ledgerNow !== null) {
    const expected = req.ledgerNow + req.fichas * req.terms.fichaSecs + req.terms.graceSecs;
    if (Math.abs(deadline - expected) > NEW_DEADLINE_SLACK_SECONDS) throw new EscrowError("session_changed", "deadline " + deadline);
  }
  return deadline;
}

/**
 * Build and simulate deposit(payer, host, station, session, fichas, anchor,
 * terms), checking it authorizes only fichas x price to the escrow and
 * returns the deadline this deposit makes (checkDepositDeadline). The terms
 * signed are the ones the app checked: the station's for a new session, the
 * open session's own for a top-up; changed since, the deposit fails
 * (TermsChanged) before any money moves.
 */
export async function prepareDeposit(server: Rpc, net: NetworkConfig, req: DepositRequest): Promise<PreparedDeposit> {
  if (!Number.isInteger(req.fichas) || req.fichas < 1) throw new EscrowError("BadFichas");
  const amount = priceOf(req) * BigInt(req.fichas);
  const terms = depositTerms(req.open ?? req.terms);
  const args = { payer: req.payer, host: req.link.hostKey, station: req.link.stationId, session: req.link.session, fichas: req.fichas, anchor: req.link.anchor, terms };
  const p = await prepareCall(server, net.passphrase, {
    source: req.payer,
    escrow: req.escrow,
    fn: "deposit",
    args: depositArgs(args),
    auth: depositAuth(req.escrow, req.token, args, amount),
  });
  checkDepositDeadline(p.result, req);
  return { ...p, amount };
}

export interface DepositDone {
  hash: string;
  /** The session's deadline (ledger unix seconds), as the contract returned it. */
  deadline: number;
  record: DepositRecord;
}

/** Sign, send and follow a prepared deposit; the record to keep on the phone (step 7). */
export async function sendDeposit(server: Rpc, net: NetworkConfig, req: DepositRequest, p: PreparedDeposit, sign: Signer): Promise<DepositDone> {
  const sent = await sendAndWait(server, sign(p.tx), req.escrow);
  const ret = sent.returnValue ? scValToNative(sent.returnValue) : undefined;
  if (typeof ret !== "bigint") throw new EscrowError("contract", "deposit returned no deadline");
  const deadline = Number(ret);
  const prev = req.previous;
  const open = req.open;
  // The session's frozen terms: the open one's on a top-up, else the ones this
  // deposit signed (the contract refuses any other, so they are the session's).
  const t = open ?? { ...req.terms, chainLen: chainLength(req.terms) };
  const fichasBefore = open ? open.fichas : 0;
  const amountBefore = open ? open.amount : 0n;
  const record: DepositRecord = {
    network: net.id,
    escrow: req.escrow,
    payer: req.payer,
    hostKey: req.link.hostKey,
    stationId: req.link.stationId,
    session: req.link.session,
    anchor: toB64url(req.link.anchor),
    asset: req.asset,
    token: req.token,
    terms: { price: t.price.toString(), fichaSecs: t.fichaSecs, unitSecs: t.unitSecs, maxFichas: t.maxFichas, graceSecs: t.graceSecs, chainLen: t.chainLen },
    fichas: fichasBefore + req.fichas,
    amount: (amountBefore + p.amount).toString(),
    deadline,
    txHashes: [...(open && prev ? prev.txHashes : []), sent.hash],
    ledger: open && prev?.ledger !== undefined ? prev.ledger : sent.ledger,
    createdAt: open && prev ? prev.createdAt : Date.now(),
  };
  return { hash: sent.hash, deadline, record };
}

export interface Refund {
  units: number;
  proof: Uint8Array;
}

export function claimArgsFor(record: Pick<DepositRecord, "hostKey" | "stationId" | "session" | "anchor">, refund: Refund): ClaimArgs {
  return { host: record.hostKey, station: record.stationId, session: record.session, anchor: fromB64url(record.anchor), units: refund.units, proof: refund.proof };
}

/** Build and simulate claim(host, station, session, anchor, units, proof) from the payer: Expired, BadProof or NoSession show here, before signing. */
export async function prepareClaim(server: Rpc, net: NetworkConfig, record: DepositRecord, refund: Refund): Promise<PreparedCall> {
  const args = claimArgsFor(record, refund);
  return prepareCall(server, net.passphrase, { source: record.payer, escrow: record.escrow, fn: "claim", args: claimArgs(args), auth: claimAuth(record.escrow, args) });
}

export interface ClaimDone {
  hash: string;
  /** Stroops back to the payer (the contract's return value) and to the host (the rest). */
  toPayer: bigint;
  toHost: bigint;
  /** The record, now settled by proof. */
  record: DepositRecord;
}

/** Sign, send and follow a prepared claim. */
export async function sendClaim(server: Rpc, record: DepositRecord, p: PreparedCall, refund: Refund, sign: Signer, at = new Date()): Promise<ClaimDone> {
  const sent = await sendAndWait(server, sign(p.tx), record.escrow);
  const ret = sent.returnValue ? scValToNative(sent.returnValue) : undefined;
  if (typeof ret !== "bigint") throw new EscrowError("contract", "claim returned no amount");
  const toPayer = ret;
  const toHost = BigInt(record.amount) - toPayer;
  const units = Math.min(refund.units, (record.fichas * record.terms.fichaSecs) / record.terms.unitSecs);
  return {
    hash: sent.hash,
    toPayer,
    toHost,
    record: {
      ...record,
      settled: { how: "proof", toPayer: toPayer.toString(), toHost: toHost.toString(), unusedUnits: units, txHash: sent.hash, at: at.toISOString() },
    },
  };
}
