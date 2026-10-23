/**
 * This wallet's custody sessions, from what the phone kept and what the
 * ledger says (docs/station-app-contract.md §7.2): the deposits it made
 * (src/custody/deposits-store.ts), the deposit and settle events the RPC
 * still holds (about 7 days on testnet), and, for a session with no settle
 * event in reach, session() on the contract: open, or gone (settled).
 */
import type { AssetRef, NetworkConfig } from "@/config";
import { isCustody, maxFichas, type Registry } from "@/registry/verify";
import { chainLength, fromB64url, toB64url } from "./chain";
import { ledgerWasReset } from "./check";
import { depositKey, listDeposits, saveDeposit, type DepositRecord, type SettledInfo } from "./deposits-store";
import { MAX_EVENT_STATIONS, assetContract, fetchEscrowEvents, mergeEvents, readSessions, type EscrowEvent, type EscrowSession, type Rpc, type SettleEvent } from "./escrow";

/** What a deposit event needs from outside to become a record: the station's asset and terms. */
export interface StationContext {
  asset: AssetRef;
  token: string;
  fichaSecs: number;
  unitSecs: number;
  maxFichas: number;
  graceSecs: number;
}

export function settledFrom(e: SettleEvent): SettledInfo {
  return { how: e.how, toPayer: e.toPayer.toString(), toHost: e.toHost.toString(), unusedUnits: e.unusedUnits, txHash: e.txHash, at: e.at };
}

/**
 * Not known to be settled: open, or only missing from a session read
 * (how "unknown"), which a later read may find open after all (an RPC node
 * behind the one that confirmed the deposit). A settle event, or a claim
 * this phone sent, is final.
 */
export function maybeOpen(r: Pick<DepositRecord, "settled">): boolean {
  return !r.settled || r.settled.how === "unknown";
}

/**
 * The record brought in line with its session as the contract holds it: the
 * totals, the deadline and the terms the contract froze at the first
 * deposit (what a claim splits by; the phone's copy may predate a change of
 * terms, or come from the registry). The same object when nothing differs.
 */
export function withSession(r: DepositRecord, s: EscrowSession): DepositRecord {
  const t = r.terms;
  const termsSame =
    t.price === s.price.toString() &&
    t.fichaSecs === s.fichaSecs &&
    t.unitSecs === s.unitSecs &&
    t.maxFichas === s.maxFichas &&
    t.graceSecs === s.graceSecs &&
    t.chainLen === s.chainLen;
  if (termsSame && r.fichas === s.fichas && r.amount === s.amount.toString() && r.deadline === s.deadline && r.token === s.token) return r;
  return {
    ...r,
    token: s.token,
    terms: termsSame ? t : { price: s.price.toString(), fichaSecs: s.fichaSecs, unitSecs: s.unitSecs, maxFichas: s.maxFichas, graceSecs: s.graceSecs, chainLen: s.chainLen },
    fichas: s.fichas,
    amount: s.amount.toString(),
    deadline: s.deadline,
  };
}

/** The record with no settlement: a session read found it open after all. */
function reopened(r: DepositRecord): DepositRecord {
  const { settled: _settled, ...open } = r;
  return open;
}

/**
 * Apply one escrow's events (oldest first) to this payer's records, keyed by
 * depositKey: a deposit the phone does not know becomes a record (with the
 * session's own terms, from the event; `context` gives the station's asset),
 * a later one updates the totals, a settle closes it. A session is its ID and
 * its anchor, and so is a record's key: sessions under one ID with different
 * anchors (a pay link with another chain) are listed side by side, and one
 * never closes or replaces the other. A deposit after a settle under the same
 * ID and anchor is a new session (a stale QR): it replaces the old record.
 * Returns the keys it changed.
 */
export function applyEvents(
  records: Map<string, DepositRecord>,
  events: EscrowEvent[],
  base: { network: NetworkConfig["id"]; escrow: string; payer: string },
  context: (host: string, station: string) => StationContext | undefined,
): Set<string> {
  const changed = new Set<string>();
  for (const e of events) {
    if (e.payer !== base.payer) continue;
    const anchor = toB64url(e.anchor);
    const key = depositKey({ ...base, hostKey: e.host, stationId: e.station, session: e.session, anchor });
    const r = records.get(key);
    if (e.kind === "settle") {
      if (r && maybeOpen(r)) {
        records.set(key, { ...r, settled: settledFrom(e) });
        changed.add(key);
      }
      continue;
    }
    const at = Date.parse(e.at);
    if (r && maybeOpen(r)) {
      // A top-up (or the deposit the phone already kept): the event has the totals.
      const hashes = r.txHashes.includes(e.txHash) ? r.txHashes : [...r.txHashes, e.txHash];
      if (r.fichas !== e.totalFichas || hashes !== r.txHashes || r.deadline !== e.deadline || r.ledger === undefined) {
        records.set(key, { ...r, fichas: e.totalFichas, amount: e.totalAmount.toString(), deadline: e.deadline, txHashes: hashes, ledger: r.ledger ?? e.ledger });
        changed.add(key);
      }
      continue;
    }
    // A settled session's own deposits come again with every scan; only a first deposit after
    // its settle is a new session under the same ID and anchor.
    if (r?.settled && (r.txHashes.includes(e.txHash) || e.fichas !== e.totalFichas || !r.settled.at || !(Date.parse(e.at) > Date.parse(r.settled.at)))) continue;
    const ctx = context(e.host, e.station);
    if (!ctx || e.totalFichas === 0 || e.terms.token !== ctx.token) continue;
    // The session's own terms, as the contract froze them (and the payer signed).
    const t = e.terms;
    const terms = { fichaSecs: t.fichaSecs, unitSecs: t.unitSecs, maxFichas: t.maxFichas };
    records.set(key, {
      ...base,
      hostKey: e.host,
      stationId: e.station,
      session: e.session,
      anchor,
      asset: ctx.asset,
      token: t.token,
      terms: { price: t.price.toString(), ...terms, graceSecs: t.graceSecs, chainLen: chainLength(terms) },
      fichas: e.totalFichas,
      amount: e.totalAmount.toString(),
      deadline: e.deadline,
      txHashes: [e.txHash],
      ledger: e.ledger,
      createdAt: Number.isFinite(at) ? at : Date.now(),
    });
    changed.add(key);
  }
  return changed;
}

/** The context of the registry's custody stations: (host, station) -> asset and terms. */
export function registryContext(reg: Registry | null, net: NetworkConfig): (host: string, station: string) => StationContext | undefined {
  return (host, station) => {
    const st = reg?.stations.find((s) => s.id === station && s.host_key === host);
    if (!isCustody(st)) return undefined;
    return {
      asset: st.asset,
      token: assetContract(st.asset, net),
      fichaSecs: st.ficha_minutes * 60,
      unitSecs: st.unit_seconds,
      maxFichas: maxFichas(st),
      graceSecs: st.grace_seconds,
    };
  };
}

interface ScanState {
  cursor: string;
  events: EscrowEvent[];
}

/** Events already read in this app session, per escrow and station set: the next load reads only what is new. */
const scans = new Map<string, ScanState>();

/** Every deposit and settle event of these stations on one escrow that the RPC still holds, each once. */
export async function scanStations(server: Rpc, net: NetworkConfig, escrow: string, stations: { host: string; station: string }[]): Promise<EscrowEvent[]> {
  const id = [net.id, escrow, ...stations.map((s) => `${s.host}/${s.station}`).sort()].join("|");
  const prev = scans.get(id);
  let res;
  try {
    res = await fetchEscrowEvents(server, escrow, stations, prev ? { cursor: prev.cursor } : {});
  } catch (e) {
    // A cursor older than the RPC's window is refused: start again from the oldest ledger it keeps.
    if (!prev) throw e;
    scans.delete(id);
    res = await fetchEscrowEvents(server, escrow, stations, {});
  }
  const events = mergeEvents(scans.get(id)?.events ?? [], res.events);
  if (res.cursor) scans.set(id, { cursor: res.cursor, events });
  return events;
}

/** Forget the events read so far (tests; a network switch keeps its own). */
export function forgetEventScans(): void {
  scans.clear();
}

/**
 * This wallet's custody sessions on a network, newest first, brought up to
 * date with the ledger and saved back. RPC failures leave the records as the
 * phone has them (History still lists them).
 */
export async function loadCustodySessions(server: Rpc, net: NetworkConfig, payer: string, reg: Registry | null): Promise<DepositRecord[]> {
  const stored = await listDeposits(net.id, payer);
  const records = new Map(stored.map((r) => [depositKey(r), r]));
  const changed = new Set<string>();
  const regContext = registryContext(reg, net);
  // A station the phone deposited into may have left the registry: its record still knows its terms.
  const context = (host: string, station: string): StationContext | undefined => {
    const known = regContext(host, station);
    if (known) return known;
    const r = stored.find((d) => d.hostKey === host && d.stationId === station);
    return r && { asset: r.asset, token: r.token, fichaSecs: r.terms.fichaSecs, unitSecs: r.terms.unitSecs, maxFichas: r.terms.maxFichas, graceSecs: r.terms.graceSecs };
  };

  // The stations to read, per escrow: the registry's custody stations and those of the records.
  const byEscrow = new Map<string, Map<string, { host: string; station: string }>>();
  const add = (escrow: string, host: string, station: string) => {
    const m = byEscrow.get(escrow) ?? new Map();
    m.set(`${host}/${station}`, { host, station });
    byEscrow.set(escrow, m);
  };
  for (const s of reg?.stations ?? []) if (isCustody(s)) add(s.escrow, s.host_key, s.id);
  for (const r of stored) add(r.escrow, r.hostKey, r.stationId);

  for (const [escrow, m] of byEscrow) {
    const all = [...m.values()];
    for (let i = 0; i < all.length; i += MAX_EVENT_STATIONS) {
      try {
        const events = await scanStations(server, net, escrow, all.slice(i, i + MAX_EVENT_STATIONS));
        for (const k of applyEvents(records, events, { network: net.id, escrow, payer }, context)) changed.add(k);
      } catch {
        /* the RPC is down: keep what the phone has */
      }
    }
  }

  // Open or gone: session() for what no settle event closed, and again for what one earlier read missed.
  const open = [...records.values()].filter(maybeOpen);
  try {
    const live = await readSessions(
      server,
      open.map((r) => ({ escrow: r.escrow, host: r.hostKey, station: r.stationId, session: r.session, anchor: fromB64url(r.anchor) })),
    );
    open.forEach((r, i) => {
      const s = live.sessions.get(i);
      const key = depositKey(r);
      if (s && s.payer === payer && toB64url(s.anchor) === r.anchor) {
        // Open: the contract's totals and frozen terms are what a claim splits.
        const next = withSession(r.settled ? reopened(r) : r, s);
        if (next !== r) {
          records.set(key, next);
          changed.add(key);
        }
      } else if (ledgerWasReset(r.ledger, live.latestLedger)) {
        // The network was reset since its first deposit (testnet): the session is gone with the old ledger,
        // and so is its claim. "unknown" would keep it open in History, with a claim link, for months.
        records.set(key, { ...r, settled: { how: "reset" } });
        changed.add(key);
      } else if (!r.settled && (r.ledger === undefined || live.latestLedger >= r.ledger)) {
        // Gone, read at or after the first deposit's ledger: settled, how unknown until an event says.
        // A node still behind that ledger proves nothing yet.
        records.set(key, { ...r, settled: { how: "unknown" } });
        changed.add(key);
      }
    });
  } catch {
    /* unknown for now */
  }

  for (const k of changed) await saveDeposit(records.get(k)!);
  return [...records.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** The settle event of one session, looked up from its first deposit's ledger (or the RPC's oldest). */
export async function findSettle(server: Rpc, r: DepositRecord): Promise<SettleEvent | undefined> {
  let scan;
  try {
    scan = await fetchEscrowEvents(server, r.escrow, [{ host: r.hostKey, station: r.stationId }], r.ledger ? { startLedger: r.ledger } : {});
  } catch {
    // The first deposit is older than the RPC's window.
    scan = await fetchEscrowEvents(server, r.escrow, [{ host: r.hostKey, station: r.stationId }], {});
  }
  const hits = scan.events.filter(
    (e): e is SettleEvent => e.kind === "settle" && e.session === r.session && e.payer === r.payer && toB64url(e.anchor) === r.anchor,
  );
  return hits[hits.length - 1];
}
