/**
 * The custody deposits this phone made, kept on this phone only (IndexedDB
 * `ficha.deposits.v1`; docs/station-app-contract.md §7.4 step 7), one per
 * session (its ID and its anchor): the session's key on the contract, its
 * anchor, its frozen terms, its totals, its deadline and the deposits'
 * transaction hashes. A receipt's proof is checked against the anchor kept
 * here, never against one a receipt brings.
 * Amounts are stroops as decimal strings.
 */
import { createStore, delMany, entries, get, set, setMany } from "idb-keyval";
import type { AssetRef, NetworkId } from "@/config";
import type { Receipt } from "@/pay/receipt";

export interface DepositRecord {
  network: NetworkId;
  escrow: string;
  payer: string;
  hostKey: string;
  stationId: string;
  /** The bare session ID (F + 7). */
  session: string;
  /** c[N], base64url. */
  anchor: string;
  asset: AssetRef;
  /** The asset's contract (the terms' token). */
  token: string;
  /** The session's terms, frozen at its first deposit. */
  terms: { price: string; fichaSecs: number; unitSecs: number; maxFichas: number; graceSecs: number; chainLen: number };
  /** Totals over the first deposit and its top-ups. */
  fichas: number;
  amount: string;
  /** Ledger unix seconds: claim until then. */
  deadline: number;
  /** The deposits' transaction hashes, first one first. */
  txHashes: string[];
  /** Ledger of the first deposit (where to look for its events). */
  ledger?: number;
  /** When the first deposit was made or seen (ms). */
  createdAt: number;
  /** The session is settled: by the payer's claim, at the deadline, or by the host. */
  settled?: SettledInfo;
  /**
   * The receipt (v2) read for this session whose proof leads to this
   * deposit's anchor with the most unused units: the one a claim reopens
   * from History or /p. A receipt with fewer units can be made from public
   * data (hash its proof forward), so it never replaces this one.
   */
  bestReceipt?: Receipt;
}

export interface SettledInfo {
  /** "reset": the network was reset (testnet) since the deposit; the session is gone with the old ledger. */
  how: "proof" | "deadline" | "host" | "unknown" | "reset";
  /** Stroops; absent when only the session's absence on the ledger is known. */
  toPayer?: string;
  toHost?: string;
  unusedUnits?: number;
  txHash?: string;
  /** ISO time of the ledger, when known. */
  at?: string;
}

let idbStore: ReturnType<typeof createStore> | null = null;
function store() {
  idbStore ??= createStore("ficha.deposits.v1", "deposits");
  return idbStore;
}

type Key = Pick<DepositRecord, "network" | "escrow" | "payer" | "hostKey" | "stationId" | "session" | "anchor">;

/**
 * A record's key: its session on the contract, which is the ID AND the
 * anchor (contract §7.1). Two deposits under one ID with different anchors
 * are two sessions: a pay link with the station's live ID and another chain
 * (a forged QR) opens a session of its own, and its record must never
 * replace the real one, whose receipt then could not be claimed.
 */
export const depositKey = (k: Key) => [k.network, k.escrow, k.payer, k.hostKey, k.stationId, k.session, k.anchor].join("|");

export async function saveDeposit(r: DepositRecord): Promise<void> {
  try {
    await set(depositKey(r), r, store());
  } catch {
    /* no IndexedDB: the chain still has it (History reads the events) */
  }
}

export async function getDeposit(k: Key): Promise<DepositRecord | undefined> {
  try {
    return await get<DepositRecord>(depositKey(k), store());
  } catch {
    return undefined;
  }
}

/**
 * Every record, each under its key. Records kept by earlier versions under
 * the key without the anchor move to their key now (once); should both
 * exist, the one under the new key stays.
 */
async function allDeposits(): Promise<DepositRecord[]> {
  const all = await entries<string, DepositRecord>(store());
  const byKey = new Map<string, DepositRecord>();
  for (const [k, v] of all) if (k === depositKey(v)) byKey.set(k, v);
  const moved: [string, DepositRecord][] = [];
  const old: string[] = [];
  for (const [k, v] of all) {
    const key = depositKey(v);
    if (k === key) continue;
    old.push(k);
    if (byKey.has(key)) continue;
    byKey.set(key, v);
    moved.push([key, v]);
  }
  if (old.length > 0) {
    try {
      await setMany(moved, store());
      await delMany(old, store());
    } catch {
      /* moved again next time */
    }
  }
  return [...byKey.values()];
}

/** This wallet's deposits on a network, any escrow. */
export async function listDeposits(network: NetworkId, payer: string): Promise<DepositRecord[]> {
  try {
    return (await allDeposits()).filter((v) => v.network === network && v.payer === payer);
  } catch {
    return [];
  }
}

/**
 * This wallet's deposits under a station's session ID, on whichever escrow
 * (a receipt does not name the contract), newest first: one per anchor. More
 * than one means a pay link with another chain was paid under the same ID.
 */
export async function findDeposits(network: NetworkId, payer: string, hostKey: string, stationId: string, session: string): Promise<DepositRecord[]> {
  const mine = await listDeposits(network, payer);
  return mine.filter((d) => d.hostKey === hostKey && d.stationId === stationId && d.session === session).sort((a, b) => b.createdAt - a.createdAt);
}

/** The deposit for one session: its ID and its anchor (base64url), on whichever escrow (the newest, should a stale QR have reopened it on another). */
export async function findDeposit(network: NetworkId, payer: string, hostKey: string, stationId: string, session: string, anchor: string): Promise<DepositRecord | undefined> {
  return (await findDeposits(network, payer, hostKey, stationId, session)).find((d) => d.anchor === anchor);
}
