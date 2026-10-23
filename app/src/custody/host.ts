/**
 * Host mode (docs/station-app-contract.md §7.1 and §7.8): what a host does
 * with its own wallet, on its own phone, never on the station's laptop. It
 * lists its stations and their open sessions (the contract's events, then
 * the ledger entries), registers or changes a station's terms, releases the
 * sessions past their deadline, refunds a session by hand (host_refund) and
 * collects what the contract holds for it (pay_host: every claim's host
 * share waits there, owed). As with the payer's calls (./pay.ts), every call
 * is simulated before anything is signed, and the authorization it asks for
 * must be exactly the host's own call: register and host_refund under the
 * host's signature, release and pay_host under none.
 *
 *   const view = await loadHostView(rpc, net, host, registry);
 *   const p = await prepareRegister(rpc, net, { escrow, host, station, terms });
 *   const done = await sendHostCall(rpc, escrow, p, signTransaction);
 *
 * A Soroban transaction carries one contract call, and the network queues
 * one transaction per account at a time: "release all" (releaseMany) sends
 * them one after another, each simulated, signed and confirmed.
 */
import { nativeToScVal, scValToNative, xdr, type rpc } from "@stellar/stellar-sdk";
import type { AssetRef, NetworkConfig, NetworkId } from "@/config";
import { readPref, writePref } from "@/lib/storage";
import { STATION_ID_RE, isCustody, maxFichas, stationsByHostKey, type Registry, type Station } from "@/registry/verify";
import { fromStroops, isValidAmount, toStroops } from "@/stellar/amount";
import { chainLength, fromB64url, isB64url32, paidUnits, payerShare, toB64url } from "./chain";
import { CLAIM_WINDOW_SECONDS, custodyAssetOk, termsMismatches, type TermsField } from "./check";
import { EscrowError, type EscrowErrorCode } from "./errors";
import {
  addr,
  assetContract,
  bytes32,
  i128,
  instanceKey,
  mergeEvents,
  owedKey,
  parseEscrowEvent,
  prepareCall,
  scanEvents,
  sendAndWait,
  sessionKey,
  stationKey,
  sym,
  toEscrowSession,
  toStationTerms,
  u32,
  wasmHashOf,
  type DepositEvent,
  type EscrowEvent,
  type EscrowSession,
  type ExpectedAuth,
  type PreparedCall,
  type Rpc,
  type SettleEvent,
  type StationTerms,
} from "./escrow";
import type { Signer } from "./pay";

// ---------------------------------------------------------------- terms

/** The contract's bounds on a station's terms (contract §7.1 register): anything else is BadConfig. */
export const TERMS_BOUNDS = { minGraceSecs: 300, maxGraceSecs: 86_400, maxSessionSecs: 86_400, maxChain: 256 } as const;

/** The recommended grace (contract §7.7): 180 s to plug in + 600 s of pause + a 900 s claim window. */
export const RECOMMENDED_GRACE_SECONDS = 1680;

/**
 * The least grace a Ficha station starts with (config.py): the 900 s claim
 * window plus its time to plug in (PLUG_TIMEOUT_SECONDS, 180 s by default).
 * The contract takes 300 s and up, so this is a warning, not a form problem:
 * a station set with a longer PLUG_TIMEOUT_SECONDS needs more.
 */
export const STATION_MIN_GRACE_SECONDS = CLAIM_WINDOW_SECONDS + 180;

/** A grace the contract takes but a station with the default plug-in time refuses to start with. */
export function graceBelowStation(graceSecs: number): boolean {
  return Number.isInteger(graceSecs) && graceSecs >= TERMS_BOUNDS.minGraceSecs && graceSecs < STATION_MIN_GRACE_SECONDS;
}

const I128_MAX = (1n << 127n) - 1n;

/** What the host types: the registry's units (contract §2), turned into the contract's by termsFromForm. */
export interface StationForm {
  id: string;
  asset: AssetRef;
  /** Decimal string in the asset. */
  price: string;
  fichaMinutes: number;
  maxSessionMinutes: number;
  unitSeconds: number;
  graceSeconds: number;
  active: boolean;
}

export type FormProblem =
  /** Not a station ID (contract §1: 6 characters). */
  | "id"
  /** Not a positive amount with at most 7 decimals. */
  | "price"
  /** Minutes per ficha: a whole number, at least 1. */
  | "ficha"
  /** The longest session holds no ficha. */
  | "max"
  /** The refund unit: a whole number of seconds, at least 1. */
  | "unit"
  /** The refund unit does not divide the ficha. */
  | "unit_divides"
  | "grace"
  /** The longest session is over 24 h. */
  | "session_too_long"
  /** The chain would be over 256 links: a longer unit, or fewer fichas. */
  | "chain_too_long"
  | "overflow";

/** Where terms break the contract's bounds, in its order; empty = register accepts them. */
export function termsProblems(t: StationTerms): FormProblem[] {
  const out: FormProblem[] = [];
  const posInt = (n: number) => Number.isInteger(n) && n > 0 && n <= 0xffff_ffff;
  if (t.price <= 0n) out.push("price");
  if (!posInt(t.fichaSecs)) out.push("ficha");
  if (!posInt(t.maxFichas)) out.push("max");
  if (!posInt(t.unitSecs)) out.push("unit");
  else if (posInt(t.fichaSecs) && t.fichaSecs % t.unitSecs !== 0) out.push("unit_divides");
  if (!Number.isInteger(t.graceSecs) || t.graceSecs < TERMS_BOUNDS.minGraceSecs || t.graceSecs > TERMS_BOUNDS.maxGraceSecs) out.push("grace");
  if (out.length > 0) return out;
  if (t.maxFichas * t.fichaSecs > TERMS_BOUNDS.maxSessionSecs) out.push("session_too_long");
  const n = chainLength(t);
  if (n > TERMS_BOUNDS.maxChain) out.push("chain_too_long");
  if (out.length === 0 && t.price * BigInt(t.maxFichas) * BigInt(n + 1) > I128_MAX) out.push("overflow");
  return out;
}

/** The form's problems, the ID first; empty = it can be registered. */
export function formProblems(f: StationForm, net: Pick<NetworkConfig, "passphrase" | "custody">): FormProblem[] {
  const out: FormProblem[] = [];
  if (!STATION_ID_RE.test(f.id)) out.push("id");
  if (!isValidAmount(f.price) || toStroops(f.price) <= 0n) out.push("price");
  if (!Number.isInteger(f.fichaMinutes) || f.fichaMinutes < 1) out.push("ficha");
  if (!Number.isInteger(f.maxSessionMinutes) || f.maxSessionMinutes < 1) out.push("max");
  else if (!out.includes("ficha") && f.maxSessionMinutes < f.fichaMinutes) out.push("max");
  if (out.some((p) => p !== "id")) return out;
  for (const p of termsProblems(termsFromForm(f, net))) if (!out.includes(p)) out.push(p);
  return out;
}

/**
 * The contract's terms for a form (the registry's match rules, contract
 * §7.4 step 3): token = the asset's SAC, price = ficha price x 10^7,
 * ficha_secs = minutes x 60, max_fichas = floor(max session / ficha minutes).
 * Call only when formProblems has no "price".
 */
export function termsFromForm(f: StationForm, net: Pick<NetworkConfig, "passphrase" | "custody">): StationTerms {
  return {
    token: assetContract(f.asset, net),
    price: toStroops(f.price),
    fichaSecs: f.fichaMinutes * 60,
    maxFichas: Math.floor(f.maxSessionMinutes / f.fichaMinutes),
    unitSecs: f.unitSeconds,
    graceSecs: f.graceSeconds,
    active: f.active,
  };
}

/** A form for a registry entry: its own custody fields, or the defaults (30 s units, the recommended grace). */
export function formFromRegistry(st: Station): StationForm {
  return {
    id: st.id,
    asset: st.asset,
    price: st.ficha_price,
    fichaMinutes: st.ficha_minutes,
    maxSessionMinutes: maxFichas(st) * st.ficha_minutes,
    unitSeconds: st.unit_seconds ?? 30,
    graceSeconds: st.grace_seconds ?? RECOMMENDED_GRACE_SECONDS,
    active: st.active,
  };
}

/** A form for terms already on the contract; `asset` is the one whose SAC is the token. */
export function formFromTerms(id: string, t: StationTerms, asset: AssetRef): StationForm {
  const fichaMinutes = t.fichaSecs / 60;
  return {
    id,
    asset,
    price: fromStroops(t.price),
    fichaMinutes,
    maxSessionMinutes: t.maxFichas * fichaMinutes,
    unitSeconds: t.unitSecs,
    graceSeconds: t.graceSecs,
    active: t.active,
  };
}

/**
 * The escrow host mode registers a new station on, and always reads: the one
 * the signed registry's custody stations name (the most of them; the app's
 * own on a tie). After a testnet reset the re-signed registry, not a rebuild
 * of the app, moves host mode to the new deployment (contract §7.4), as it
 * does payments. The app's built-in escrow only when the registry names none.
 */
export function defaultEscrow(reg: Registry | null, net: Pick<NetworkConfig, "custody">): string {
  const builtIn = net.custody!.escrowContract;
  const counts = new Map<string, number>();
  for (const s of reg?.stations ?? []) if (isCustody(s)) counts.set(s.escrow, (counts.get(s.escrow) ?? 0) + 1);
  let best = builtIn;
  let most = counts.get(builtIn) ?? 0;
  for (const [escrow, n] of counts) {
    if (n > most) {
      best = escrow;
      most = n;
    }
  }
  return best;
}

/** The asset a token (SAC) stands for, among those the app knows on this network: XLM and its USDC. */
export function assetOfToken(token: string, net: Pick<NetworkConfig, "passphrase" | "custody" | "usdc">): AssetRef | null {
  const xlm: AssetRef = { code: "XLM", issuer: null };
  if (token === assetContract(xlm, net)) return xlm;
  if (token === assetContract(net.usdc, net)) return { code: net.usdc.code, issuer: net.usdc.issuer };
  return null;
}

/**
 * The registry fields (contract §2) that match these terms on this escrow:
 * what the registry's signer needs so payers' apps accept the station.
 */
export function registryFields(t: StationTerms, escrow: string, asset: AssetRef) {
  const fichaMinutes = t.fichaSecs / 60;
  return {
    asset,
    ficha_price: fromStroops(t.price),
    ficha_minutes: fichaMinutes,
    max_session_minutes: t.maxFichas * fichaMinutes,
    mode: "custody" as const,
    escrow,
    unit_seconds: t.unitSecs,
    grace_seconds: t.graceSecs,
  };
}

// ---------------------------------------------------------------- calls

/** StationCfg as the contract takes it: a map with Symbol keys, in key order (contract §7.1, Types). */
export function stationCfg(t: StationTerms): xdr.ScVal {
  const entry = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: sym(k), val: v });
  return xdr.ScVal.scvMap([
    entry("active", xdr.ScVal.scvBool(t.active)),
    entry("ficha_secs", u32(t.fichaSecs)),
    entry("grace_secs", nativeToScVal(BigInt(t.graceSecs), { type: "u64" })),
    entry("max_fichas", u32(t.maxFichas)),
    entry("price", i128(t.price)),
    entry("token", addr(t.token)),
    entry("unit_secs", u32(t.unitSecs)),
  ]);
}

/** register(host, station, cfg) */
export function registerArgs(host: string, station: string, t: StationTerms): xdr.ScVal[] {
  return [addr(host), sym(station), stationCfg(t)];
}

/** The host's authorization for register(...) alone. */
export function registerAuth(escrow: string, host: string, station: string, t: StationTerms): ExpectedAuth {
  return { contract: escrow, fn: "register", args: registerArgs(host, station, t), sub: [] };
}

/** One session on one escrow: its ID and its anchor (contract §7.1). */
export interface SessionRef {
  escrow: string;
  host: string;
  station: string;
  /** The bare session ID (F + 7). */
  session: string;
  anchor: Uint8Array;
}

/** release(host, station, session, anchor) */
export function releaseArgs(s: SessionRef): xdr.ScVal[] {
  return [addr(s.host), sym(s.station), sym(s.session), bytes32(s.anchor)];
}

/** host_refund(host, station, session, anchor, units) */
export function hostRefundArgs(s: SessionRef, units: number): xdr.ScVal[] {
  return [addr(s.host), sym(s.station), sym(s.session), bytes32(s.anchor), u32(units)];
}

/** The host's authorization for host_refund(...) alone: the payouts come from the contract. */
export function hostRefundAuth(s: SessionRef, units: number): ExpectedAuth {
  return { contract: s.escrow, fn: "host_refund", args: hostRefundArgs(s, units), sub: [] };
}

/** Build and simulate register from the host: terms out of bounds are refused here, before the network. */
export async function prepareRegister(server: Rpc, net: NetworkConfig, r: { escrow: string; host: string; station: string; terms: StationTerms }): Promise<PreparedCall> {
  const problems = [...(STATION_ID_RE.test(r.station) ? [] : ["id"]), ...termsProblems(r.terms)];
  if (problems.length > 0) throw new EscrowError("BadConfig", problems.join(","));
  return prepareCall(server, net.passphrase, {
    source: r.host,
    escrow: r.escrow,
    fn: "register",
    args: registerArgs(r.host, r.station, r.terms),
    auth: registerAuth(r.escrow, r.host, r.station, r.terms),
  });
}

/** Build and simulate release, sent (and paid for) by `source`, the host by default; it needs no signature in the call. */
export async function prepareRelease(server: Rpc, net: NetworkConfig, s: SessionRef, source = s.host): Promise<PreparedCall> {
  return prepareCall(server, net.passphrase, { source, escrow: s.escrow, fn: "release", args: releaseArgs(s), auth: null });
}

/** Build and simulate host_refund from the host: TooEarly (a partial refund before the deadline) or NoSession show here. */
export async function prepareHostRefund(server: Rpc, net: NetworkConfig, s: SessionRef, units: number): Promise<PreparedCall> {
  if (!Number.isInteger(units) || units < 1 || units > 0xffff_ffff) throw new RangeError(`host_refund: bad units ${units}`);
  return prepareCall(server, net.passphrase, { source: s.host, escrow: s.escrow, fn: "host_refund", args: hostRefundArgs(s, units), auth: hostRefundAuth(s, units) });
}

export interface HostCallDone {
  hash: string;
  ledger: number;
  /** Unix seconds of the ledger that included it. */
  closedAt: number;
  /** What the call returned: release, the host's share; host_refund, the payer's. */
  amount?: bigint;
}

/** Sign, send and follow a prepared host call (sendAndWait: never sends twice). */
export async function sendHostCall(server: Rpc, escrow: string, p: PreparedCall, sign: Signer): Promise<HostCallDone> {
  const sent = await sendAndWait(server, sign(p.tx), escrow);
  const ret = sent.returnValue ? scValToNative(sent.returnValue) : undefined;
  return { hash: sent.hash, ledger: sent.ledger, closedAt: sent.closedAt, amount: typeof ret === "bigint" ? ret : undefined };
}

/** Checks the source can pay `fee` (stroops) before signing; throws EscrowError("balance") when it cannot. */
export type FeeCheck = (fee: bigint) => Promise<void>;

/** Release one session: simulated, the fee checked, signed, sent and followed. */
export async function releaseSession(server: Rpc, net: NetworkConfig, s: SessionRef, sign: Signer, checkFee?: FeeCheck): Promise<HostCallDone> {
  const p = await prepareRelease(server, net, s);
  await checkFee?.(p.fee);
  return sendHostCall(server, s.escrow, p, sign);
}

// ---------------------------------------------------------------- owed (pay_host)

/**
 * What the contract holds for this host in one token on one escrow
 * (contract §7.1 owed): every claim's host share, and a release's or
 * host_refund's that the host's account could not take. Only pay_host moves
 * it, and only to the host.
 */
export interface HostOwed {
  escrow: string;
  /** The asset's contract (SAC). */
  token: string;
  /** Stroops. */
  amount: bigint;
  /** The entry is past its time to live: it must be restored before pay_host. */
  archived: boolean;
}

/** pay_host(host, token) */
export function payHostArgs(host: string, token: string): xdr.ScVal[] {
  return [addr(host), addr(token)];
}

export interface PreparedPayHost extends PreparedCall {
  /** What the simulation says pay_host pays the host now (stroops): at least what the view showed, should a claim have landed since. */
  amount: bigint;
}

/**
 * Build and simulate pay_host(host, token), sent (and paid for) by `source`,
 * the host by default. Anyone may send it and it pays only the host, so it
 * asks for no authorization at all (one that does is refused, bad_auth).
 * NothingOwed (#13) shows here, before anything is signed.
 */
export async function preparePayHost(server: Rpc, net: NetworkConfig, o: { escrow: string; host: string; token: string }, source = o.host): Promise<PreparedPayHost> {
  const p = await prepareCall(server, net.passphrase, { source, escrow: o.escrow, fn: "pay_host", args: payHostArgs(o.host, o.token), auth: null });
  const ret = p.result ? scValToNative(p.result) : undefined;
  if (typeof ret !== "bigint" || ret <= 0n) throw new EscrowError("contract", "pay_host returned no amount");
  return { ...p, amount: ret };
}

/** Collect what the contract holds for the host in one token: simulated, the fee checked, signed, sent and followed. */
export async function collectOwed(server: Rpc, net: NetworkConfig, o: Pick<HostOwed, "escrow" | "token"> & { host: string }, sign: Signer, checkFee?: FeeCheck): Promise<HostCallDone> {
  const p = await preparePayHost(server, net, o);
  await checkFee?.(p.fee);
  const done = await sendHostCall(server, o.escrow, p, sign);
  return { ...done, amount: done.amount ?? p.amount };
}

/** The view after a pay_host this phone sent: nothing more is owed in that token on that escrow. */
export function afterPayout(view: HostView, escrow: string, token: string): HostView {
  return { ...view, owed: view.owed.filter((o) => !(o.escrow === escrow && o.token === token)) };
}

// ---------------------------------------------------------------- deadlines and refunds

/**
 * Seconds past a deadline before the app offers release or a partial
 * refund: the ledger's close time, run forward on this phone, is ahead of
 * the next ledger's by up to a ledger or two. The simulation has the last
 * word either way (TooEarly).
 */
export const DEADLINE_MARGIN_SECS = 10;

/** The ledger's close time (unix seconds) as read, and this phone's monotonic clock (ms, performance.now()) when it was read. */
export interface LedgerClock {
  ledger: number;
  mono: number;
}

/**
 * Now on the ledger's clock (contract §7.7: deadlines are ledger time, never
 * the phone's): the close time last read, run forward by the time elapsed
 * since on the phone's monotonic clock, which counts seconds right even when
 * its wall clock is minutes off. With no ledger time read yet, the phone's
 * clock (`wallSec`); the simulation still has the last word (TooEarly).
 */
export function ledgerClockNow(clock: LedgerClock | null, monoMs: number, wallSec: number): number {
  if (!clock) return wallSec;
  return clock.ledger + Math.max(0, monoMs - clock.mono) / 1000;
}

/** open: the payer may still claim (until the deadline); expired: release, or refund any part. */
export type SessionPhase = "open" | "expired";

export function sessionPhase(s: Pick<EscrowSession, "deadline">, nowSec: number): SessionPhase {
  return nowSec > s.deadline + DEADLINE_MARGIN_SECS ? "expired" : "open";
}

export interface RefundPlan {
  /** The units the session paid for. */
  paid: number;
  /** The refund the host may choose, in units: until the deadline only paid..paid (in full). */
  min: number;
  max: number;
  fullOnly: boolean;
}

/**
 * What host_refund accepts now (contract §7.1): until the deadline only a
 * full refund, so the host can never settle a session with less than the
 * station's proof would give the payer; after it, any part.
 */
export function refundPlan(s: Pick<EscrowSession, "deadline" | "fichas" | "fichaSecs" | "unitSecs">, nowSec: number): RefundPlan {
  const paid = paidUnits(s.fichas, s);
  if (sessionPhase(s, nowSec) === "expired") return { paid, min: 1, max: paid, fullOnly: false };
  return { paid, min: paid, max: paid, fullOnly: true };
}

/** The split host_refund(units) makes (the contract's arithmetic, ./chain.ts payerShare). */
export function refundSplit(s: Pick<EscrowSession, "amount" | "fichas" | "fichaSecs" | "unitSecs">, units: number): { toPayer: bigint; toHost: bigint } {
  return payerShare(s.amount, units, paidUnits(s.fichas, s));
}

// ---------------------------------------------------------------- events

/** A station event (register): the terms set under (host, station). */
export interface StationEvent {
  kind: "station";
  host: string;
  station: string;
  terms: StationTerms;
  txHash: string;
  ledger: number;
  at: string;
  id: string;
}

export type HostEvent = EscrowEvent | StationEvent;

type RawEvent = Pick<rpc.Api.EventResponse, "topic" | "value" | "txHash" | "ledger" | "ledgerClosedAt" | "id">;

/** A station, deposit or settle event, or null for a malformed one. */
export function parseHostEvent(e: RawEvent): HostEvent | null {
  try {
    if (e.topic.length === 3 && scValToNative(e.topic[0]) === "station") {
      const host = scValToNative(e.topic[1]) as unknown;
      const station = scValToNative(e.topic[2]) as unknown;
      if (typeof host !== "string" || typeof station !== "string") return null;
      return { kind: "station", host, station, terms: toStationTerms(scValToNative(e.value)), txHash: e.txHash, ledger: e.ledger, at: e.ledgerClosedAt, id: e.id };
    }
  } catch {
    return null;
  }
  return parseEscrowEvent(e);
}

/** One getEvents filter for everything about one host on one escrow: its station, deposit and settle events, any station. */
export function hostEventFilter(escrow: string, host: string): rpc.Api.EventFilter {
  const b64 = (v: xdr.ScVal) => v.toXdr("base64");
  const h = b64(addr(host));
  return {
    type: "contract",
    contractIds: [escrow],
    topics: [
      [b64(sym("station")), h, "*"],
      [b64(sym("deposit")), h, "*", "*"],
      [b64(sym("settle")), h, "*", "*"],
    ],
  };
}

export interface OpenTally {
  station: string;
  session: string;
  anchor: Uint8Array;
  payer: string;
  /** The deposits since the session opened, oldest first. */
  deposits: DepositEvent[];
}

/** A session's key in a tally: "station/session/anchor" (the anchor in base64url). */
export const tallyKey = (station: string, session: string, anchor: Uint8Array) => `${station}/${session}/${toB64url(anchor)}`;

export interface EventTally {
  /** Every station an event names, first seen first. */
  stations: string[];
  /** Sessions a deposit opened and no settle closed, by tallyKey. */
  open: Map<string, OpenTally>;
  /** Settle events, newest first. */
  settled: SettleEvent[];
}

/**
 * This host's events (oldest first) tallied: a deposit opens or tops up a
 * session, a settle closes it. A session is its ID and its anchor: two
 * deposits under one ID with different anchors are two sessions. A deposit
 * after a settle under the same ID opens a new session (a stale QR), which
 * the host sees and can refund.
 */
export function tallyHostEvents(events: readonly HostEvent[], host: string): EventTally {
  const stations: string[] = [];
  const open = new Map<string, OpenTally>();
  const settled: SettleEvent[] = [];
  for (const e of events) {
    if (e.host !== host) continue;
    if (!stations.includes(e.station)) stations.push(e.station);
    if (e.kind === "station") continue;
    const key = tallyKey(e.station, e.session, e.anchor);
    if (e.kind === "deposit") {
      const o = open.get(key);
      if (o) o.deposits.push(e);
      else open.set(key, { station: e.station, session: e.session, anchor: e.anchor, payer: e.payer, deposits: [e] });
    } else {
      open.delete(key);
      settled.unshift(e);
    }
  }
  return { stations, open, settled };
}

interface ScanState {
  cursor: string;
  events: HostEvent[];
}

/** Events already read in this app session, per network, escrow and host: the next load reads only what is new. */
const scans = new Map<string, ScanState>();

/** Scans running now, per network, escrow and host: a second load waits for the first instead of reading the same page twice. */
const inFlight = new Map<string, Promise<{ events: HostEvent[]; complete: boolean }>>();

/** Forget the events read so far (tests). */
export function forgetHostScans(): void {
  scans.clear();
  inFlight.clear();
}

function scanHost(server: Rpc, net: NetworkConfig, escrow: string, host: string): Promise<{ events: HostEvent[]; complete: boolean }> {
  const id = [net.id, escrow, host].join("|");
  const running = inFlight.get(id);
  if (running) return running;
  const run = scanHostNow(server, id, escrow, host).finally(() => inFlight.delete(id));
  inFlight.set(id, run);
  return run;
}

async function scanHostNow(server: Rpc, id: string, escrow: string, host: string): Promise<{ events: HostEvent[]; complete: boolean }> {
  const prev = scans.get(id);
  const filters = [hostEventFilter(escrow, host)];
  let res;
  try {
    res = await scanEvents(server, filters, parseHostEvent, prev ? { cursor: prev.cursor } : {});
  } catch (e) {
    // A cursor older than the RPC's window is refused: start again from the oldest ledger it keeps.
    if (!prev) throw e;
    scans.delete(id);
    res = await scanEvents(server, filters, parseHostEvent, {});
  }
  // Each event once, whatever the pages overlap.
  const events = mergeEvents(scans.get(id)?.events ?? [], res.events);
  if (res.cursor) scans.set(id, { cursor: res.cursor, events });
  return { events, complete: res.complete };
}

// ---------------------------------------------------------------- the host's view

/** How a station on the contract stands in the signed registry (contract §2, §7.4 steps 2 and 3). */
export type RegistryState =
  /** Listed under this host in custody mode on this escrow, with these terms: payers can pay it. */
  | "match"
  /** Listed so, with other terms: payers' apps refuse its pay link until one side changes (`differs`). */
  | "differs"
  /** Listed so, with no terms on the contract yet: register it. */
  | "not_registered"
  /** Listed under this host in direct mode. */
  | "direct"
  /** Listed in custody mode on another escrow. */
  | "other_escrow"
  /** Listed in custody mode in an asset other than XLM: payers' apps refuse it for now (check.ts custodyAssetOk). */
  | "not_xlm"
  /** Not listed under this host. */
  | "absent";

export interface HostStation {
  escrow: string;
  id: string;
  /** Its terms on the contract; null when it has none yet. */
  terms: StationTerms | null;
  /** The terms' entry is past its time to live (register again to restore and extend it). */
  archived: boolean;
  /** The signed registry's entry for this ID under this host. */
  registry: Station | null;
  registryState: RegistryState;
  differs: TermsField[];
}

/** An open session under this host, as the contract holds it. */
export interface HostSession extends EscrowSession, SessionRef {
  /** Its entry is past its time to live: it must be restored before release or refund. */
  archived: boolean;
  /** The deposits' transaction hashes seen in the events, first one first. */
  txHashes: string[];
}

export interface HostView {
  network: NetworkId;
  host: string;
  /** The escrows read: the registry's default (defaultEscrow), and any other it names for this host's stations. */
  escrows: { id: string; wasmHash: string | null; pinned: boolean }[];
  /** Stations with terms on a contract, or listed in custody mode and still without them. */
  stations: HostStation[];
  /** Open sessions, earliest deadline first. */
  sessions: HostSession[];
  /** The latest settlements the RPC still holds, newest first. */
  settled: SettleEvent[];
  /** What the contract holds for this host, per escrow and token, above zero: pay_host collects it. */
  owed: HostOwed[];
  /** Some events could not be read: the lists rest on the ledger reads and this phone's memory alone. */
  eventsIncomplete: boolean;
  latestLedger: number;
}

/** How many settlements the view keeps. */
const SETTLED_KEPT = 30;

export function registryState(entry: Station | null, escrow: string, terms: StationTerms | null, net: NetworkConfig): { state: RegistryState; differs: TermsField[] } {
  if (!entry) return { state: "absent", differs: [] };
  if (!isCustody(entry)) return { state: "direct", differs: [] };
  if (entry.escrow !== escrow) return { state: "other_escrow", differs: [] };
  if (!custodyAssetOk(entry)) return { state: "not_xlm", differs: [] };
  if (!terms) return { state: "not_registered", differs: [] };
  const differs = termsMismatches(entry, terms, net);
  return { state: differs.length > 0 ? "differs" : "match", differs };
}

function stationRow(escrow: string, id: string, terms: StationTerms | null, archived: boolean, entry: Station | null, net: NetworkConfig): HostStation {
  const r = registryState(entry, escrow, terms, net);
  return { escrow, id, terms, archived, registry: entry, registryState: r.state, differs: r.differs };
}

/** What this phone remembers per network and host (localStorage): the stations and open sessions it saw, beyond the RPC's event window. */
interface Known {
  /** "escrow/station" */
  stations: string[];
  /** "escrow/station/session/anchor" (the anchor in base64url; older 3-part entries are skipped) */
  open: string[];
}

const KNOWN_PREFIX = "ficha.host.v1";
const KNOWN_MAX = 200;
const knownKey = (net: NetworkId, host: string) => `${KNOWN_PREFIX}.${net}.${host}`;

function readKnown(net: NetworkId, host: string): Known {
  try {
    const v = JSON.parse(readPref(knownKey(net, host)) ?? "null") as Known | null;
    const strings = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []);
    return { stations: strings(v?.stations), open: strings(v?.open) };
  } catch {
    return { stations: [], open: [] };
  }
}

function writeKnown(net: NetworkId, host: string, k: Known): void {
  writePref(knownKey(net, host), JSON.stringify({ stations: k.stations.slice(-KNOWN_MAX), open: k.open.slice(-KNOWN_MAX) }));
}

/** Remember a station registered from this phone, so it is listed even with no event in the RPC's window. */
export function rememberStation(net: NetworkId, host: string, escrow: string, station: string): void {
  const k = readKnown(net, host);
  const id = `${escrow}/${station}`;
  if (!k.stations.includes(id)) writeKnown(net, host, { ...k, stations: [...k.stations, id] });
}

interface Entry {
  val: xdr.ScVal;
  archived: boolean;
}

/** Contract data entries by their key's XDR (getLedgerEntries takes at most 200 keys per call). */
async function readEntries(server: Rpc, keys: xdr.LedgerKey[]): Promise<{ latestLedger: number; found: Map<string, Entry> }> {
  const found = new Map<string, Entry>();
  let latestLedger = 0;
  for (let at = 0; at < keys.length; at += 200) {
    const res = await server.getLedgerEntries(...keys.slice(at, at + 200));
    latestLedger = Math.max(latestLedger, res.latestLedger);
    for (const e of res.entries) {
      if (e.val.type !== "contractData") continue;
      const archived = e.liveUntilLedgerSeq !== undefined && e.liveUntilLedgerSeq < res.latestLedger;
      found.set(e.key.toXdr("base64"), { val: e.val.contractData.val, archived });
    }
  }
  return { latestLedger, found };
}

const unique = <T>(xs: T[]) => [...new Set(xs)];

/**
 * Everything this host has on the custody contracts it uses, read with no
 * key: the escrows' code, its stations' terms and its open sessions. The
 * candidates come from the signed registry (its stations under this host),
 * the contract's events the RPC still holds (about 7 days on testnet) and
 * what this phone saw before; the ledger then says what is really there.
 * The event read failing leaves the rest; a ledger read failing throws.
 */
export async function loadHostView(server: Rpc, net: NetworkConfig, host: string, reg: Registry | null): Promise<HostView> {
  const c = net.custody;
  if (!c) throw new EscrowError("contract", "no custody on this network");
  const mine = stationsByHostKey(reg, host);
  const escrows = unique([defaultEscrow(reg, net), ...mine.filter(isCustody).map((s) => s.escrow)]);
  const known = readKnown(net.id, host);
  const view: HostView = { network: net.id, host, escrows: [], stations: [], sessions: [], settled: [], owed: [], eventsIncomplete: false, latestLedger: 0 };
  const seen: Known = { stations: [], open: [] };
  // The tokens something may be owed in: the assets the app knows, the registry's custody stations' and the deposits'.
  const knownTokens = unique([
    assetContract({ code: "XLM", issuer: null }, net),
    assetContract(net.usdc, net),
    ...mine.filter(isCustody).map((s) => assetContract(s.asset, net)),
  ]);

  for (const escrow of escrows) {
    let tally: EventTally = { stations: [], open: new Map(), settled: [] };
    try {
      const scan = await scanHost(server, net, escrow, host);
      tally = tallyHostEvents(scan.events, host);
      if (!scan.complete) view.eventsIncomplete = true;
    } catch {
      view.eventsIncomplete = true;
    }
    const mineHere = known.stations.filter((k) => k.startsWith(`${escrow}/`)).map((k) => k.slice(escrow.length + 1));
    const openHere = known.open.filter((k) => k.startsWith(`${escrow}/`)).map((k) => k.slice(escrow.length + 1));
    const refs = unique([...tally.open.keys(), ...openHere])
      .map((k) => k.split("/"))
      .filter((p) => p.length === 3 && isB64url32(p[2]))
      .map(([station, session, anchor]) => ({ station, session, anchor: fromB64url(anchor) }));
    const ids = unique([...mine.map((s) => s.id), ...tally.stations, ...mineHere, ...refs.map((r) => r.station)]);

    const iKey = instanceKey(escrow);
    const sKeys = ids.map((id) => stationKey(escrow, host, id));
    const xKeys = refs.map((r) => sessionKey(escrow, host, r.station, r.session, r.anchor));
    const tokens = unique([...knownTokens, ...[...tally.open.values()].flatMap((o) => o.deposits.map((d) => d.terms.token))]);
    const oKeys = tokens.map((tk) => owedKey(escrow, host, tk));
    const { latestLedger, found } = await readEntries(server, [iKey, ...sKeys, ...xKeys, ...oKeys]);
    view.latestLedger = Math.max(view.latestLedger, latestLedger);
    const at = (k: xdr.LedgerKey) => found.get(k.toXdr("base64"));
    const owedIn = (tk: string, e: Entry | undefined) => {
      const amount = e ? (scValToNative(e.val) as unknown) : 0n;
      if (e && typeof amount === "bigint" && amount > 0n) view.owed.push({ escrow, token: tk, amount, archived: e.archived });
    };
    tokens.forEach((tk, i) => owedIn(tk, at(oKeys[i])));

    const inst = at(iKey);
    const wasmHash = inst ? wasmHashOf(inst.val) : null;
    view.escrows.push({ id: escrow, wasmHash, pinned: wasmHash !== null && c.escrowWasm.includes(wasmHash) });

    ids.forEach((id, i) => {
      const e = at(sKeys[i]);
      const terms = e ? toStationTerms(scValToNative(e.val)) : null;
      const row = stationRow(escrow, id, terms, e?.archived ?? false, mine.find((s) => s.id === id) ?? null, net);
      if (terms || row.registryState === "not_registered") view.stations.push(row);
      if (terms) seen.stations.push(`${escrow}/${id}`);
    });
    refs.forEach((r, i) => {
      const e = at(xKeys[i]);
      if (!e) return;
      const s = toEscrowSession(scValToNative(e.val));
      const key = tallyKey(r.station, r.session, r.anchor);
      const deposits = tally.open.get(key)?.deposits ?? [];
      view.sessions.push({ ...s, escrow, host, station: r.station, session: r.session, archived: e.archived, txHashes: deposits.map((d) => d.txHash) });
      seen.open.push(`${escrow}/${key}`);
    });
    // A station or session in an asset none of the above named: its owed entry too.
    const more = unique([
      ...view.stations.filter((st) => st.escrow === escrow && st.terms).map((st) => st.terms!.token),
      ...view.sessions.filter((s) => s.escrow === escrow).map((s) => s.token),
    ]).filter((tk) => !tokens.includes(tk));
    if (more.length > 0) {
      const extra = await readEntries(server, more.map((tk) => owedKey(escrow, host, tk)));
      more.forEach((tk) => owedIn(tk, extra.found.get(owedKey(escrow, host, tk).toXdr("base64"))));
    }
    view.settled.push(...tally.settled);
  }

  // Registry order first, then by ID.
  const order = (id: string) => {
    const i = mine.findIndex((s) => s.id === id);
    return i < 0 ? mine.length : i;
  };
  view.stations.sort((a, b) => order(a.id) - order(b.id) || a.id.localeCompare(b.id));
  view.sessions.sort((a, b) => a.deadline - b.deadline || a.session.localeCompare(b.session));
  view.settled = view.settled.sort((a, b) => b.ledger - a.ledger).slice(0, SETTLED_KEPT);
  // Stations stay remembered; sessions only while open.
  writeKnown(net.id, host, { stations: unique([...known.stations, ...seen.stations]), open: seen.open });
  return view;
}

/** The view after a settlement this phone sent: the session leaves the open list and heads the settled one. */
export function afterSettle(view: HostView, e: SettleEvent): HostView {
  const same = (s: HostSession) => s.station === e.station && s.session === e.session && toB64url(s.anchor) === toB64url(e.anchor);
  return { ...view, sessions: view.sessions.filter((s) => !same(s)), settled: [e, ...view.settled.filter((x) => x.txHash !== e.txHash)].slice(0, SETTLED_KEPT) };
}

/** The view after a register this phone sent: the station's row with its new terms. */
export function afterRegister(view: HostView, net: NetworkConfig, reg: Registry | null, escrow: string, id: string, terms: StationTerms): HostView {
  const entry = stationsByHostKey(reg, view.host).find((s) => s.id === id) ?? null;
  const row = stationRow(escrow, id, terms, false, entry, net);
  const i = view.stations.findIndex((s) => s.escrow === escrow && s.id === id);
  const stations = i < 0 ? [...view.stations, row] : view.stations.map((s, j) => (j === i ? row : s));
  return { ...view, stations };
}

/** The settle event a release or host_refund this phone sent will emit, built from its result. */
export function settleFromCall(s: HostSession, how: "deadline" | "host", done: HostCallDone, units = 0): SettleEvent {
  const paid = paidUnits(s.fichas, s);
  const toPayer = how === "host" ? (done.amount ?? refundSplit(s, units).toPayer) : 0n;
  return {
    kind: "settle",
    host: s.host,
    station: s.station,
    session: s.session,
    anchor: s.anchor,
    payer: s.payer,
    toHost: s.amount - toPayer,
    toPayer,
    unusedUnits: how === "host" ? Math.min(units, paid) : 0,
    how,
    txHash: done.hash,
    ledger: done.ledger,
    at: new Date(done.closedAt * 1000).toISOString(),
    id: "",
  };
}

// ---------------------------------------------------------------- release all

export interface BatchProgress {
  total: number;
  /** Sessions done so far, released or skipped. */
  done: number;
  /** The session being released now. */
  current: HostSession | null;
  released: { session: HostSession; result: HostCallDone }[];
  /** Sessions this one release could not settle (someone else did, the deadline is not past, archived). */
  skipped: { session: HostSession; error: unknown }[];
  /** Why the batch stopped before the end (wallet locked, no answer, no balance...); null otherwise. */
  stopped: unknown;
  running: boolean;
}

/** Errors that concern one session only: the batch goes on with the next. */
const SKIP: ReadonlySet<EscrowErrorCode> = new Set<EscrowErrorCode>(["NoSession", "TooEarly", "archived"]);

/**
 * Release sessions one after another (one contract call per transaction,
 * one transaction per account in the network's queue). A session someone
 * else settled meanwhile is skipped; anything else stops the batch, since
 * the next one would most likely fail the same way, and an unknown outcome
 * must be checked before sending more.
 */
export async function releaseMany(
  sessions: readonly HostSession[],
  release: (s: HostSession) => Promise<HostCallDone>,
  onProgress?: (p: BatchProgress) => void,
): Promise<BatchProgress> {
  const p: BatchProgress = { total: sessions.length, done: 0, current: null, released: [], skipped: [], stopped: null, running: true };
  const emit = () => onProgress?.({ ...p, released: [...p.released], skipped: [...p.skipped] });
  for (const s of sessions) {
    p.current = s;
    emit();
    try {
      p.released.push({ session: s, result: await release(s) });
    } catch (e) {
      if (!(e instanceof EscrowError && SKIP.has(e.code))) {
        p.stopped = e;
        break;
      }
      p.skipped.push({ session: s, error: e });
    }
    p.done += 1;
  }
  p.current = null;
  p.running = false;
  emit();
  return p;
}
