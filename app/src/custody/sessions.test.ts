/**
 * The payer's custody sessions and receipts, offline: History from the
 * phone's records, the escrow's events and session(); a v2 receipt checked
 * against the wallet's own deposit (the receipt_v2 vector), with a fake RPC.
 */
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Address, Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORKS } from "@/config";
import { parseReceipt, receiptToQuery } from "@/pay/receipt";
import type { StoredReceipt } from "@/pay/receipts-store";
import type { Registry } from "@/registry/verify";
import { fromB64url, toB64url } from "./chain";
import { CLAIM_WINDOW_SECONDS, LEDGER_RESET_MARGIN, TOPUP_MARGIN_SECONDS, ledgerWasReset, planDeposit, sessionOver, staleSession } from "./check";
import { findDeposit, getDeposit, saveDeposit, type DepositRecord } from "./deposits-store";
import { instanceKey, mergeEvents, parseEscrowEvent, sessionKey, sym, type EscrowEvent, type EscrowSession, type Rpc } from "./escrow";
import { checkCustodyReceipt, claimHref, depositAssetCode, receiptConfirmed, receiptFacts, receiptLeadsTo, refundWindow } from "./receipt";
import { applyEvents, forgetEventScans, loadCustodySessions, maybeOpen, scanStations } from "./sessions";

const NET = NETWORKS.testnet;
const C = NET.custody!;
const ESCROW = C.escrowContract;
const HOST = "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6";
const V = JSON.parse(readFileSync(fileURLToPath(new URL("../../../contracts/escrow/test-vectors.json", import.meta.url)), "utf8")) as {
  chains: { anchor_b64url: string; anchor_hex: string }[];
  receipt_v2: { link: string };
};
const F = JSON.parse(readFileSync(fileURLToPath(new URL("./testnet-fixtures.json", import.meta.url)), "utf8")) as { events: rpc.Api.RawGetEventsResponse };

const REG: Registry = {
  format: "ficha-registry/1",
  issued_at: "2026-10-01T00:00:00Z",
  network: "testnet",
  stations: [
    {
      id: "ERZGCG", name: "Demo bench (testnet)", host_key: HOST, asset: { code: "XLM", issuer: null }, ficha_price: "1", ficha_minutes: 5,
      max_session_minutes: 60, active: true, mode: "custody", escrow: ESCROW, unit_seconds: 30, grace_seconds: 1680,
    },
  ],
};

/** The receipt_v2 vector's session (chain 0, 2 fichas of 1 XLM), deposited by `payer`. */
function record(payer: string, over: Partial<DepositRecord> = {}): DepositRecord {
  return {
    network: "testnet", escrow: ESCROW, payer, hostKey: HOST, stationId: "ERZGCG", session: "F3H9TXAB", anchor: V.chains[0].anchor_b64url,
    asset: { code: "XLM", issuer: null }, token: C.xlmSac,
    terms: { price: "10000000", fichaSecs: 300, unitSecs: 30, maxFichas: 12, graceSecs: 1680, chainLen: 120 },
    fichas: 2, amount: "20000000", deadline: 1_790_002_280, txHashes: ["aa"], ledger: 100, createdAt: 1_790_000_000_000, ...over,
  };
}

function session(payer: string, over: Partial<EscrowSession> = {}): EscrowSession {
  return {
    payer, token: C.xlmSac, price: 10_000_000n, fichaSecs: 300, unitSecs: 30, maxFichas: 12, graceSecs: 1680, chainLen: 120,
    anchor: hexToBytes(V.chains[0].anchor_hex), fichas: 2, amount: 20_000_000n, opened: 1_790_000_000, deadline: 1_790_002_280, ...over,
  };
}

/** A Session map as the contract stores it (Symbol keys, sorted). */
function sessionVal(s: EscrowSession): xdr.ScVal {
  const e = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: sym(k), val: v });
  return xdr.ScVal.scvMap([
    e("amount", nativeToScVal(s.amount, { type: "i128" })),
    e("anchor", xdr.ScVal.scvBytes(s.anchor)),
    e("chain_len", nativeToScVal(s.chainLen, { type: "u32" })),
    e("deadline", nativeToScVal(BigInt(s.deadline), { type: "u64" })),
    e("ficha_secs", nativeToScVal(s.fichaSecs, { type: "u32" })),
    e("fichas", nativeToScVal(s.fichas, { type: "u32" })),
    e("grace_secs", nativeToScVal(BigInt(s.graceSecs), { type: "u64" })),
    e("max_fichas", nativeToScVal(s.maxFichas, { type: "u32" })),
    e("opened", nativeToScVal(BigInt(s.opened), { type: "u64" })),
    e("payer", new Address(s.payer).toScVal()),
    e("price", nativeToScVal(s.price, { type: "i128" })),
    e("token", new Address(s.token).toScVal()),
    e("unit_secs", nativeToScVal(s.unitSecs, { type: "u32" })),
  ]);
}

function entry(key: xdr.LedgerKey, val: xdr.ScVal): rpc.Api.LedgerEntryResult {
  if (key.type !== "contractData") throw new Error();
  const k = key.contractData;
  return {
    key,
    val: xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({ ext: xdr.ExtensionPoint.v0(), contract: k.contract, key: k.key, durability: k.durability, val })),
    liveUntilLedgerSeq: 10_000_000,
  };
}

/**
 * A fake RPC whose ledger holds the escrow's code and, maybe, open sessions;
 * and some events. `latestLedger` is the node's; `closeTime` the latest
 * ledger's close time (unix seconds), or "down" for an RPC that cannot say.
 */
function ledger(
  open: Map<string, EscrowSession>,
  events: rpc.Api.RawGetEventsResponse["events"] = [],
  opts: { latestLedger?: number; closeTime?: number | "down" } = {},
): Rpc {
  const latestLedger = opts.latestLedger ?? 5000;
  const instance = xdr.ScVal.scvContractInstance(
    new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(hexToBytes(C.escrowWasm[0])), storage: null }),
  );
  return {
    getHealth: vi.fn(async () => ({ status: "healthy", latestLedger: 5000, oldestLedger: 10, ledgerRetentionWindow: 120_960 })),
    getEvents: vi.fn(async () => rpc.parseRawEvents({ ...F.events, events, cursor: `${(5000n << 32n).toString()}-4294967295`, latestLedger: 5000 })),
    getLedgerEntries: vi.fn(async (...keys: xdr.LedgerKey[]) => {
      const out: rpc.Api.LedgerEntryResult[] = [];
      for (const k of keys) {
        const b64 = k.toXdr("base64");
        if (b64 === instanceKey(ESCROW).toXdr("base64")) out.push(entry(k, instance));
        // A session is its ID and its anchor.
        for (const [id, s] of open) if (b64 === sessionKey(ESCROW, HOST, "ERZGCG", id, s.anchor).toXdr("base64")) out.push(entry(k, sessionVal(s)));
      }
      return { entries: out, latestLedger };
    }),
    getLatestLedger: vi.fn(async () => {
      if (opts.closeTime === "down" || opts.closeTime === undefined) throw new Error("RPC down");
      return { id: "x", sequence: latestLedger, protocolVersion: "23", closeTime: String(opts.closeTime) };
    }),
  } as unknown as Rpc;
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => forgetEventScans());

describe("custody History", () => {
  it("lists a deposit kept on the phone as open while session() has it, settled once it is gone", async () => {
    const payer = Keypair.random().publicKey();
    await saveDeposit(record(payer));
    let rows = await loadCustodySessions(ledger(new Map([["F3H9TXAB", session(payer)]])), NET, payer, REG);
    expect(rows).toHaveLength(1);
    expect(rows[0].settled).toBeUndefined();
    // A top-up made elsewhere shows in the contract's totals.
    rows = await loadCustodySessions(ledger(new Map([["F3H9TXAB", session(payer, { fichas: 3, amount: 30_000_000n, deadline: 1_790_002_580 })]])), NET, payer, REG);
    expect(rows[0]).toMatchObject({ fichas: 3, amount: "30000000", deadline: 1_790_002_580 });
    // No session and no settle event within reach: settled, how unknown; kept so.
    rows = await loadCustodySessions(ledger(new Map()), NET, payer, REG);
    expect(rows[0].settled).toEqual({ how: "unknown" });
    expect((await getDeposit(rows[0]))?.settled).toEqual({ how: "unknown" });
  });

  it("finds deposits made on another phone in the events, with their settles, and skips other payers", () => {
    // The e2e run's payer, on TESTE2 (1-minute fichas of 0.1 XLM, 15 s units).
    const payer = "GDLJHYZMJRAHRTMN5JHBKIP3NH3QK73V2PIUAOX3P3RDZW6L4MVAC5RN";
    const records = new Map<string, DepositRecord>();
    const parsed = rpc.parseRawEvents(F.events).events.map(parseEscrowEvent).filter((e) => e !== null);
    const ctx = { asset: { code: "XLM", issuer: null }, token: C.xlmSac, fichaSecs: 60, unitSecs: 15, maxFichas: 4, graceSecs: 300 };
    const changed = applyEvents(records, parsed, { network: "testnet", escrow: ESCROW, payer }, () => ctx);
    expect(changed.size).toBe(4);
    const bySession = Object.fromEntries([...records.values()].map((r) => [r.session, r]));
    expect(bySession.F2E2E2EA).toMatchObject({ fichas: 2, amount: "2000000", terms: { price: "1000000", chainLen: 16 }, settled: { how: "proof", toPayer: "750000", toHost: "1250000", unusedUnits: 3 } });
    expect(bySession.F2E2E2EB.settled).toMatchObject({ how: "deadline", toPayer: "0", toHost: "1000000" });
    expect(bySession.F2E2E2EC.settled).toMatchObject({ how: "host", toPayer: "1000000" });
    // F2E2E2ED: another wallet paid the same ID first with its own anchor; this payer's session is its own.
    expect(bySession.F2E2E2ED).toMatchObject({ fichas: 1, anchor: bySession.F2E2E2EA.anchor, settled: { how: "proof", toPayer: "500000", toHost: "500000", unusedUnits: 2 } });
    // A settle under the same ID with another anchor is another session: it closes nothing here.
    const dKey = [...records.keys()].find((k) => k.includes("|F2E2E2ED|"))!;
    const openD = () => new Map([[dKey, { ...records.get(dKey)!, settled: undefined }]]);
    const settleD = parsed.find((e) => e.kind === "settle" && e.session === "F2E2E2ED" && e.payer === payer)!;
    expect(applyEvents(openD(), [{ ...settleD, anchor: new Uint8Array(32) }], { network: "testnet", escrow: ESCROW, payer }, () => ctx).size).toBe(0);
    expect(applyEvents(openD(), [settleD], { network: "testnet", escrow: ESCROW, payer }, () => ctx).size).toBe(1);
    // A session the phone already saw settle stays settled when its deposit comes again with a scan.
    const key = [...records.keys()].find((k) => k.includes("|F2E2E2EA|"))!;
    const settleA = parsed.find((e) => e.kind === "settle" && e.session === "F2E2E2EA")!;
    const settledHere = new Map([[key, { ...records.get(key)!, txHashes: [], settled: { how: "proof" as const, at: settleA.at } }]]);
    expect(applyEvents(settledHere, parsed.filter((e) => e.session === "F2E2E2EA"), { network: "testnet", escrow: ESCROW, payer }, () => ctx).size).toBe(0);
    // A first deposit after the settle is a new session under the same ID (a stale QR).
    const later = { ...parsed[0], at: new Date(Date.parse(settleA.at) + 3_600_000).toISOString(), txHash: "ff" };
    expect(applyEvents(settledHere, [later], { network: "testnet", escrow: ESCROW, payer }, () => ctx).size).toBe(1);
    expect(settledHere.get(key)).toMatchObject({ txHashes: ["ff"] });
    expect(settledHere.get(key)!.settled).toBeUndefined();
    // Another payer's events change nothing.
    expect(applyEvents(new Map(), parsed, { network: "testnet", escrow: ESCROW, payer: HOST }, () => ctx).size).toBe(0);
  });
});

describe("custody receipt (contract §7.6)", () => {
  const r = parseReceipt(V.receipt_v2.link);

  it("confirms the vector receipt against this wallet's deposit and splits as the contract will", async () => {
    const payer = Keypair.random().publicKey();
    await saveDeposit(record(payer));
    const c = await checkCustodyReceipt(ledger(new Map([["F3H9TXAB", session(payer)]])), NET, r, payer, REG, 1_790_001_000);
    expect(c.state).toBe("open");
    if (c.state !== "open") throw new Error();
    // 2 fichas of 300 s at 30 s = 20 units, 7 unused: ceil(2 XLM x 7 / 20) back.
    expect(c.facts).toMatchObject({ matches: true, units: 7, expectedUnits: 7, paidUnits: 20, toPayer: 7_000_000n, toHost: 13_000_000n });
  });

  it("refuses a proof that does not lead to this wallet's anchor, whatever the receipt says", async () => {
    const payer = Keypair.random().publicKey();
    await saveDeposit(record(payer, { anchor: V.chains[1].anchor_b64url }));
    const c = await checkCustodyReceipt(ledger(new Map()), NET, r, payer, REG, 1_790_001_000);
    expect(c.state).toBe("bad_proof");
  });

  it("says when the deadline passed, or the session settled", async () => {
    const payer = Keypair.random().publicKey();
    await saveDeposit(record(payer));
    const open = ledger(new Map([["F3H9TXAB", session(payer)]]));
    expect((await checkCustodyReceipt(open, NET, r, payer, REG, 1_790_002_280)).state).toBe("open"); // claim works at the deadline
    expect((await checkCustodyReceipt(open, NET, r, payer, REG, 1_790_002_281)).state).toBe("expired");
    const gone = await checkCustodyReceipt(ledger(new Map()), NET, r, payer, REG, 1_790_001_000);
    expect(gone).toMatchObject({ state: "settled", record: { settled: { how: "unknown" } } });
  });

  it("is not this wallet's without a deposit; finds an open one on the ledger the phone lost", async () => {
    const payer = Keypair.random().publicKey();
    expect(await checkCustodyReceipt(ledger(new Map([["F3H9TXAB", session(HOST)]])), NET, r, payer, REG)).toEqual({ state: "not_mine", reason: "noDeposit" });
    expect(await checkCustodyReceipt(ledger(new Map()), NET, r, null, REG)).toEqual({ state: "not_mine", reason: "noWallet" });
    expect(await checkCustodyReceipt(ledger(new Map()), NETWORKS.public, r, payer, REG)).toEqual({ state: "not_mine", reason: "otherNetwork" });
    const c = await checkCustodyReceipt(ledger(new Map([["F3H9TXAB", session(payer)]])), NET, r, payer, REG, 1_790_001_000);
    expect(c.state).toBe("open");
    expect(await findDeposit("testnet", payer, HOST, "ERZGCG", "F3H9TXAB", V.chains[0].anchor_b64url)).toMatchObject({ fichas: 2, amount: "20000000", anchor: V.chains[0].anchor_b64url });
  });

  it("flags a q the receipt's times do not give (but not a full refund), and an amount that is not the deposit's", () => {
    const payer = Keypair.random().publicKey();
    const odd = parseReceipt(V.receipt_v2.link.replace("u=400", "u=500"));
    expect(receiptFacts(odd, record(payer))).toMatchObject({ units: 7, expectedUnits: 4, unitsOk: false, matches: true });
    expect(receiptFacts(r, record(payer)).unitsOk).toBe(true);
    // A session the station could not serve: the whole chain, q = N with u = 0, is no station error (§7.5).
    const full = parseReceipt(V.receipt_v2.link.replace("u=400", "u=0").replace("q=7", "q=120"));
    expect(receiptFacts(full, record(payer))).toMatchObject({ units: 120, expectedUnits: 20, unitsOk: true, toPayer: 20_000_000n, toHost: 0n });
    expect(receiptFacts(parseReceipt(V.receipt_v2.link.replace("q=7", "q=120")), record(payer)).unitsOk).toBe(false);
    expect(receiptFacts(parseReceipt(V.receipt_v2.link.replace("a=2", "a=3")), record(payer)).matches).toBe(false);
    expect(receiptFacts(r, record(payer, { fichas: 3, amount: "30000000" })).matches).toBe(false);
  });
});

describe("custody History, one read at a time", () => {
  it("keeps each event once, however many loads read it again (a resumed scan may repeat events)", async () => {
    const server = ledger(new Map(), F.events.events);
    const stations = [{ host: HOST, station: "ERZGCG" }];
    const first = await scanStations(server, NET, ESCROW, stations);
    expect(first.length).toBeGreaterThan(0);
    const again = await scanStations(server, NET, ESCROW, stations);
    expect(again.map((e) => e.id)).toEqual(first.map((e) => e.id));
    expect(mergeEvents([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }, { id: "c" }])).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
  });

  it("does not settle a deposit an RPC node behind its ledger cannot see yet, and reopens one a later read finds", async () => {
    const payer = Keypair.random().publicKey();
    // Just paid at ledger 5000; the node that answers History is at 4998.
    await saveDeposit(record(payer, { ledger: 5000 }));
    let rows = await loadCustodySessions(ledger(new Map(), [], { latestLedger: 4998 }), NET, payer, REG);
    expect(rows[0].settled).toBeUndefined();
    // A node at or past that ledger without the session: settled, how unknown.
    rows = await loadCustodySessions(ledger(new Map(), [], { latestLedger: 5000 }), NET, payer, REG);
    expect(rows[0].settled).toEqual({ how: "unknown" });
    // "Unknown" is read again: open after all (and topped up meanwhile), it is open, with the contract's totals.
    rows = await loadCustodySessions(ledger(new Map([["F3H9TXAB", session(payer, { fichas: 3, amount: 30_000_000n, deadline: 1_790_002_580 })]]), [], { latestLedger: 5010 }), NET, payer, REG);
    expect(rows[0].settled).toBeUndefined();
    expect(rows[0]).toMatchObject({ fichas: 3, amount: "30000000", deadline: 1_790_002_580 });
    expect((await getDeposit(rows[0]))?.settled).toBeUndefined();
  });

  it("takes the session's frozen terms from the contract, not the phone's copy", async () => {
    const payer = Keypair.random().publicKey();
    // The phone kept terms the registry says now (60 s units); the contract froze 30 s units, 120 links.
    await saveDeposit(record(payer, { terms: { price: "10000000", fichaSecs: 300, unitSecs: 60, maxFichas: 12, graceSecs: 1680, chainLen: 60 } }));
    const open = ledger(new Map([["F3H9TXAB", session(payer)]]), [], { closeTime: 1_790_001_000 });
    const rows = await loadCustodySessions(open, NET, payer, REG);
    expect(rows[0].terms).toEqual({ price: "10000000", fichaSecs: 300, unitSecs: 30, maxFichas: 12, graceSecs: 1680, chainLen: 120 });
  });
});

describe("custody receipt, by the contract's own clock and terms", () => {
  const r = parseReceipt(V.receipt_v2.link);
  const DEADLINE = 1_790_002_280;

  it("decides the deadline on the ledger's time, never the phone's clock", async () => {
    const payer = Keypair.random().publicKey();
    await saveDeposit(record(payer));
    // The phone's clock runs two minutes past the deadline; the ledger is a minute before it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((DEADLINE + 120) * 1000);
    const open = (closeTime: number | "down") => ledger(new Map([["F3H9TXAB", session(payer)]]), [], { closeTime });
    expect((await checkCustodyReceipt(open(DEADLINE - 60), NET, r, payer, REG)).state).toBe("open");
    expect((await checkCustodyReceipt(open(DEADLINE + 1), NET, r, payer, REG)).state).toBe("expired");
    // No ledger time: the claim is offered, and its simulation decides (Expired).
    expect((await checkCustodyReceipt(open("down"), NET, r, payer, REG)).state).toBe("open");
    // A top-up likewise: refused as expired only by the ledger's time.
    const link = { anchor: hexToBytes(V.chains[0].anchor_hex) };
    const terms = { token: C.xlmSac, price: 10_000_000n, fichaSecs: 300, maxFichas: 12, unitSecs: 30, graceSecs: 1680, active: true };
    expect(planDeposit(session(payer), payer, link, terms, null).kind).toBe("topup");
    expect(planDeposit(session(payer), payer, link, terms, DEADLINE + 1).kind).toBe("expired");
  });

  it("splits by the terms the contract froze, and saves them", async () => {
    const payer = Keypair.random().publicKey();
    await saveDeposit(record(payer, { terms: { price: "10000000", fichaSecs: 300, unitSecs: 60, maxFichas: 12, graceSecs: 1680, chainLen: 60 } }));
    const c = await checkCustodyReceipt(ledger(new Map([["F3H9TXAB", session(payer)]])), NET, r, payer, REG, 1_790_001_000);
    expect(c.state).toBe("open");
    if (c.state !== "open") throw new Error();
    // 20 paid units of 30 s, 7 unused: ceil(2 XLM x 7 / 20) = 0.7 XLM, as the claim transfers.
    expect(c.facts).toMatchObject({ paidUnits: 20, unitsOk: true, toPayer: 7_000_000n, toHost: 13_000_000n });
    expect((await findDeposit("testnet", payer, HOST, "ERZGCG", "F3H9TXAB", V.chains[0].anchor_b64url))?.terms).toMatchObject({ unitSecs: 30, chainLen: 120 });
  });

  it("never lets a receipt with a smaller refund, made from public data, replace or confirm over the real one", async () => {
    const payer = Keypair.random().publicKey();
    await saveDeposit(record(payer));
    const open = ledger(new Map([["F3H9TXAB", session(payer)]]));
    const z = r.refund!.proof;
    // q = 6: the real proof hashed once more, which anyone holding the real receipt or the chain can do.
    const lower = parseReceipt(V.receipt_v2.link.replace("q=7", "q=6").replace(`z=${z}`, `z=${toB64url(sha256(fromB64url(z)))}`).replace("u=400", "u=430"));
    // q = 0: the anchor itself, public in the pay QR and the deposit event.
    const zero = parseReceipt(V.receipt_v2.link.replace("q=7", "q=0").replace(`z=${z}`, `z=${V.chains[0].anchor_b64url}`).replace("u=400", "u=600"));

    const real = await checkCustodyReceipt(open, NET, r, payer, REG, 1_790_001_000);
    expect(real.state).toBe("open");
    expect(receiptConfirmed(real)).toBe(true);
    const low = await checkCustodyReceipt(open, NET, lower, payer, REG, 1_790_001_000);
    expect(low.state).toBe("superseded");
    expect(receiptConfirmed(low)).toBe(false);
    if (low.state !== "superseded") throw new Error();
    expect(low.best.refund).toEqual(r.refund);
    const none = await checkCustodyReceipt(open, NET, zero, payer, REG, 1_790_001_000);
    expect(none.state).toBe("superseded");
    expect(receiptConfirmed(none)).toBe(false);
    // The best receipt stays on the record: the claim from History reopens it.
    const kept = await findDeposit("testnet", payer, HOST, "ERZGCG", "F3H9TXAB", V.chains[0].anchor_b64url);
    expect(kept?.bestReceipt?.refund).toEqual(r.refund);

    // On its own (no better receipt read), a q = 0 receipt still confirms nothing.
    const other = Keypair.random().publicKey();
    await saveDeposit(record(other));
    const alone = await checkCustodyReceipt(ledger(new Map([["F3H9TXAB", session(other)]])), NET, zero, other, REG, 1_790_001_000);
    expect(alone.state).toBe("open");
    if (alone.state !== "open") throw new Error();
    expect(alone.facts).toMatchObject({ matches: true, provesNothing: true, toPayer: 0n });
    expect(receiptConfirmed(alone)).toBe(false);
  });

  it("names the deposit's asset on the claim, not the receipt's unsigned k", async () => {
    const payer = Keypair.random().publicKey();
    await saveDeposit(record(payer));
    const usdc = parseReceipt(V.receipt_v2.link.replace("k=XLM", "k=USDC"));
    const c = await checkCustodyReceipt(ledger(new Map([["F3H9TXAB", session(payer)]])), NET, usdc, payer, REG, 1_790_001_000);
    expect(c.state).toBe("open");
    if (c.state !== "open") throw new Error();
    expect(c.facts.matches).toBe(false);
    expect(depositAssetCode(c, usdc)).toBe("XLM");
    expect(depositAssetCode({ state: "not_mine", reason: "noDeposit" }, usdc)).toBe("USDC");
    const screen = readFileSync(fileURLToPath(new URL("../components/CustodyReceipt.tsx", import.meta.url)), "utf8");
    expect(screen).toContain("depositAssetCode(check, r)");
    expect(screen).not.toContain("const code = r.assetCode;");
  });
});

describe("a kept receipt leads back to its claim", () => {
  const r = parseReceipt(V.receipt_v2.link);

  it("writes a receipt back as the query /r reads", () => {
    expect(parseReceipt(receiptToQuery(r))).toEqual(r);
    const v1 = parseReceipt(V.receipt_v2.link.replace("v=2", "v=1").replace(/&q=.*$/, ""));
    expect(parseReceipt(receiptToQuery(v1))).toEqual(v1);
    const tiny = { ...r, wh: 0.0000001 };
    expect(parseReceipt(receiptToQuery(tiny)).wh).toBe(0.0000001);
  });

  it("links History and /p to the best receipt kept, when it gives anything back", () => {
    const stored = (receipt = r, reason?: string): StoredReceipt => ({ receipt, check: reason ? "not_confirmed" : "confirmed", reason, savedAt: 1 });
    expect(claimHref(undefined, stored())).toBe(`/r?${receiptToQuery(r)}`);
    expect(claimHref({ bestReceipt: r }, undefined)).toBe(`/r?${receiptToQuery(r)}`);
    // A stored receipt whose proof did not lead to the deposit is never the claim.
    const forged = parseReceipt(V.receipt_v2.link.replace("q=7", "q=9"));
    expect(claimHref({ bestReceipt: r }, stored(forged, "badProof"))).toBe(`/r?${receiptToQuery(r)}`);
    // Nothing to claim with q = 0, nor from a direct (v1) receipt.
    const zero = parseReceipt(V.receipt_v2.link.replace("q=7", "q=0"));
    expect(claimHref({ bestReceipt: zero }, undefined)).toBeNull();
    expect(claimHref(undefined, stored(parseReceipt(V.receipt_v2.link.replace("v=2", "v=1").replace(/&q=.*$/, ""))))).toBeNull();
  });

  it("says 'deadline passed' in History once the deadline is behind, not 'refund until'", () => {
    expect(refundWindow({ deadline: 1000 }, 999)).toBe("open");
    expect(refundWindow({ deadline: 1000 }, 1001)).toBe("past");
    expect(refundWindow({ deadline: 1000, settled: { how: "proof" } }, 10)).toBe("settled");
    const list = readFileSync(fileURLToPath(new URL("../components/SessionList.tsx", import.meta.url)), "utf8");
    expect(list).toContain('t("h.past"');
    expect(list).toContain("claimHref(d, stored)");
  });
});

describe("a pay link for a session that is over (contract §7.4 step 4)", () => {
  const anchor = hexToBytes(V.chains[0].anchor_hex);
  const link = { session: "F3H9TXAB", anchor };
  const parsed = rpc.parseRawEvents(F.events).events.map(parseEscrowEvent).filter((e): e is EscrowEvent => e !== null);

  it("is stale once anyone paid that session (its ID and anchor), whoever settled it", () => {
    const deposit = parsed.find((e) => e.kind === "deposit")!;
    const settle = parsed.find((e) => e.kind === "settle")!;
    const here = (e: EscrowEvent): EscrowEvent => ({ ...e, session: "F3H9TXAB", anchor });
    expect(staleSession([], link)).toBe(false);
    expect(staleSession([here(deposit)], link)).toBe(true);
    // The deposit older than the RPC's window, its settle within it.
    expect(staleSession([here(settle)], link)).toBe(true);
    // Another anchor under the same ID is another session (a squatter's): the station's own is still unpaid.
    expect(staleSession([{ ...here(deposit), anchor: new Uint8Array(32) }], link)).toBe(false);
    expect(staleSession([{ ...here(deposit), session: "F2E2E2EA" }], link)).toBe(false);
  });

  it("is this wallet's own session over, unless an RPC node behind it, or a guess the contract contradicts", () => {
    const me = Keypair.random().publicKey();
    const mine = record(me, { ledger: 5000 });
    const none = { session: null, latestLedger: 5000 };
    expect(sessionOver({ receipt: false }, none, me)).toBeNull();
    expect(sessionOver({ receipt: true }, none, me)).toBe("over");
    expect(sessionOver({ record: mine, receipt: false }, none, me)).toBe("over");
    expect(sessionOver({ record: mine, receipt: false }, { session: null, latestLedger: 4999 }, me)).toBe("lagging");
    const open = { session: session(me), latestLedger: 5000 };
    expect(sessionOver({ record: mine, receipt: false }, open, me)).toBeNull();
    expect(sessionOver({ record: { ...mine, settled: { how: "unknown" } }, receipt: false }, open, me)).toBeNull();
    expect(sessionOver({ record: { ...mine, settled: { how: "proof" } }, receipt: false }, open, me)).toBe("over");
  });

  it("checks the session's history before a new deposit, and offers the claim on a session that is over", () => {
    const page = readFileSync(fileURLToPath(new URL("../routes/p.tsx", import.meta.url)), "utf8");
    expect(page).toContain("staleSession(events, link)");
    expect(page).toContain('t("p.stale")');
    expect(page).toContain("claimHref(record, local.receipt)");
    expect(page).toContain("planDeposit(view.session, publicKey, link, cc.terms, chain.now)");
  });
});

describe("a top-up the station would never serve (review R2A3, round 2)", () => {
  it("is refused once the station's claim window before the deadline has begun, not only past the deadline", () => {
    const me = Keypair.random().publicKey();
    const s = session(me);
    const link = { anchor: hexToBytes(V.chains[0].anchor_hex) };
    const terms = { token: C.xlmSac, price: 10_000_000n, fichaSecs: 300, maxFichas: 12, unitSecs: 30, graceSecs: 1680, active: true };
    const end = s.deadline - CLAIM_WINDOW_SECONDS;
    expect(CLAIM_WINDOW_SECONDS).toBe(900);
    expect(planDeposit(s, me, link, terms, end - TOPUP_MARGIN_SECONDS - 1).kind).toBe("topup");
    expect(planDeposit(s, me, link, terms, end - TOPUP_MARGIN_SECONDS).kind).toBe("ended");
    expect(planDeposit(s, me, link, terms, s.deadline - 600).kind).toBe("ended");
    expect(planDeposit(s, me, link, terms, s.deadline).kind).toBe("ended");
    expect(planDeposit(s, me, link, terms, s.deadline + 1).kind).toBe("expired");
    // No ledger time: offered, and the station's own rule is what stops it.
    expect(planDeposit(s, me, link, terms, null).kind).toBe("topup");
    const page = readFileSync(fileURLToPath(new URL("../routes/p.tsx", import.meta.url)), "utf8");
    expect(page).toContain('if (plan.kind === "ended") return <BlockedAndScan text={t("p.closing"');
  });
});

describe("a crafted receipt for a session's public ID (review R2A5, round 2)", () => {
  const real = parseReceipt(V.receipt_v2.link);
  const anchor = hexToBytes(V.chains[0].anchor_hex);
  const z = real.refund!.proof;

  it("does not end a running session on this phone: only a receipt whose proof leads to the link's anchor counts", () => {
    const me = Keypair.random().publicKey();
    const open = { session: session(me), latestLedger: 5000 };
    // q = 5 with a random proof (the memo is public in the pay QR): leads nowhere, so top-ups stay open.
    const forged = parseReceipt(V.receipt_v2.link.replace("q=7", "q=5").replace(`z=${z}`, `z=${toB64url(new Uint8Array(32).fill(3))}`));
    expect(receiptLeadsTo(forged, anchor)).toBe(false);
    expect(sessionOver({ record: record(me, { ledger: 5000 }), receipt: receiptLeadsTo(forged, anchor) }, open, me)).toBeNull();
    // The station's own receipt leads to the anchor: the session is over.
    expect(receiptLeadsTo(real, anchor)).toBe(true);
    expect(receiptLeadsTo(real, hexToBytes(V.chains[1].anchor_hex))).toBe(false);
    // q = 0 is the anchor itself: it leads there, and still counts (a genuine receipt may give nothing back).
    const zero = parseReceipt(V.receipt_v2.link.replace("q=7", "q=0").replace(`z=${z}`, `z=${V.chains[0].anchor_b64url}`));
    expect(receiptLeadsTo(zero, anchor)).toBe(true);
    // A direct-mode (v1) receipt is never a custody session's.
    expect(receiptLeadsTo(parseReceipt(V.receipt_v2.link.replace("v=2", "v=1").replace(/&q=.*$/, "")), anchor)).toBe(false);
    const page = readFileSync(fileURLToPath(new URL("../routes/p.tsx", import.meta.url)), "utf8");
    expect(page).toContain("receipt: local.receipt !== undefined && receiptLeadsTo(local.receipt.receipt, link.anchor)");
  });
});

describe("after a testnet reset (review R2A3, round 2)", () => {
  const r = parseReceipt(V.receipt_v2.link);

  it("settles a pre-reset deposit as 'reset' (no claim), instead of keeping it open for months", async () => {
    const payer = Keypair.random().publicKey();
    // Paid at ledger 4 980 000; the network started over from 1 and is at 500.
    await saveDeposit(record(payer, { ledger: 4_980_000, bestReceipt: r }));
    const rows = await loadCustodySessions(ledger(new Map(), [], { latestLedger: 500 }), NET, payer, REG);
    expect(rows[0].settled).toEqual({ how: "reset" });
    expect(maybeOpen(rows[0])).toBe(false);
    // History offers a claim only while the session may be open.
    const list = readFileSync(fileURLToPath(new URL("../components/SessionList.tsx", import.meta.url)), "utf8");
    expect(list).toContain("const href = maybeOpen(d) ? claimHref(d, stored) : null;");
    expect(list).toContain('s.how === "reset" ? "h.reset"');
    // Already "unknown" before the reset was seen: reset too.
    const other = Keypair.random().publicKey();
    await saveDeposit(record(other, { ledger: 4_980_000, settled: { how: "unknown" } }));
    expect((await loadCustodySessions(ledger(new Map(), [], { latestLedger: 500 }), NET, other, REG))[0].settled).toEqual({ how: "reset" });
  });

  it("still waits for an RPC node only behind (by less than the margin), and says 'over' on /p after a reset", async () => {
    const payer = Keypair.random().publicKey();
    await saveDeposit(record(payer, { ledger: 5000 }));
    const behind = await loadCustodySessions(ledger(new Map(), [], { latestLedger: 5000 - LEDGER_RESET_MARGIN }), NET, payer, REG);
    expect(behind[0].settled).toBeUndefined();
    expect(ledgerWasReset(5000, 5000 - LEDGER_RESET_MARGIN)).toBe(false);
    expect(ledgerWasReset(5000, 5000 - LEDGER_RESET_MARGIN - 1)).toBe(true);
    expect(ledgerWasReset(undefined, 1)).toBe(false);
    const me = Keypair.random().publicKey();
    expect(sessionOver({ record: record(me, { ledger: 4_980_000 }), receipt: false }, { session: null, latestLedger: 500 }, me)).toBe("over");
    expect(sessionOver({ record: record(me, { ledger: 5000 }), receipt: false }, { session: null, latestLedger: 4500 }, me)).toBe("lagging");
  });

  it("shows a receipt for a pre-reset deposit as settled by the reset", async () => {
    const payer = Keypair.random().publicKey();
    await saveDeposit(record(payer, { ledger: 4_980_000 }));
    const c = await checkCustodyReceipt(ledger(new Map(), [], { latestLedger: 500 }), NET, r, payer, REG, 1_790_001_000);
    expect(c).toMatchObject({ state: "settled", record: { settled: { how: "reset" } } });
  });
});

describe("a full refund under changed terms (review R2A4, round 2)", () => {
  it("is no station error when q is the station's own N (not the session's), with nothing used", () => {
    const payer = Keypair.random().publicKey();
    // The session froze 30 s units, 10 fichas of 60 s (N = 20); the running station still has 15 s units (N = 40).
    const rec = record(payer, { terms: { price: "10000000", fichaSecs: 60, unitSecs: 30, maxFichas: 10, graceSecs: 1680, chainLen: 20 } });
    const station = (q: number, u = 0) => parseReceipt(V.receipt_v2.link.replace("p=600", "p=120").replace("u=400", `u=${u}`).replace("q=7", `q=${q}`));
    expect(receiptFacts(station(40), rec)).toMatchObject({ units: 40, paidUnits: 4, expectedUnits: 4, unitsOk: true, toPayer: 20_000_000n, toHost: 0n });
    // The session's own N, and exactly the paid units, are full refunds too.
    expect(receiptFacts(station(20), rec).unitsOk).toBe(true);
    expect(receiptFacts(station(4), rec).unitsOk).toBe(true);
    // Fewer than the paid units with nothing used, more than the contract takes, or time used: station errors.
    expect(receiptFacts(station(3), rec).unitsOk).toBe(false);
    const over = station(40);
    expect(receiptFacts({ ...over, refund: { ...over.refund!, units: 257 } }, rec).unitsOk).toBe(false); // the parser refuses it anyway
    expect(receiptFacts(station(40, 30), rec).unitsOk).toBe(false);
  });
});
