/**
 * A pay page left open (review R2A2, round 2): right before a deposit is
 * built, the session is read again (and a new one's events), the scan of
 * those events must reach the latest ledger, and the deadline the
 * simulation returns must be this deposit's. Otherwise nothing is signed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, Address, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import { NETWORKS } from "@/config";
import { EscrowError } from "./errors";
import { addr, bytes32, i128, instanceKey, sessionEvents, sessionKey, sym, termsVal, u32, type EscrowSession, type Rpc, type StationTerms } from "./escrow";
import { parsePayLink } from "./link";
import { checkDepositDeadline, prepareDeposit, recheckDeposit, type DepositRequest } from "./pay";

const NET = NETWORKS.testnet;
const C = NET.custody!;
const ESCROW = C.escrowContract;
const HOST = "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6";
const ANCHOR = hexToBytes("4c6f4ecc2381dc2428f35a50614d04919f2fb039310ada7a104316954a002b7b");
const LEDGER_NOW = 1_790_001_000;
const F = JSON.parse(readFileSync(fileURLToPath(new URL("./testnet-fixtures.json", import.meta.url)), "utf8")) as {
  deposit_ok: { sim: rpc.Api.RawSimulateTransactionResponse };
};

const TERMS: StationTerms = { token: C.xlmSac, price: 10_000_000n, fichaSecs: 300, maxFichas: 12, unitSecs: 30, graceSecs: 1680, active: true };
/** The fixture's deposit: the demo host paying 2 fichas into ERZGCG.F2222222 with ANCHOR. */
const link = parsePayLink(`ficha:/p?v=1&n=t&h=${HOST}&s=ERZGCG&x=F2222222&a=TG9OzCOB3CQo81pQYU0EkZ8vsDkxCtp6EEMWlUoAK3s`);
const OPEN: EscrowSession = {
  payer: HOST, token: C.xlmSac, price: 10_000_000n, fichaSecs: 300, unitSecs: 30, maxFichas: 12, graceSecs: 1680, chainLen: 120,
  anchor: ANCHOR, fichas: 2, amount: 20_000_000n, opened: LEDGER_NOW - 900, deadline: LEDGER_NOW - 900 + 600 + 1680,
};

const map = (o: [string, xdr.ScVal][]) => xdr.ScVal.scvMap(o.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })));
const u64 = (n: number) => xdr.ScVal.scvU64(BigInt(n));

function sessionVal(s: EscrowSession): xdr.ScVal {
  return map([
    ["amount", i128(s.amount)],
    ["anchor", bytes32(s.anchor)],
    ["chain_len", u32(s.chainLen)],
    ["deadline", u64(s.deadline)],
    ["ficha_secs", u32(s.fichaSecs)],
    ["fichas", u32(s.fichas)],
    ["grace_secs", u64(s.graceSecs)],
    ["max_fichas", u32(s.maxFichas)],
    ["opened", u64(s.opened)],
    ["payer", new Address(s.payer).toScVal()],
    ["price", i128(s.price)],
    ["token", addr(s.token)],
    ["unit_secs", u32(s.unitSecs)],
  ]);
}

/** A deposit event under the link's ID with this anchor (someone paid this session). */
function depositEvent(anchor: Uint8Array): rpc.Api.EventResponse {
  const value = map([
    ["amount", i128(10_000_000n)],
    ["anchor", bytes32(anchor)],
    ["deadline", u64(LEDGER_NOW)],
    ["fichas", u32(1)],
    ["payer", addr(HOST)],
    ["terms", termsVal(TERMS)],
    ["total_amount", i128(10_000_000n)],
    ["total_fichas", u32(1)],
  ]);
  return {
    topic: [sym("deposit"), addr(HOST), sym("ERZGCG"), sym("F2222222")], value, ledger: 4_000, ledgerClosedAt: "2026-10-02T00:00:00Z", txHash: "aa", id: "e1", type: "contract",
  } as unknown as rpc.Api.EventResponse;
}

const cursorAt = (ledger: number) => `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-4294967295`;

function chain(o: { session?: EscrowSession | null; events?: rpc.Api.EventResponse[]; scanReaches?: number; ret?: xdr.ScVal } = {}): Rpc {
  const latestLedger = 5_000;
  const instance = xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(hexToBytes(C.escrowWasm[0])), storage: null }));
  const data = new Map<string, xdr.ScVal>([[instanceKey(ESCROW).toXdr("base64"), instance]]);
  if (o.session) data.set(sessionKey(ESCROW, HOST, "ERZGCG", "F2222222", o.session.anchor).toXdr("base64"), sessionVal(o.session));
  const sim = F.deposit_ok.sim;
  return {
    getAccount: vi.fn(async (a: string) => new Account(a, "41")),
    getFeeStats: vi.fn(async () => ({ sorobanInclusionFee: { p90: "100" } })),
    getHealth: vi.fn(async () => ({ status: "healthy", latestLedger, oldestLedger: 1_000, ledgerRetentionWindow: 120_960 })),
    getLatestLedger: vi.fn(async () => ({ id: "x", sequence: latestLedger, protocolVersion: "23", closeTime: String(LEDGER_NOW) })),
    getEvents: vi.fn(async () => ({ events: o.events ?? [], cursor: cursorAt(o.scanReaches ?? latestLedger), latestLedger, oldestLedger: 1_000 })),
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
          };
        }),
    })),
    simulateTransaction: vi.fn(async () => rpc.parseRawSimulation({ ...sim, results: [{ auth: sim.results![0].auth, xdr: (o.ret ?? u64(0)).toXdr("base64") }] })),
  } as unknown as Rpc;
}

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof EscrowError ? e.code : String(e)));

describe("a pay page left open: the session read again before the deposit (review R2A2, round 2)", () => {
  it("lets a new session through only while it is still unpaid, with every event read", async () => {
    expect(await recheckDeposit(chain(), ESCROW, link, HOST, "new", TERMS)).toEqual({ open: null, ledgerNow: LEDGER_NOW });
    // Another judge paid it, and it settled, while the page stayed open: a stale QR now.
    expect(await code(recheckDeposit(chain({ events: [depositEvent(ANCHOR)] }), ESCROW, link, HOST, "new", TERMS))).toBe("stale_qr");
    // Another chain under the same ID is another session: still unpaid.
    expect(await code(recheckDeposit(chain({ events: [depositEvent(new Uint8Array(32).fill(7))] }), ESCROW, link, HOST, "new", TERMS))).toBe("ok");
    // Open now (paid from another tab): not the new session the page shows.
    expect(await code(recheckDeposit(chain({ session: OPEN }), ESCROW, link, HOST, "new", TERMS))).toBe("session_changed");
    // The scan never reached the latest ledger (where a recent payment would be): nothing on a guess.
    const short = chain({ scanReaches: 4_000 });
    expect(await code(recheckDeposit(short, ESCROW, link, HOST, "new", TERMS))).toBe("unchecked");
    expect(await code(sessionEvents(short, ESCROW, HOST, "ERZGCG", "F2222222"))).toBe("unchecked");
  });

  it("lets a top-up through only into this wallet's session, still open and before the station's end", async () => {
    expect(await recheckDeposit(chain({ session: OPEN }), ESCROW, link, HOST, "topup", TERMS)).toMatchObject({ open: { fichas: 2 }, ledgerNow: LEDGER_NOW });
    // Settled meanwhile (a claim from another tab, host_refund, the E key and a claim): the contract would open a new session.
    expect(await code(recheckDeposit(chain(), ESCROW, link, HOST, "topup", TERMS))).toBe("session_changed");
    // Past the station's end (its claim window before the deadline).
    expect(await code(recheckDeposit(chain({ session: { ...OPEN, deadline: LEDGER_NOW + 600 } }), ESCROW, link, HOST, "topup", TERMS))).toBe("session_changed");
  });

  it("checks the simulated deadline is this deposit's before anything is signed", async () => {
    const base: DepositRequest = { escrow: ESCROW, token: C.xlmSac, asset: { code: "XLM", issuer: null }, payer: HOST, link, fichas: 2, terms: TERMS };
    // A new session: about now + 2 x 300 s + 1680 s.
    const expected = LEDGER_NOW + 600 + 1680;
    const ok = await prepareDeposit(chain({ ret: u64(expected + 5) }), NET, { ...base, ledgerNow: LEDGER_NOW });
    expect(ok.amount).toBe(20_000_000n);
    expect(await code(prepareDeposit(chain({ ret: u64(OPEN.deadline + 600) }), NET, { ...base, ledgerNow: LEDGER_NOW }))).toBe("session_changed");
    // A top-up moves the open session's deadline by its own time; a new session's deadline instead means it settled.
    expect(await code(prepareDeposit(chain({ ret: u64(OPEN.deadline + 600) }), NET, { ...base, open: OPEN, ledgerNow: LEDGER_NOW }))).toBe("ok");
    expect(await code(prepareDeposit(chain({ ret: u64(expected) }), NET, { ...base, open: OPEN, ledgerNow: LEDGER_NOW }))).toBe("session_changed");
    expect(() => checkDepositDeadline(xdr.ScVal.scvVoid(), base)).toThrow(EscrowError);
    expect(checkDepositDeadline(nativeToScVal(123n, { type: "u64" }), base)).toBe(123);
  });

  it("reads again right before every deposit on /p, and stops on a changed session without retrying blindly", () => {
    const page = readFileSync(fileURLToPath(new URL("../routes/p.tsx", import.meta.url)), "utf8");
    const pay = page.slice(page.indexOf("const pay = async"));
    expect(pay.indexOf("recheckDeposit(server, station.escrow, link, publicKey")).toBeGreaterThan(-1);
    expect(pay.indexOf("recheckDeposit(")).toBeLessThan(pay.indexOf("prepareDeposit("));
    expect(pay).toContain("ledgerNow: again.ledgerNow");
    expect(page).toMatch(/const FINAL = new Set\(\[[^\]]*"session_changed", "stale_qr"\]\)/);
  });
});
