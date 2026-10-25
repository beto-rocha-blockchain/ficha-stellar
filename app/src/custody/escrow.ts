/**
 * FichaEscrow over Soroban RPC (docs/station-app-contract.md §7.1, §7.2):
 * reads with no key, building, simulating and sending calls, and the
 * contract's events. Nothing here holds a key: callers sign with the wallet
 * (src/wallet signTransaction), or, in the testnet integration test, a Keypair.
 *
 *   const view = await readEscrow(rpc, escrow, host, station, { session, anchor }); // code hash, terms, open session
 *   const p = await prepareCall(rpc, net, { source, escrow, fn: "deposit", args, auth });
 *   const sent = await sendAndWait(rpc, sign(p.tx), escrow);              // sent.returnValue
 *
 * The host's calls (register, release, host_refund) use the same pieces
 * (./host.ts).
 */
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AssetRef, CustodyConfig, NetworkConfig } from "@/config";
import { EscrowError, classifyFailure } from "./errors";

/** The RPC calls custody makes; rpc.Server has them all (tests pass a fake). */
export type Rpc = Pick<
  rpc.Server,
  | "getLedgerEntries"
  | "simulateTransaction"
  | "sendTransaction"
  | "getTransaction"
  | "getAccount"
  | "getEvents"
  | "getHealth"
  | "getFeeStats"
  | "getLatestLedger"
>;

const servers = new Map<string, rpc.Server>();

/** One shared rpc.Server per URL. */
export function getRpc(c: Pick<CustodyConfig, "rpcUrl">): rpc.Server {
  let s = servers.get(c.rpcUrl);
  if (!s) {
    s = new rpc.Server(c.rpcUrl);
    servers.set(c.rpcUrl, s);
  }
  return s;
}

/** The asset's Stellar Asset Contract: the `token` a station's terms name. */
export function assetContract(asset: AssetRef, net: Pick<NetworkConfig, "passphrase" | "custody">): string {
  if (asset.issuer === null) return net.custody?.xlmSac ?? Asset.native().contractId(net.passphrase);
  return new Asset(asset.code, asset.issuer).contractId(net.passphrase);
}

// ---------------------------------------------------------------- arguments

export const sym = (s: string): xdr.ScVal => nativeToScVal(s, { type: "symbol" });
export const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
export const u32 = (n: number): xdr.ScVal => nativeToScVal(n, { type: "u32" });
export const i128 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: "i128" });
export const bytes32 = (b: Uint8Array): xdr.ScVal => {
  if (b.length !== 32) throw new Error("BytesN<32> needs 32 bytes");
  return xdr.ScVal.scvBytes(b);
};

/**
 * The terms a deposit is made under (the contract's Terms): the station's
 * for a new session, the session's own for a top-up. The payer signs them
 * with the deposit, so terms changed after the app read them fail it
 * (TermsChanged) instead of applying (contract §7.1).
 */
export interface DepositTerms {
  token: string;
  price: bigint;
  fichaSecs: number;
  maxFichas: number;
  unitSecs: number;
  graceSecs: number;
}

/** Terms as the contract takes them: a map with Symbol keys, in key order. */
export function termsVal(t: DepositTerms): xdr.ScVal {
  const entry = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: sym(k), val: v });
  return xdr.ScVal.scvMap([
    entry("ficha_secs", u32(t.fichaSecs)),
    entry("grace_secs", nativeToScVal(BigInt(t.graceSecs), { type: "u64" })),
    entry("max_fichas", u32(t.maxFichas)),
    entry("price", i128(t.price)),
    entry("token", addr(t.token)),
    entry("unit_secs", u32(t.unitSecs)),
  ]);
}

/** Just the Terms fields of a station's or a session's terms. */
export function depositTerms(t: DepositTerms): DepositTerms {
  return { token: t.token, price: t.price, fichaSecs: t.fichaSecs, maxFichas: t.maxFichas, unitSecs: t.unitSecs, graceSecs: t.graceSecs };
}

export interface DepositArgs {
  payer: string;
  host: string;
  station: string;
  /** The bare session ID (F + 7). */
  session: string;
  fichas: number;
  anchor: Uint8Array;
  terms: DepositTerms;
}

/** deposit(payer, host, station, session, fichas, anchor, terms) */
export function depositArgs(a: DepositArgs): xdr.ScVal[] {
  return [addr(a.payer), addr(a.host), sym(a.station), sym(a.session), u32(a.fichas), bytes32(a.anchor), termsVal(a.terms)];
}

export interface ClaimArgs {
  host: string;
  station: string;
  session: string;
  /** The session's anchor: with the ID, which session it is. */
  anchor: Uint8Array;
  units: number;
  proof: Uint8Array;
}

/** claim(host, station, session, anchor, unused_units, proof) */
export function claimArgs(a: ClaimArgs): xdr.ScVal[] {
  return [addr(a.host), sym(a.station), sym(a.session), bytes32(a.anchor), u32(a.units), bytes32(a.proof)];
}

// ---------------------------------------------------------------- reads

/** A station's terms on the contract (StationCfg). */
export interface StationTerms {
  /** The asset's contract (C...). */
  token: string;
  /** One ficha, in stroops. */
  price: bigint;
  fichaSecs: number;
  maxFichas: number;
  unitSecs: number;
  graceSecs: number;
  active: boolean;
}

/** An open session (Session): the station's terms frozen at its first deposit, and the totals. */
export interface EscrowSession {
  payer: string;
  token: string;
  price: bigint;
  fichaSecs: number;
  unitSecs: number;
  maxFichas: number;
  graceSecs: number;
  /** N, the chain's length. */
  chainLen: number;
  anchor: Uint8Array;
  fichas: number;
  /** Stroops. */
  amount: bigint;
  /** Ledger unix seconds. */
  opened: number;
  deadline: number;
}

type Native = Record<string, unknown>;

function field<T>(m: Native, k: string, ok: (v: unknown) => v is T): T {
  const v = m[k];
  if (!ok(v)) throw new Error(`escrow: bad ${k}`);
  return v;
}
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isBig = (v: unknown): v is bigint => typeof v === "bigint";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;

/** scValToNative of a StationCfg map. */
export function toStationTerms(v: unknown): StationTerms {
  const m = v as Native;
  return {
    token: field(m, "token", isStr),
    price: field(m, "price", isBig),
    fichaSecs: field(m, "ficha_secs", isNum),
    maxFichas: field(m, "max_fichas", isNum),
    unitSecs: field(m, "unit_secs", isNum),
    graceSecs: Number(field(m, "grace_secs", isBig)),
    active: field(m, "active", isBool),
  };
}

/** scValToNative of a Session map. */
export function toEscrowSession(v: unknown): EscrowSession {
  const m = v as Native;
  return {
    payer: field(m, "payer", isStr),
    token: field(m, "token", isStr),
    price: field(m, "price", isBig),
    fichaSecs: field(m, "ficha_secs", isNum),
    unitSecs: field(m, "unit_secs", isNum),
    maxFichas: field(m, "max_fichas", isNum),
    graceSecs: Number(field(m, "grace_secs", isBig)),
    chainLen: field(m, "chain_len", isNum),
    anchor: field(m, "anchor", isBytes),
    fichas: field(m, "fichas", isNum),
    amount: field(m, "amount", isBig),
    opened: Number(field(m, "opened", isBig)),
    deadline: Number(field(m, "deadline", isBig)),
  };
}

function dataKey(escrow: string, key: xdr.ScVal): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({ contract: new Address(escrow).toScAddress(), key, durability: xdr.ContractDataDurability.persistent }),
  );
}

/** The contract's instance: its value names the wasm it runs. */
export const instanceKey = (escrow: string) => dataKey(escrow, xdr.ScVal.scvLedgerKeyContractInstance());
/** Key::Station(host, station) */
export const stationKey = (escrow: string, host: string, station: string) => dataKey(escrow, xdr.ScVal.scvVec([sym("Station"), addr(host), sym(station)]));
/** Key::Session(host, station, session, anchor): a session is its ID and its anchor (contract §7.2). */
export const sessionKey = (escrow: string, host: string, station: string, session: string, anchor: Uint8Array) =>
  dataKey(escrow, xdr.ScVal.scvVec([sym("Session"), addr(host), sym(station), sym(session), bytes32(anchor)]));
/** Key::Owed(host, token): what the contract holds for the host in that token until pay_host (contract §7.1 owed). */
export const owedKey = (escrow: string, host: string, token: string) => dataKey(escrow, xdr.ScVal.scvVec([sym("Owed"), addr(host), addr(token)]));
export interface EscrowView {
  /** The wasm sha256 (hex) the contract runs; null when the contract does not exist. */
  wasmHash: string | null;
  station: StationTerms | null;
  /** The open session, when one was asked for and is open. */
  session: EscrowSession | null;
  /** An entry read is past its time to live: it must be restored before use. */
  archived: boolean;
  latestLedger: number;
}

/** The wasm sha256 (hex) a contract instance's value names; null for anything else. */
export function wasmHashOf(val: xdr.ScVal): string | null {
  if (val.type === "scvContractInstance" && val.instance.executable.type === "contractExecutableWasm") {
    return val.instance.executable.wasmHash.toString().toLowerCase();
  }
  return null;
}

/** One session on the contract: its ID and its anchor. */
export interface SessionId {
  /** The bare session ID (F + 7). */
  session: string;
  anchor: Uint8Array;
}

/** The contract's code, a station's terms and (optionally) an open session, in one getLedgerEntries call. */
export async function readEscrow(server: Rpc, escrow: string, host: string, station: string, session?: SessionId): Promise<EscrowView> {
  const keys = [instanceKey(escrow), stationKey(escrow, host, station), ...(session ? [sessionKey(escrow, host, station, session.session, session.anchor)] : [])];
  const res = await server.getLedgerEntries(...keys);
  const want = keys.map((k) => k.toXdr("base64"));
  const view: EscrowView = { wasmHash: null, station: null, session: null, archived: false, latestLedger: res.latestLedger };
  for (const e of res.entries) {
    const i = want.indexOf(e.key.toXdr("base64"));
    if (i < 0 || e.val.type !== "contractData") continue;
    if (e.liveUntilLedgerSeq !== undefined && e.liveUntilLedgerSeq < res.latestLedger) view.archived = true;
    const val = e.val.contractData.val;
    if (i === 0) view.wasmHash = wasmHashOf(val);
    else if (i === 1) view.station = toStationTerms(scValToNative(val));
    else view.session = toEscrowSession(scValToNative(val));
  }
  return view;
}

export interface SessionsRead {
  /** The key's index -> its open session. */
  sessions: Map<number, EscrowSession>;
  /**
   * The oldest ledger the answers stand at (the RPC node's latest when it
   * answered): a session missing at a ledger before its first deposit's only
   * means that node has not caught up yet. 0 when no key was read.
   */
  latestLedger: number;
}

/**
 * The latest ledger's close time (unix seconds): the clock the contract
 * decides deadlines by (contract §7.6 step 4). null when the RPC cannot say:
 * then nothing is refused on time, and the simulation has the last word. The
 * phone's clock is never used for it: minutes fast, it would hide a claim
 * the contract still takes.
 */
export async function ledgerTime(server: Rpc): Promise<number | null> {
  try {
    const t = Number((await server.getLatestLedger()).closeTime);
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Open sessions under several keys at once (History). */
export async function readSessions(server: Rpc, keys: ({ escrow: string; host: string; station: string } & SessionId)[]): Promise<SessionsRead> {
  const sessions = new Map<number, EscrowSession>();
  let latestLedger = 0;
  // getLedgerEntries takes at most 200 keys per call.
  for (let at = 0; at < keys.length; at += 200) {
    const chunk = keys.slice(at, at + 200);
    const lk = chunk.map((k) => sessionKey(k.escrow, k.host, k.station, k.session, k.anchor));
    const want = lk.map((k) => k.toXdr("base64"));
    const res = await server.getLedgerEntries(...lk);
    latestLedger = latestLedger === 0 ? res.latestLedger : Math.min(latestLedger, res.latestLedger);
    for (const e of res.entries) {
      const i = want.indexOf(e.key.toXdr("base64"));
      if (i >= 0 && e.val.type === "contractData") sessions.set(at + i, toEscrowSession(scValToNative(e.val.contractData.val)));
    }
  }
  return { sessions, latestLedger };
}

// ---------------------------------------------------------------- calls

/** The most a custody call may cost in fees on the public network (0.5 XLM): a deposit was about 0.067 XLM, a claim 0.0012, in October 2026 (contract §7.1). */
export const MAX_CALL_FEE_STROOPS = 5_000_000n;
/**
 * On testnet, 30 XLM. Its XLM is free (Friendbot gives 10 000), and its
 * resource fees surge as its ledger state grows before a reset: on 25 October
 * 2026 a deposit simulated at 2.23 XLM, over the public cap. Above this the
 * call is refused all the same.
 */
export const MAX_TESTNET_CALL_FEE_STROOPS = 300_000_000n;

/** The fee cap for a call on this network. */
export function maxCallFee(passphrase: string): bigint {
  return passphrase === Networks.TESTNET ? MAX_TESTNET_CALL_FEE_STROOPS : MAX_CALL_FEE_STROOPS;
}
/** The inclusion fee bid per operation, at most this (the resource fee comes on top). */
const MAX_INCLUSION_STROOPS = 10_000;
/** Seconds a signed call stays valid: it is signed right after the simulation. */
export const CALL_TIMEOUT_SECONDS = 60;

/**
 * One contract call as an unsigned transaction (no footprint yet: simulate
 * it). `ledgerNow` is the ledger's time (ledgerTime): the call is valid until
 * CALL_TIMEOUT_SECONDS past it, by the network's clock, so a phone whose
 * clock runs a minute or more behind can still send it (the network refuses
 * a transaction past its maxTime: txTooLate). Without it, the phone's clock.
 */
export function buildCallTx(
  source: Account,
  passphrase: string,
  escrow: string,
  fn: string,
  args: xdr.ScVal[],
  fee: string = BASE_FEE,
  ledgerNow: number | null = null,
): Transaction {
  const b = new TransactionBuilder(source, { fee, networkPassphrase: passphrase }).addOperation(new Contract(escrow).call(fn, ...args));
  return (ledgerNow !== null ? b.setTimebounds(0, Math.floor(ledgerNow) + CALL_TIMEOUT_SECONDS) : b.setTimeout(CALL_TIMEOUT_SECONDS)).build();
}

/** What the call may ask the source account to authorize: this contract call and, under it, exactly these. */
export interface ExpectedAuth {
  contract: string;
  fn: string;
  args: xdr.ScVal[];
  sub: ExpectedAuth[];
}

function sameInvocation(inv: xdr.SorobanAuthorizedInvocation, want: ExpectedAuth): boolean {
  const f = inv.function;
  if (f.type !== "sorobanAuthorizedFunctionTypeContractFn") return false;
  const call = f.contractFn;
  if (Address.fromScAddress(call.contractAddress).toString() !== want.contract) return false;
  if (call.functionName.toString() !== want.fn) return false;
  if (call.args.length !== want.args.length || call.args.some((a, i) => a.toXdr("base64") !== want.args[i].toXdr("base64"))) return false;
  if (inv.subInvocations.length !== want.sub.length) return false;
  return inv.subInvocations.every((s, i) => sameInvocation(s, want.sub[i]));
}

/**
 * The authorization a simulation asks for must be exactly `want`, signed by
 * the transaction's source (contract §7.4 step 6): for a deposit, this call
 * and the asset's transfer(payer, escrow, fichas x price) under it, so the
 * signature covers the amount. Anything else throws EscrowError("bad_auth").
 */
export function checkAuth(auth: readonly xdr.SorobanAuthorizationEntry[], want: ExpectedAuth | null): void {
  if (want === null) {
    if (auth.length !== 0) throw new EscrowError("bad_auth", `${auth.length} entries, none expected`);
    return;
  }
  if (auth.length !== 1) throw new EscrowError("bad_auth", `${auth.length} entries`);
  const [entry] = auth;
  if (entry.credentials.type !== "sorobanCredentialsSourceAccount") throw new EscrowError("bad_auth", entry.credentials.type);
  if (!sameInvocation(entry.rootInvocation, want)) throw new EscrowError("bad_auth", "another invocation");
}

/** The deposit's authorization: deposit(...) and, under it, the asset's transfer of the amount to the escrow. */
export function depositAuth(escrow: string, token: string, a: DepositArgs, amount: bigint): ExpectedAuth {
  return {
    contract: escrow,
    fn: "deposit",
    args: depositArgs(a),
    sub: [{ contract: token, fn: "transfer", args: [addr(a.payer), addr(escrow), i128(amount)], sub: [] }],
  };
}

/** The claim's authorization: the payer's, for claim(...) alone (the payouts come from the contract). */
export function claimAuth(escrow: string, a: ClaimArgs): ExpectedAuth {
  return { contract: escrow, fn: "claim", args: claimArgs(a), sub: [] };
}

async function inclusionFee(server: Rpc): Promise<string> {
  try {
    const p90 = Number((await server.getFeeStats()).sorobanInclusionFee.p90);
    return String(Math.min(Math.max(Number.isFinite(p90) ? Math.ceil(p90) : 0, Number(BASE_FEE)), MAX_INCLUSION_STROOPS));
  } catch {
    return BASE_FEE;
  }
}

/** Simulate; a contract error, an archived entry or an RPC error throws. */
export async function simulateCall(server: Rpc, tx: Transaction, escrow: string): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw classifyFailure(sim.error, sim.events, escrow);
  if (rpc.Api.isSimulationRestore(sim)) throw new EscrowError("archived");
  return sim;
}

export interface PreparedCall {
  /** Ready to sign: footprint, resources and fee set from the simulation. */
  tx: Transaction;
  /** The most the transaction can cost, in stroops (inclusion bid + resource fee). */
  fee: bigint;
  /** What the call returns, as simulated. */
  result: xdr.ScVal | undefined;
}

/**
 * Build, simulate and assemble a call from `source`, refusing before
 * anything is signed when the contract would fail (OtherPayer, Expired,
 * BadProof...), when the simulation asks to authorize anything but `auth`,
 * or when the fee is out of bounds.
 */
export async function prepareCall(
  server: Rpc,
  passphrase: string,
  c: { source: string; escrow: string; fn: string; args: xdr.ScVal[]; auth: ExpectedAuth | null },
): Promise<PreparedCall> {
  let account: Account;
  try {
    account = await server.getAccount(c.source);
  } catch (e) {
    if (/not found/i.test(String((e as Error)?.message))) throw new EscrowError("not_funded");
    throw e;
  }
  // The time bounds by the ledger's clock, not the phone's (null: the phone's, as a last resort).
  const [bid, now] = await Promise.all([inclusionFee(server), ledgerTime(server)]);
  const tx = buildCallTx(account, passphrase, c.escrow, c.fn, c.args, bid, now);
  const sim = await simulateCall(server, tx, c.escrow);
  checkAuth(sim.result?.auth ?? [], c.auth);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  const fee = BigInt(prepared.fee);
  if (fee > maxCallFee(passphrase)) throw new EscrowError("fee_too_high", prepared.fee);
  return { tx: prepared, fee, result: sim.result?.retval };
}

export interface SentCall {
  hash: string;
  ledger: number;
  /** Unix seconds of the ledger that included it. */
  closedAt: number;
  returnValue: xdr.ScVal | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a signed call and follow it to its result. A refusal before or at
 * the ledger throws EscrowError with what the contract or the network said;
 * no answer at all throws "unknown_outcome" (it may have been applied), and
 * a transaction past its time bounds that never showed up "too_late"
 * (nothing happened; txTooLate at the door too). It never sends twice.
 *
 * The time bounds are the ledger's (buildCallTx), so the wait is measured on
 * the ledger's clock too: the latest close time the RPC reports, advanced by
 * the time elapsed since (`now` only measures that). A phone minutes off then
 * neither gives up before the transaction could land nor waits for minutes
 * after it no longer can. With no close time from the RPC, the phone's clock.
 */
export async function sendAndWait(server: Rpc, tx: Transaction, escrow: string, opts: { pollMs?: number; now?: () => number } = {}): Promise<SentCall> {
  const pollMs = opts.pollMs ?? 2000;
  const now = opts.now ?? Date.now;
  const hash = bytesToHex(tx.hash());
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  let seen: { close: number; at: number } | null = null;
  const observe = (close: unknown) => {
    const c = Number(close);
    if (Number.isFinite(c) && c > 0) seen = { close: c, at: now() };
  };
  const clock = () => (seen ? seen.close + (now() - seen.at) / 1000 : now() / 1000);
  try {
    const r = await server.sendTransaction(tx);
    observe(r.latestLedgerCloseTime);
    if (r.status === "ERROR") {
      if (r.diagnosticEvents?.length) throw classifyFailure(undefined, r.diagnosticEvents, escrow);
      const result = r.errorResult?.result.type;
      // Past its time bounds before it reached a ledger: nothing happened.
      if (result === "txTooLate") throw new EscrowError("too_late", result);
      throw new EscrowError("rejected", result);
    }
    if (r.status === "TRY_AGAIN_LATER") throw new EscrowError("busy");
  } catch (e) {
    if (e instanceof EscrowError) throw e;
    // No answer: it may have reached the network. Find out below.
  }
  let answered = false;
  // Past maxTime (plus a few ledgers) a transaction not seen can no longer be included.
  while (maxTime === 0 || clock() < maxTime + 30) {
    try {
      const t = await server.getTransaction(hash);
      answered = true;
      observe(t.latestLedgerCloseTime);
      if (t.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { hash, ledger: t.ledger, closedAt: t.createdAt, returnValue: t.returnValue };
      }
      if (t.status === rpc.Api.GetTransactionStatus.FAILED) {
        const events = t.diagnosticEventsXdr ?? [];
        if (events.length) throw classifyFailure(undefined, events, escrow);
        throw new EscrowError("rejected", t.resultXdr.result.type);
      }
    } catch (e) {
      if (e instanceof EscrowError) throw e;
      answered = false;
    }
    if (maxTime === 0) break;
    await sleep(pollMs);
  }
  throw new EscrowError(answered ? "too_late" : "unknown_outcome");
}

// ---------------------------------------------------------------- events

export interface DepositEvent {
  kind: "deposit";
  host: string;
  station: string;
  session: string;
  payer: string;
  /** This deposit's. */
  fichas: number;
  amount: bigint;
  /** The session's after it. */
  totalFichas: number;
  totalAmount: bigint;
  anchor: Uint8Array;
  deadline: number;
  /** The session's terms, frozen at its first deposit. */
  terms: DepositTerms;
  txHash: string;
  ledger: number;
  /** ISO time of the ledger. */
  at: string;
  id: string;
}

export interface SettleEvent {
  kind: "settle";
  host: string;
  station: string;
  session: string;
  /** With the ID, which session settled. */
  anchor: Uint8Array;
  payer: string;
  toHost: bigint;
  toPayer: bigint;
  unusedUnits: number;
  how: "proof" | "deadline" | "host";
  txHash: string;
  ledger: number;
  at: string;
  id: string;
}

export type EscrowEvent = DepositEvent | SettleEvent;

/** scValToNative of a Terms map. */
export function toDepositTerms(v: unknown): DepositTerms {
  const m = v as Native;
  return {
    token: field(m, "token", isStr),
    price: field(m, "price", isBig),
    fichaSecs: field(m, "ficha_secs", isNum),
    maxFichas: field(m, "max_fichas", isNum),
    unitSecs: field(m, "unit_secs", isNum),
    graceSecs: Number(field(m, "grace_secs", isBig)),
  };
}

/** A deposit or settle event, or null for any other (station, owed, payout) or a malformed one. */
export function parseEscrowEvent(e: Pick<rpc.Api.EventResponse, "topic" | "value" | "txHash" | "ledger" | "ledgerClosedAt" | "id">): EscrowEvent | null {
  try {
    const [name, host, station, session] = e.topic.map((t) => scValToNative(t) as unknown);
    if (!isStr(host) || !isStr(station) || !isStr(session)) return null;
    const m = scValToNative(e.value) as Native;
    const base = { host, station, session, payer: field(m, "payer", isStr), txHash: e.txHash, ledger: e.ledger, at: e.ledgerClosedAt, id: e.id };
    if (name === "deposit") {
      return {
        kind: "deposit",
        ...base,
        fichas: field(m, "fichas", isNum),
        amount: field(m, "amount", isBig),
        totalFichas: field(m, "total_fichas", isNum),
        totalAmount: field(m, "total_amount", isBig),
        anchor: field(m, "anchor", isBytes),
        deadline: Number(field(m, "deadline", isBig)),
        terms: toDepositTerms(m.terms),
      };
    }
    if (name === "settle") {
      const how = field(m, "how", isStr);
      if (how !== "proof" && how !== "deadline" && how !== "host") return null;
      return {
        kind: "settle",
        ...base,
        anchor: field(m, "anchor", isBytes),
        toHost: field(m, "to_host", isBig),
        toPayer: field(m, "to_payer", isBig),
        unusedUnits: field(m, "unused_units", isNum),
        how,
      };
    }
  } catch {
    /* not one of ours */
  }
  return null;
}

/** The getEvents filters for deposit and settle on these (host, station) pairs: one filter per station. */
export function eventFilters(escrow: string, stations: { host: string; station: string }[]): rpc.Api.EventFilter[] {
  const b64 = (v: xdr.ScVal) => v.toXdr("base64");
  return stations.map((s) => ({
    type: "contract" as const,
    contractIds: [escrow],
    topics: ["deposit", "settle"].map((n) => [b64(sym(n)), b64(addr(s.host)), b64(sym(s.station)), "*"]),
  }));
}

/**
 * Events read before, then the new ones not among them (by event ID): a scan
 * resumed from a cursor may return events it already gave, and kept scans
 * must not grow with each load.
 */
export function mergeEvents<T extends { id: string }>(kept: readonly T[], fresh: readonly T[]): T[] {
  const seen = new Set(kept.map((e) => e.id));
  const out = [...kept];
  for (const e of fresh) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/** The getEvents filters for one session ID's deposit and settle events (any anchor). */
export function sessionEventFilters(escrow: string, host: string, station: string, session: string): rpc.Api.EventFilter[] {
  const b64 = (v: xdr.ScVal) => v.toXdr("base64");
  return [{ type: "contract", contractIds: [escrow], topics: ["deposit", "settle"].map((n) => [b64(sym(n)), b64(addr(host)), b64(sym(station)), b64(sym(session))]) }];
}

/**
 * Every deposit and settle event under one session ID that the RPC still
 * holds (about 7 days on testnet), oldest first: whether a pay link's
 * session was already paid, maybe settled, by anyone (contract §7.4 step 4).
 * The filter names the session, so the pages are nearly empty; a week is
 * about 13 requests. A scan that does not reach the latest ledger (an RPC
 * keeping more than the pages read) throws EscrowError("unchecked"): the
 * newest ledgers, where a recent payment would be, were not read.
 */
export async function sessionEvents(server: Rpc, escrow: string, host: string, station: string, session: string): Promise<EscrowEvent[]> {
  const scan = await scanEvents(server, sessionEventFilters(escrow, host, station, session), parseEscrowEvent);
  if (!scan.complete) throw new EscrowError("unchecked", "events read up to ledger " + cursorLedger(scan.cursor) + " of " + scan.latestLedger);
  return scan.events;
}

/** getEvents takes at most this many filters: fetchEscrowEvents reads this many stations at a time. */
export const MAX_EVENT_STATIONS = 5;

export interface EventScan<T = EscrowEvent> {
  events: T[];
  /** Continue from here next time (getEvents cursor). */
  cursor: string;
  latestLedger: number;
  /** Reached the latest ledger (else maxPages ran out first). */
  complete: boolean;
}

/** Where a scan starts: a cursor from an earlier one, or a ledger (default: the oldest the RPC keeps). */
export type ScanFrom = { cursor: string } | { startLedger?: number };

/**
 * Deposit and settle events of up to MAX_EVENT_STATIONS stations on one
 * escrow, oldest first, from `from` (a cursor, or a ledger; default the
 * oldest the RPC keeps, about 7 days on testnet) to the latest ledger.
 */
export async function fetchEscrowEvents(
  server: Rpc,
  escrow: string,
  stations: { host: string; station: string }[],
  from: ScanFrom = {},
  maxPages = 30,
): Promise<EventScan> {
  if (stations.length > MAX_EVENT_STATIONS) throw new Error(`at most ${MAX_EVENT_STATIONS} stations per scan`);
  if (stations.length === 0) return { events: [], cursor: "", latestLedger: 0, complete: true };
  return scanEvents(server, eventFilters(escrow, stations), parseEscrowEvent, from, maxPages);
}

/**
 * The events `filters` match, as `parse` reads them (null drops one), oldest
 * first, from `from` to the latest ledger. The RPC scans a limited number of
 * ledgers per request (10 000 on testnet), so this pages by cursor: a whole
 * week is about 13 requests.
 */
export async function scanEvents<T>(
  server: Rpc,
  filters: rpc.Api.EventFilter[],
  parse: (e: rpc.Api.EventResponse) => T | null,
  from: ScanFrom = {},
  maxPages = 30,
): Promise<EventScan<T>> {
  const events: T[] = [];
  let cursor = "cursor" in from ? from.cursor : "";
  const startLedger = "startLedger" in from && from.startLedger !== undefined ? from.startLedger : cursor ? 0 : (await server.getHealth()).oldestLedger;
  let latestLedger = 0;
  let complete = false;
  for (let page = 0; page < maxPages && !complete; page++) {
    const res = await server.getEvents(cursor ? { cursor, filters, limit: 100 } : { startLedger, filters, limit: 100 });
    for (const e of res.events) {
      const ev = parse(e);
      if (ev !== null) events.push(ev);
    }
    latestLedger = res.latestLedger;
    // A short page whose cursor reached the latest ledger is the end; a full one resumes after its last event.
    complete = res.events.length < 100 && cursorLedger(res.cursor) >= res.latestLedger;
    cursor = res.cursor;
  }
  return { events, cursor, latestLedger, complete };
}

/** The ledger a getEvents cursor points into (its TOID's high 32 bits). */
export function cursorLedger(cursor: string): number {
  try {
    return Number(BigInt(cursor.split("-")[0]) >> 32n);
  } catch {
    return 0;
  }
}
