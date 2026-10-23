/**
 * A session is its ID and its anchor, on the phone too (review R2A1, round
 * 2): a pay link with a station's live session ID and another chain (a forged
 * QR) opens a session of its own, and its deposit record must never replace
 * the real one, whose receipt then could not be claimed. Records are keyed by
 * the anchor; records kept under the old key move to the new one.
 */
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Address, Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { hexToBytes } from "@noble/hashes/utils.js";
import { createStore, keys, set } from "idb-keyval";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORKS } from "@/config";
import { parseReceipt } from "@/pay/receipt";
import { receiptFor } from "@/pay/useSessions";
import type { StoredReceipt } from "@/pay/receipts-store";
import type { Registry } from "@/registry/verify";
import { toB64url } from "./chain";
import { depositKey, findDeposit, findDeposits, listDeposits, saveDeposit, type DepositRecord } from "./deposits-store";
import { instanceKey, sessionKey, sym, type DepositEvent, type EscrowSession, type Rpc, type SettleEvent } from "./escrow";
import { checkCustodyReceipt, claimHref } from "./receipt";
import { applyEvents, forgetEventScans, loadCustodySessions } from "./sessions";

const NET = NETWORKS.testnet;
const C = NET.custody!;
const ESCROW = C.escrowContract;
const HOST = "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6";
const V = JSON.parse(readFileSync(fileURLToPath(new URL("../../../contracts/escrow/test-vectors.json", import.meta.url)), "utf8")) as {
  chains: { anchor_b64url: string; anchor_hex: string }[];
  receipt_v2: { link: string };
};
/** The station's real chain (the receipt_v2 vector's), and a forger's under the same session ID. */
const A1 = V.chains[0].anchor_b64url;
const A2 = V.chains[1].anchor_b64url;

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

function record(payer: string, anchor: string, over: Partial<DepositRecord> = {}): DepositRecord {
  return {
    network: "testnet", escrow: ESCROW, payer, hostKey: HOST, stationId: "ERZGCG", session: "F3H9TXAB", anchor,
    asset: { code: "XLM", issuer: null }, token: C.xlmSac,
    terms: { price: "10000000", fichaSecs: 300, unitSecs: 30, maxFichas: 12, graceSecs: 1680, chainLen: 120 },
    fichas: 2, amount: "20000000", deadline: 1_790_002_280, txHashes: ["aa"], ledger: 100, createdAt: 1_790_000_000_000, ...over,
  };
}

function session(payer: string, anchorHex: string, over: Partial<EscrowSession> = {}): EscrowSession {
  return {
    payer, token: C.xlmSac, price: 10_000_000n, fichaSecs: 300, unitSecs: 30, maxFichas: 12, graceSecs: 1680, chainLen: 120,
    anchor: hexToBytes(anchorHex), fichas: 2, amount: 20_000_000n, opened: 1_790_000_000, deadline: 1_790_002_280, ...over,
  };
}

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

/** A ledger with the escrow's code and these open sessions (several may share an ID: a session is its ID and its anchor). */
function ledger(open: EscrowSession[], latestLedger = 5000): Rpc {
  const data = new Map<string, xdr.ScVal>([
    [
      instanceKey(ESCROW).toXdr("base64"),
      xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(hexToBytes(C.escrowWasm[0])), storage: null })),
    ],
  ]);
  for (const s of open) data.set(sessionKey(ESCROW, HOST, "ERZGCG", "F3H9TXAB", s.anchor).toXdr("base64"), sessionVal(s));
  return {
    getHealth: vi.fn(async () => ({ status: "healthy", latestLedger, oldestLedger: 10, ledgerRetentionWindow: 120_960 })),
    getEvents: vi.fn(async () => ({ events: [], cursor: `${(BigInt(latestLedger) << 32n).toString()}-4294967295`, latestLedger, oldestLedger: 10 })),
    getLatestLedger: vi.fn(async () => ({ id: "x", sequence: latestLedger, protocolVersion: "23", closeTime: "1790001000" })),
    getLedgerEntries: vi.fn(async (...ks: xdr.LedgerKey[]) => ({
      latestLedger,
      entries: ks
        .filter((k) => data.has(k.toXdr("base64")))
        .map((k) => {
          if (k.type !== "contractData") throw new Error();
          const cd = k.contractData;
          const val = data.get(k.toXdr("base64"))!;
          return {
            key: k,
            val: xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({ ext: xdr.ExtensionPoint.v0(), contract: cd.contract, key: cd.key, durability: cd.durability, val })),
            liveUntilLedgerSeq: 10_000_000,
          } as rpc.Api.LedgerEntryResult;
        }),
    })),
  } as unknown as Rpc;
}

beforeEach(() => forgetEventScans());

describe("deposit records keyed by the session's anchor (review R2A1, round 2)", () => {
  const real = parseReceipt(V.receipt_v2.link);

  it("keeps a forged link's deposit beside the real one: the station's receipt still finds and claims the real session", async () => {
    const payer = Keypair.random().publicKey();
    // P pays the station's QR (A1), then a forged QR with the same ID and another chain (A2).
    await saveDeposit(record(payer, A1));
    await saveDeposit(record(payer, A2, { fichas: 1, amount: "10000000", createdAt: 1_790_000_600_000 }));
    expect((await listDeposits("testnet", payer)).map((d) => d.anchor).sort()).toEqual([A1, A2].sort());
    expect((await findDeposits("testnet", payer, HOST, "ERZGCG", "F3H9TXAB")).map((d) => d.anchor)).toEqual([A2, A1]);
    expect((await findDeposit("testnet", payer, HOST, "ERZGCG", "F3H9TXAB", A1))?.fichas).toBe(2);

    // Both sessions open on the contract: the station's receipt (proof to A1) is the real session's, open, with its claim.
    const both = ledger([session(payer, V.chains[0].anchor_hex), session(payer, V.chains[1].anchor_hex, { fichas: 1, amount: 10_000_000n })]);
    const c = await checkCustodyReceipt(both, NET, real, payer, REG, 1_790_001_000);
    expect(c.state).toBe("open");
    if (c.state !== "open") throw new Error();
    expect(c.record.anchor).toBe(A1);
    expect(c.facts).toMatchObject({ matches: true, units: 7, toPayer: 7_000_000n });

    // History lists both sessions, each open.
    const rows = await loadCustodySessions(both, NET, payer, REG);
    expect(rows.map((r) => [r.anchor, r.settled])).toEqual([
      [A2, undefined],
      [A1, undefined],
    ]);
  });

  it("refuses, as a bad proof, a receipt whose proof leads to none of this wallet's sessions under the ID", async () => {
    const payer = Keypair.random().publicKey();
    await saveDeposit(record(payer, A2));
    const c = await checkCustodyReceipt(ledger([session(payer, V.chains[1].anchor_hex)]), NET, real, payer, REG, 1_790_001_000);
    expect(c.state).toBe("bad_proof");
    if (c.state !== "bad_proof") throw new Error();
    expect(c.record.anchor).toBe(A2);
  });

  it("applies each anchor's events to its own record: one settling never closes or hides the other", () => {
    const payer = Keypair.random().publicKey();
    const base = { network: "testnet" as const, escrow: ESCROW, payer };
    const ctx = () => ({ asset: { code: "XLM", issuer: null }, token: C.xlmSac, fichaSecs: 300, unitSecs: 30, maxFichas: 12, graceSecs: 1680 });
    const terms = { token: C.xlmSac, price: 10_000_000n, fichaSecs: 300, maxFichas: 12, unitSecs: 30, graceSecs: 1680 };
    const deposit = (anchorHex: string, at: string, txHash: string): DepositEvent => ({
      kind: "deposit", host: HOST, station: "ERZGCG", session: "F3H9TXAB", payer, fichas: 2, amount: 20_000_000n, totalFichas: 2, totalAmount: 20_000_000n,
      anchor: hexToBytes(anchorHex), deadline: 1_790_002_280, terms, txHash, ledger: 100, at, id: txHash,
    });
    const settleA2: SettleEvent = {
      kind: "settle", host: HOST, station: "ERZGCG", session: "F3H9TXAB", anchor: hexToBytes(V.chains[1].anchor_hex), payer,
      toHost: 0n, toPayer: 20_000_000n, unusedUnits: 20, how: "host", txHash: "s2", ledger: 120, at: "2026-10-02T00:10:00Z", id: "s2",
    };
    const records = new Map<string, DepositRecord>();
    applyEvents(records, [deposit(V.chains[0].anchor_hex, "2026-10-02T00:00:00Z", "d1"), deposit(V.chains[1].anchor_hex, "2026-10-02T00:05:00Z", "d2"), settleA2], base, ctx);
    const byAnchor = Object.fromEntries([...records.values()].map((r) => [r.anchor, r]));
    expect(Object.keys(byAnchor).sort()).toEqual([A1, A2].sort());
    expect(byAnchor[A1].settled).toBeUndefined();
    expect(byAnchor[A2].settled).toMatchObject({ how: "host", toPayer: "20000000" });
    expect([...records.keys()]).toEqual([depositKey(byAnchor[A1]), depositKey(byAnchor[A2])]);
  });

  it("moves a record kept under the key without the anchor to its key, once", async () => {
    const payer = Keypair.random().publicKey();
    const r = record(payer, A1);
    const legacy = ["testnet", ESCROW, payer, HOST, "ERZGCG", "F3H9TXAB"].join("|");
    const store = createStore("ficha.deposits.v1", "deposits");
    await set(legacy, r, store);
    expect(await listDeposits("testnet", payer)).toEqual([r]);
    const now = (await keys<string>(store)).filter((k) => k.includes(payer));
    expect(now).toEqual([depositKey(r)]);
    expect(await listDeposits("testnet", payer)).toEqual([r]);
  });

  it("claims from History only with a stored receipt whose proof leads to the record's own anchor", () => {
    const stored: StoredReceipt = { receipt: real, check: "confirmed", savedAt: 1 };
    expect(claimHref({ anchor: A1 }, stored)).not.toBeNull();
    // The receipt kept for the ID is the real session's: the forged session's row offers no claim with it.
    expect(claimHref({ anchor: A2 }, stored)).toBeNull();
  });

  it("refuses on /p a new deposit under an ID this wallet already holds open with another anchor", () => {
    const page = readFileSync(fileURLToPath(new URL("../routes/p.tsx", import.meta.url)), "utf8");
    expect(page).toContain("findDeposits(net.id, publicKey, link.hostKey, link.stationId, link.session)");
    expect(page).toContain("other: records.find((d) => d.anchor !== anchor && maybeOpen(d))");
    expect(page).toContain('if (!record && local.other) return <BlockedAndScan text={t("p.otherAnchor", { memo })} memo={memo} />;');
    // The success screen kept after a lock is the session's (ID and anchor), not any link's under the ID.
    expect(page).toContain("loadLastPayment(net.id, publicKey, link.hostKey, paidKey(link))");
    const list = readFileSync(fileURLToPath(new URL("../components/SessionList.tsx", import.meta.url)), "utf8");
    expect(list).toContain('key={`${s.hostKey}|${s.memo}|${s.custody?.anchor ?? ""}`}');
    expect(toB64url(hexToBytes(V.chains[0].anchor_hex))).toBe(A1);
  });
});

describe("History's receipt per row (review R2A1, round 2: the memo-keyed receipt store)", () => {
  it("joins a kept receipt to a custody row only when its proof leads to that row's anchor", () => {
    const stored: StoredReceipt = { receipt: parseReceipt(V.receipt_v2.link), check: "confirmed", savedAt: 1 };
    const payer = Keypair.random().publicKey();
    expect(receiptFor({ custody: record(payer, A1) }, stored)).toBe(stored);
    expect(receiptFor({ custody: record(payer, A2) }, stored)).toBeUndefined();
    // A direct session's row keeps the receipt kept under its memo, as before.
    expect(receiptFor({}, stored)).toBe(stored);
  });
});
