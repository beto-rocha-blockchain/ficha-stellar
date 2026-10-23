/**
 * Host mode offline (src/custody/host.ts): the register, release and
 * host_refund calls as the contract takes them, the authorization each may
 * ask for, the contract's bounds on a station's terms, deadlines and refund
 * rules, the host's events and the view built from them and the ledger, and
 * "release all". The RPC is a fake; its simulation answers reuse a real
 * testnet one (testnet-fixtures.json) with the authorization swapped.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, Address, Keypair, Networks, StrKey, rpc, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk";
import { hexToBytes } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORKS } from "@/config";
import { DICTS } from "@/i18n";
import type { CustodyStation, Registry, Station } from "@/registry/verify";
import { WalletLockedError } from "@/wallet";
import { toB64url } from "./chain";
import { EscrowError } from "./errors";
import {
  addr,
  assetContract,
  buildCallTx,
  bytes32,
  checkAuth,
  owedKey,
  i128,
  instanceKey,
  sessionKey,
  stationKey,
  sym,
  termsVal,
  toStationTerms,
  u32,
  type EscrowSession,
  type ExpectedAuth,
  type Rpc,
  type StationTerms,
} from "./escrow";
import {
  DEADLINE_MARGIN_SECS,
  afterPayout,
  afterRegister,
  STATION_MIN_GRACE_SECONDS,
  afterSettle,
  assetOfToken,
  collectOwed,
  defaultEscrow,
  graceBelowStation,
  forgetHostScans,
  ledgerClockNow,
  formFromRegistry,
  formFromTerms,
  formProblems,
  hostEventFilter,
  hostRefundArgs,
  hostRefundAuth,
  loadHostView,
  parseHostEvent,
  payHostArgs,
  prepareHostRefund,
  preparePayHost,
  prepareRegister,
  prepareRelease,
  refundPlan,
  refundSplit,
  registerArgs,
  registerAuth,
  registryFields,
  releaseArgs,
  releaseMany,
  sendHostCall,
  sessionPhase,
  settleFromCall,
  stationCfg,
  tallyHostEvents,
  tallyKey,
  termsFromForm,
  termsProblems,
  type HostCallDone,
  type HostEvent,
  type HostSession,
  type StationForm,
} from "./host";
import { useHost, type HostContext } from "./host-store";

const NET = NETWORKS.testnet;
const C = NET.custody!;
const ESCROW = C.escrowContract;
const HOST = "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6";
const PAYER = "GAKINFFB6NVQONE3MA4BZ5X3EEDG6KYNG2WCL2NLJSFP2AAXI5GX6VIP";
const OTHER_HOST = "GCNWWWORIDEQALZKQL57SSOGUBGXC6PPAIZDFNEJV4FCDRSGLNDFQYFT";
const ANCHOR = hexToBytes("4c6f4ecc2381dc2428f35a50614d04919f2fb039310ada7a104316954a002b7b");
/** Another chain's anchor: under the same session ID, another session. */
const OTHER_ANCHOR = new Uint8Array(32).fill(7);

const F = JSON.parse(readFileSync(fileURLToPath(new URL("./testnet-fixtures.json", import.meta.url)), "utf8")) as {
  deposit_ok: { sim: rpc.Api.RawSimulateTransactionResponse };
  no_session: { error: string; events: string[]; latestLedger: number };
};

/** ERZGCG's terms on the contract (contract §7.1). */
const TERMS: StationTerms = { token: C.xlmSac, price: 10_000_000n, fichaSecs: 300, maxFichas: 12, unitSecs: 30, graceSecs: 1680, active: true };

const ERZGCG: CustodyStation = {
  id: "ERZGCG",
  name: "Demo bench (testnet)",
  host_key: HOST,
  asset: { code: "XLM", issuer: null },
  ficha_price: "1",
  ficha_minutes: 5,
  max_session_minutes: 60,
  active: true,
  mode: "custody",
  escrow: ESCROW,
  unit_seconds: 30,
  grace_seconds: 1680,
};

const SESSION: HostSession = {
  escrow: ESCROW,
  host: HOST,
  station: "ERZGCG",
  session: "F3H9TXAB",
  payer: PAYER,
  token: C.xlmSac,
  price: 10_000_000n,
  fichaSecs: 300,
  unitSecs: 30,
  maxFichas: 12,
  graceSecs: 1680,
  chainLen: 120,
  anchor: ANCHOR,
  fichas: 3,
  amount: 30_000_000n,
  opened: 1_790_000_000,
  deadline: 1_790_000_000 + 900 + 1680,
  archived: false,
  txHashes: ["aa"],
};

function fakeRpc(over: Partial<Record<keyof Rpc, unknown>> = {}): Rpc {
  return {
    getAccount: vi.fn(async (a: string) => new Account(a, "41")),
    getFeeStats: vi.fn(async () => ({ sorobanInclusionFee: { p90: "100" } })),
    getHealth: vi.fn(async () => ({ status: "healthy", latestLedger: 25_000, oldestLedger: 1_000, ledgerRetentionWindow: 120_960 })),
    ...over,
  } as unknown as Rpc;
}

/** The authorization entry a simulation returns for `want`, signed by the transaction's source. */
function authEntry(want: ExpectedAuth): xdr.SorobanAuthorizationEntry {
  const inv = (w: ExpectedAuth): xdr.SorobanAuthorizedInvocation =>
    new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: new Address(w.contract).toScAddress(), functionName: w.fn, args: w.args }),
      ),
      subInvocations: w.sub.map(inv),
    });
  return new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: inv(want) });
}

/** A successful simulation (the fixture's resources) that asks for `auth` and returns `ret`. */
function simulates(auth: ExpectedAuth[], ret: xdr.ScVal = xdr.ScVal.scvVoid()) {
  return vi.fn(async () =>
    rpc.parseRawSimulation({ ...F.deposit_ok.sim, results: [{ auth: auth.map((a) => authEntry(a).toXdr("base64")), xdr: ret.toXdr("base64") }] }),
  );
}

function invocation(tx: Transaction) {
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
  return op.func.invokeContract;
}

const code = (e: unknown) => (e instanceof EscrowError ? e.code : String(e));

describe("the host's calls (contract §7.1, Functions)", () => {
  it("encodes StationCfg as a map with Symbol keys in key order, and reads back the same terms", () => {
    const cfg = stationCfg(TERMS);
    expect(cfg.type).toBe("scvMap");
    if (cfg.type !== "scvMap") throw new Error();
    const entries = cfg.map ?? [];
    expect(entries.map((e) => scValToNative(e.key))).toEqual(["active", "ficha_secs", "grace_secs", "max_fichas", "price", "token", "unit_secs"]);
    expect(entries.map((e) => e.val.type)).toEqual(["scvBool", "scvU32", "scvU64", "scvU32", "scvI128", "scvAddress", "scvU32"]);
    expect(toStationTerms(scValToNative(cfg))).toEqual(TERMS);
  });

  it("encodes register, release and host_refund with the argument types of the contract", () => {
    expect(registerArgs(HOST, "ERZGCG", TERMS).map((a) => a.type)).toEqual(["scvAddress", "scvSymbol", "scvMap"]);
    const ref = { escrow: ESCROW, host: HOST, station: "ERZGCG", session: "F3H9TXAB", anchor: ANCHOR };
    // A session is its ID and its anchor.
    expect(releaseArgs(ref).map((a) => a.type)).toEqual(["scvAddress", "scvSymbol", "scvSymbol", "scvBytes"]);
    const [host, station, session, anchor] = releaseArgs(ref).map(scValToNative);
    expect([host, station, session, new Uint8Array(anchor)]).toEqual([HOST, "ERZGCG", "F3H9TXAB", ANCHOR]);
    expect(hostRefundArgs(ref, 7).map((a) => a.type)).toEqual(["scvAddress", "scvSymbol", "scvSymbol", "scvBytes", "scvU32"]);
    const tx = buildCallTx(new Account(HOST, "1"), Networks.TESTNET, ESCROW, "host_refund", hostRefundArgs(ref, 7));
    expect(invocation(tx).functionName.toString()).toBe("host_refund");
    expect(scValToNative(invocation(tx).args[4])).toBe(7);
  });

  it("accepts only the host's own register or host_refund as the authorization, with these exact arguments", () => {
    const want = registerAuth(ESCROW, HOST, "ERZGCG", TERMS);
    expect(() => checkAuth([authEntry(want)], want)).not.toThrow();
    // Other terms, another station, or anything under it: refused.
    expect(() => checkAuth([authEntry(registerAuth(ESCROW, HOST, "ERZGCG", { ...TERMS, price: 1n }))], want)).toThrow(EscrowError);
    expect(() => checkAuth([authEntry(registerAuth(ESCROW, HOST, "K7M2QX", TERMS))], want)).toThrow(EscrowError);
    const sub = { ...want, sub: [{ contract: C.xlmSac, fn: "transfer", args: [addr(HOST), addr(ESCROW), i128(1n)], sub: [] }] };
    expect(() => checkAuth([authEntry(sub)], want)).toThrow(EscrowError);
    const ref = { escrow: ESCROW, host: HOST, station: "ERZGCG", session: "F3H9TXAB", anchor: ANCHOR };
    expect(() => checkAuth([authEntry(hostRefundAuth(ref, 30))], hostRefundAuth(ref, 30))).not.toThrow();
    expect(() => checkAuth([authEntry(hostRefundAuth(ref, 29))], hostRefundAuth(ref, 30))).toThrow(EscrowError);
    expect(() => checkAuth([authEntry(hostRefundAuth({ ...ref, anchor: OTHER_ANCHOR }, 30))], hostRefundAuth(ref, 30))).toThrow(EscrowError);
  });
});

describe("a station's terms (contract §7.1 register: BadConfig)", () => {
  it("warns of a grace the contract takes but a station refuses to start with (900 s + the plug-in time)", () => {
    expect(STATION_MIN_GRACE_SECONDS).toBe(1080);
    expect(graceBelowStation(300)).toBe(true);
    expect(graceBelowStation(1079)).toBe(true);
    expect(graceBelowStation(1080)).toBe(false);
    expect(graceBelowStation(1680)).toBe(false);
    // Out of the contract's bounds is a form problem, not this warning.
    expect(graceBelowStation(299)).toBe(false);
    const form = readFileSync(fileURLToPath(new URL("../routes/host/station.tsx", import.meta.url)), "utf8");
    expect(form).toContain('t("f.graceStation", { min: STATION_MIN_GRACE_SECONDS })');
  });

  it("accepts ERZGCG's terms and names each bound broken", () => {
    expect(termsProblems(TERMS)).toEqual([]);
    expect(termsProblems({ ...TERMS, price: 0n })).toEqual(["price"]);
    expect(termsProblems({ ...TERMS, fichaSecs: 0 })).toContain("ficha");
    expect(termsProblems({ ...TERMS, maxFichas: 0 })).toEqual(["max"]);
    expect(termsProblems({ ...TERMS, unitSecs: 0 })).toEqual(["unit"]);
    expect(termsProblems({ ...TERMS, unitSecs: 45 })).toEqual(["unit_divides"]);
    expect(termsProblems({ ...TERMS, graceSecs: 299 })).toEqual(["grace"]);
    expect(termsProblems({ ...TERMS, graceSecs: 300 })).toEqual([]);
    expect(termsProblems({ ...TERMS, graceSecs: 86_400 })).toEqual([]);
    expect(termsProblems({ ...TERMS, graceSecs: 86_401 })).toEqual(["grace"]);
    // 24 h at most per session, and 256 refund units.
    expect(termsProblems({ ...TERMS, fichaSecs: 3600, unitSecs: 3600, maxFichas: 24 })).toEqual([]);
    expect(termsProblems({ ...TERMS, fichaSecs: 3600, unitSecs: 3600, maxFichas: 25 })).toEqual(["session_too_long"]);
    expect(termsProblems({ ...TERMS, fichaSecs: 60, unitSecs: 15, maxFichas: 64 })).toEqual([]);
    expect(termsProblems({ ...TERMS, fichaSecs: 60, unitSecs: 15, maxFichas: 65 })).toEqual(["chain_too_long"]);
    expect(termsProblems({ ...TERMS, price: 1n << 120n })).toEqual(["overflow"]);
  });

  it("turns a form in the registry's units into the contract's terms, and back", () => {
    const form = formFromRegistry(ERZGCG);
    expect(form).toEqual({ id: "ERZGCG", asset: { code: "XLM", issuer: null }, price: "1", fichaMinutes: 5, maxSessionMinutes: 60, unitSeconds: 30, graceSeconds: 1680, active: true });
    expect(formProblems(form, NET)).toEqual([]);
    expect(termsFromForm(form, NET)).toEqual(TERMS);
    expect(formFromTerms("ERZGCG", TERMS, { code: "XLM", issuer: null })).toEqual(form);
    // max_fichas = floor(max session / ficha minutes), as the registry's match rule says.
    expect(termsFromForm({ ...form, maxSessionMinutes: 62 }, NET).maxFichas).toBe(12);
    // A direct entry gets the defaults: 30 s units and the recommended grace.
    const direct: Station = { ...ERZGCG, mode: undefined, escrow: undefined, unit_seconds: undefined, grace_seconds: undefined };
    expect(formFromRegistry(direct)).toMatchObject({ unitSeconds: 30, graceSeconds: 1680 });
  });

  it("checks the form before anything is built", () => {
    const form: StationForm = formFromRegistry(ERZGCG);
    expect(formProblems({ ...form, id: "ERZGC" }, NET)).toEqual(["id"]);
    expect(formProblems({ ...form, id: "ERZGCI" }, NET)).toEqual(["id"]); // no I, L, O or U in a station ID
    expect(formProblems({ ...form, price: "0" }, NET)).toEqual(["price"]);
    expect(formProblems({ ...form, price: "1.12345678" }, NET)).toEqual(["price"]);
    expect(formProblems({ ...form, fichaMinutes: 2.5 }, NET)).toEqual(["ficha"]);
    expect(formProblems({ ...form, maxSessionMinutes: 4 }, NET)).toEqual(["max"]);
    expect(formProblems({ ...form, unitSeconds: Number.NaN }, NET)).toEqual(["unit"]);
    expect(formProblems({ ...form, unitSeconds: 7 }, NET)).toEqual(["unit_divides"]);
    expect(formProblems({ ...form, unitSeconds: 1 }, NET)).toEqual(["chain_too_long"]);
  });

  it("names the asset of a token, and the registry fields that match the terms", () => {
    expect(assetOfToken(C.xlmSac, NET)).toEqual({ code: "XLM", issuer: null });
    const usdc = termsFromForm({ ...formFromRegistry(ERZGCG), asset: NET.usdc }, NET).token;
    expect(assetOfToken(usdc, NET)).toEqual({ code: "USDC", issuer: NET.usdc.issuer });
    expect(assetOfToken(ESCROW, NET)).toBeNull();
    const fields = registryFields(TERMS, ESCROW, { code: "XLM", issuer: null });
    expect(fields).toEqual({
      asset: ERZGCG.asset,
      ficha_price: "1",
      ficha_minutes: ERZGCG.ficha_minutes,
      max_session_minutes: ERZGCG.max_session_minutes,
      mode: "custody",
      escrow: ESCROW,
      unit_seconds: ERZGCG.unit_seconds,
      grace_seconds: ERZGCG.grace_seconds,
    });
  });
});

describe("deadlines and refunds (contract §7.1 host_refund, §7.7)", () => {
  it("offers release and a partial refund only past the deadline (with a margin for the ledger's clock)", () => {
    expect(sessionPhase(SESSION, SESSION.deadline)).toBe("open");
    expect(sessionPhase(SESSION, SESSION.deadline + DEADLINE_MARGIN_SECS)).toBe("open");
    expect(sessionPhase(SESSION, SESSION.deadline + DEADLINE_MARGIN_SECS + 1)).toBe("expired");
  });

  it("decides release and partial refunds on the ledger's clock, run forward on the phone's monotonic clock (review R2A1)", () => {
    const clock = { ledger: SESSION.deadline - 30, mono: 1_000 };
    // The phone's wall clock is 5 min slow; 45 s pass on its monotonic clock: the ledger is past the deadline.
    const now = ledgerClockNow(clock, 46_000, SESSION.deadline - 330);
    expect(now).toBe(SESSION.deadline + 15);
    expect(sessionPhase(SESSION, now)).toBe("expired");
    expect(refundPlan(SESSION, now).fullOnly).toBe(false);
    // 5 min fast: still open on the ledger, so release is not offered (it would fail with TooEarly).
    expect(sessionPhase(SESSION, ledgerClockNow(clock, 2_000, SESSION.deadline + 300))).toBe("open");
    // A monotonic clock never runs back: no earlier than the read.
    expect(ledgerClockNow(clock, 0, 0)).toBe(clock.ledger);
    // No ledger time read yet: the phone's clock.
    expect(ledgerClockNow(null, 99, 123)).toBe(123);
    const page = readFileSync(fileURLToPath(new URL("../routes/host/index.tsx", import.meta.url)), "utf8");
    expect(page).toContain("const nowSec = useLedgerNow(ctx?.server);");
    expect(page).toContain("ledgerClockNow(clock, performance.now(), Date.now() / 1000)");
    expect(page).not.toContain("useNowSec");
  });

  it("refunds only in full before the deadline, any part after it", () => {
    // 3 fichas of 300 s in 30 s units: 30 paid units.
    expect(refundPlan(SESSION, SESSION.deadline)).toEqual({ paid: 30, min: 30, max: 30, fullOnly: true });
    expect(refundPlan(SESSION, SESSION.deadline + 60)).toEqual({ paid: 30, min: 1, max: 30, fullOnly: false });
    // The contract's split: ceil(amount x units / paid), the rest to the host.
    expect(refundSplit(SESSION, 30)).toEqual({ toPayer: 30_000_000n, toHost: 0n });
    expect(refundSplit(SESSION, 7)).toEqual({ toPayer: 7_000_000n, toHost: 23_000_000n });
    expect(refundSplit({ ...SESSION, amount: 10n }, 1)).toEqual({ toPayer: 1n, toHost: 9n });
  });
});

// ---------------------------------------------------------------- events and the view

const map = (o: [string, xdr.ScVal][]) => xdr.ScVal.scvMap(o.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })));
const u64 = (n: number) => xdr.ScVal.scvU64(BigInt(n));

let seq = 0;
function rawEvent(topic: xdr.ScVal[], value: xdr.ScVal, ledger: number): rpc.Api.EventResponse {
  seq += 1;
  return { topic, value, ledger, ledgerClosedAt: new Date(1_790_000_000_000 + ledger * 5000).toISOString(), txHash: `tx${seq}`, id: `id${seq}`, type: "contract" } as unknown as rpc.Api.EventResponse;
}

function stationEvent(host: string, station: string, t: StationTerms, ledger: number) {
  return rawEvent([sym("station"), addr(host), sym(station)], stationCfg(t), ledger);
}

function depositEvent(
  host: string,
  station: string,
  session: string,
  o: { fichas: number; total: number; deadline: number; payer?: string; anchor?: Uint8Array },
  ledger: number,
) {
  const value = map([
    ["amount", i128(BigInt(o.fichas) * 10_000_000n)],
    ["anchor", bytes32(o.anchor ?? ANCHOR)],
    ["deadline", u64(o.deadline)],
    ["fichas", u32(o.fichas)],
    ["payer", addr(o.payer ?? PAYER)],
    ["terms", termsVal(TERMS)],
    ["total_amount", i128(BigInt(o.total) * 10_000_000n)],
    ["total_fichas", u32(o.total)],
  ]);
  return rawEvent([sym("deposit"), addr(host), sym(station), sym(session)], value, ledger);
}

function settleEvent(host: string, station: string, session: string, how: string, toHost: bigint, toPayer: bigint, ledger: number, anchor = ANCHOR) {
  const value = map([
    ["anchor", bytes32(anchor)],
    ["how", sym(how)],
    ["payer", addr(PAYER)],
    ["to_host", i128(toHost)],
    ["to_payer", i128(toPayer)],
    ["unused_units", u32(0)],
  ]);
  return rawEvent([sym("settle"), addr(host), sym(station), sym(session)], value, ledger);
}

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
    ["payer", addr(s.payer)],
    ["price", i128(s.price)],
    ["token", addr(s.token)],
    ["unit_secs", u32(s.unitSecs)],
  ]);
}

const instanceVal = (hash: string) =>
  xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(hexToBytes(hash)), storage: null }));

/** getLedgerEntries over a set of contract data entries (key XDR -> value). */
function ledgerOf(data: Map<string, xdr.ScVal>, latestLedger = 30_000, liveUntil = 200_000) {
  return vi.fn(async (...keys: xdr.LedgerKey[]) => ({
    latestLedger,
    entries: keys
      .filter((k) => data.has(k.toXdr("base64")))
      .map((k) => {
        if (k.type !== "contractData") throw new Error("not contract data");
        const cd = k.contractData;
        const val = data.get(k.toXdr("base64"))!;
        return {
          key: k,
          val: xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({ ext: xdr.ExtensionPoint.v0(), contract: cd.contract, key: cd.key, durability: cd.durability, val })),
          liveUntilLedgerSeq: liveUntil,
        };
      }),
  }));
}

const cursorAt = (ledger: number) => `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-4294967295`;
const eventsPage = (events: rpc.Api.EventResponse[], latestLedger = 30_000) => ({ events, cursor: cursorAt(latestLedger), latestLedger, oldestLedger: 1_000 });

describe("the host's events (contract §7.2)", () => {
  it("reads a station event, and a deposit or settle as the payer's code does", () => {
    const st = parseHostEvent(stationEvent(HOST, "ERZGCG", TERMS, 10));
    expect(st).toMatchObject({ kind: "station", host: HOST, station: "ERZGCG", terms: TERMS });
    expect(parseHostEvent(depositEvent(HOST, "ERZGCG", "F3H9TXAB", { fichas: 2, total: 2, deadline: 99 }, 11))).toMatchObject({ kind: "deposit", fichas: 2, totalAmount: 20_000_000n });
    expect(parseHostEvent(settleEvent(HOST, "ERZGCG", "F3H9TXAB", "deadline", 1n, 0n, 12))).toMatchObject({ kind: "settle", how: "deadline", toHost: 1n });
    expect(parseHostEvent(rawEvent([sym("station"), addr(HOST), sym("ERZGCG")], xdr.ScVal.scvVoid(), 13))).toBeNull();
  });

  it("asks for every event of one host in one filter: station, deposit and settle, any station", () => {
    const f = hostEventFilter(ESCROW, HOST);
    expect(f.contractIds).toEqual([ESCROW]);
    expect(f.topics?.map((t) => t.length)).toEqual([3, 4, 4]);
    const names = f.topics!.map((t) => scValToNative(xdr.ScVal.fromXdr(t[0], "base64")));
    expect(names).toEqual(["station", "deposit", "settle"]);
    expect(f.topics!.every((t) => scValToNative(xdr.ScVal.fromXdr(t[1], "base64")) === HOST && t.slice(2).every((s) => s === "*"))).toBe(true);
  });

  it("tallies sessions: deposits open and top up, a settle closes, a stale QR reopens", () => {
    const evs = [
      stationEvent(HOST, "ERZGCG", TERMS, 1),
      depositEvent(HOST, "ERZGCG", "FAAAAAAA", { fichas: 1, total: 1, deadline: 100 }, 2),
      depositEvent(HOST, "ERZGCG", "FAAAAAAA", { fichas: 2, total: 3, deadline: 700 }, 3),
      depositEvent(HOST, "K7M2QX", "FBBBBBBB", { fichas: 1, total: 1, deadline: 200 }, 4),
      settleEvent(HOST, "K7M2QX", "FBBBBBBB", "proof", 5n, 5n, 5),
      depositEvent(OTHER_HOST, "ERZGCG", "FCCCCCCC", { fichas: 1, total: 1, deadline: 300 }, 6),
      depositEvent(HOST, "K7M2QX", "FBBBBBBB", { fichas: 1, total: 1, deadline: 900 }, 7),
    ]
      .map(parseHostEvent)
      .filter((e): e is HostEvent => e !== null);
    const t = tallyHostEvents(evs, HOST);
    expect(t.stations).toEqual(["ERZGCG", "K7M2QX"]);
    const a = tallyKey("ERZGCG", "FAAAAAAA", ANCHOR);
    const b = tallyKey("K7M2QX", "FBBBBBBB", ANCHOR);
    expect([...t.open.keys()]).toEqual([a, b]);
    expect(a).toBe(`ERZGCG/FAAAAAAA/${toB64url(ANCHOR)}`);
    expect(t.open.get(a)!.deposits.map((d) => d.totalFichas)).toEqual([1, 3]);
    expect(t.open.get(b)!.deposits).toHaveLength(1);
    expect(t.settled.map((s) => s.session)).toEqual(["FBBBBBBB"]);
  });

  it("keeps two sessions under one ID apart by their anchors (contract §7.1: a session is its ID and its anchor)", () => {
    const evs = [
      depositEvent(HOST, "ERZGCG", "FAAAAAAA", { fichas: 1, total: 1, deadline: 100, payer: OTHER_HOST, anchor: OTHER_ANCHOR }, 2),
      depositEvent(HOST, "ERZGCG", "FAAAAAAA", { fichas: 2, total: 2, deadline: 700 }, 3),
      settleEvent(HOST, "ERZGCG", "FAAAAAAA", "proof", 0n, 10_000_000n, 4, OTHER_ANCHOR),
    ]
      .map(parseHostEvent)
      .filter((e): e is HostEvent => e !== null);
    const t = tallyHostEvents(evs, HOST);
    // The other chain's session settled; the station's own is still open.
    expect([...t.open.keys()]).toEqual([tallyKey("ERZGCG", "FAAAAAAA", ANCHOR)]);
    expect(t.open.get(tallyKey("ERZGCG", "FAAAAAAA", ANCHOR))!.payer).toBe(PAYER);
    expect(t.settled.map((s) => toB64url(s.anchor))).toEqual([toB64url(OTHER_ANCHOR)]);
  });
});

/** A browser-like localStorage for the phone's memory of stations and sessions. */
function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe("the host's view (stations, open sessions, settlements)", () => {
  beforeEach(() => {
    forgetHostScans();
    vi.stubGlobal("window", { localStorage: fakeStorage() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const reg = (stations: Station[]): Registry => ({ format: "ficha-registry/1", issued_at: "2026-10-01T00:00:00Z", network: "testnet", stations });
  const open: EscrowSession = { ...SESSION, fichas: 3, amount: 30_000_000n };

  function chain() {
    const data = new Map<string, xdr.ScVal>([
      [instanceKey(ESCROW).toXdr("base64"), instanceVal(C.escrowWasm[0])],
      [stationKey(ESCROW, HOST, "ERZGCG").toXdr("base64"), stationCfg(TERMS)],
      [stationKey(ESCROW, HOST, "K7M2QX").toXdr("base64"), stationCfg({ ...TERMS, price: 5_000_000n, active: false })],
      [sessionKey(ESCROW, HOST, "ERZGCG", "F3H9TXAB", ANCHOR).toXdr("base64"), sessionVal(open)],
    ]);
    const events = [
      stationEvent(HOST, "K7M2QX", { ...TERMS, price: 5_000_000n, active: false }, 1_100),
      depositEvent(HOST, "ERZGCG", "F3H9TXAB", { fichas: 3, total: 3, deadline: open.deadline }, 1_200),
      depositEvent(HOST, "ERZGCG", "F2222222", { fichas: 1, total: 1, deadline: 50 }, 1_300),
      settleEvent(HOST, "ERZGCG", "F2222222", "deadline", 10_000_000n, 0n, 1_400),
    ];
    return { data, events };
  }

  it("lists the stations on the contract and in the registry, the open sessions and the settlements", async () => {
    const { data, events } = chain();
    const getEvents = vi.fn(async (_req: unknown) => eventsPage(events));
    const server = fakeRpc({ getEvents, getLedgerEntries: ledgerOf(data) });
    const notOnChain: CustodyStation = { ...ERZGCG, id: "M4P7RT" };
    const view = await loadHostView(server, NET, HOST, reg([ERZGCG, notOnChain, { ...ERZGCG, id: "Z9Z9Z9", host_key: OTHER_HOST }]));
    expect(view.escrows).toEqual([{ id: ESCROW, wasmHash: C.escrowWasm[0], pinned: true }]);
    expect(view.stations.map((s) => [s.id, s.registryState, s.terms?.price])).toEqual([
      ["ERZGCG", "match", 10_000_000n],
      ["M4P7RT", "not_registered", undefined],
      ["K7M2QX", "absent", 5_000_000n],
    ]);
    expect(view.sessions).toHaveLength(1);
    expect(view.sessions[0]).toMatchObject({ station: "ERZGCG", session: "F3H9TXAB", payer: PAYER, fichas: 3, deadline: open.deadline, txHashes: [expect.any(String)] });
    expect(view.settled.map((s) => [s.session, s.how])).toEqual([["F2222222", "deadline"]]);
    expect(view.eventsIncomplete).toBe(false);
    // One filter, this host's.
    expect(getEvents.mock.calls[0][0]).toMatchObject({ startLedger: 1_000, filters: [hostEventFilter(ESCROW, HOST)] });
  });

  it("compares a station with its registry entry: other terms, direct mode, another escrow", async () => {
    const { data, events } = chain();
    const server = () => fakeRpc({ getEvents: vi.fn(async () => eventsPage(events)), getLedgerEntries: ledgerOf(data) });
    const state = async (entry: Station) => {
      forgetHostScans();
      const v = await loadHostView(server(), NET, HOST, reg([entry]));
      const s = v.stations.find((x) => x.id === "ERZGCG")!;
      return [s.registryState, s.differs];
    };
    expect(await state({ ...ERZGCG, ficha_price: "2", unit_seconds: 60 })).toEqual(["differs", ["price", "unit_secs"]]);
    expect(await state({ ...ERZGCG, mode: undefined, escrow: undefined, unit_seconds: undefined, grace_seconds: undefined })).toEqual(["direct", []]);
  });

  it("reads again only what is new, and remembers open sessions beyond the event window", async () => {
    const { data, events } = chain();
    const getEvents = vi.fn(async (_req: unknown) => eventsPage(events));
    const server = fakeRpc({ getEvents, getLedgerEntries: ledgerOf(data) });
    await loadHostView(server, NET, HOST, null);
    getEvents.mockImplementation(async () => eventsPage([], 31_000));
    const again = await loadHostView(server, NET, HOST, null);
    expect(getEvents.mock.calls[1][0]).toMatchObject({ cursor: cursorAt(30_000) });
    expect(again.sessions.map((s) => s.session)).toEqual(["F3H9TXAB"]);

    // The RPC lost its events (or is down): the phone still knows the open session and the stations.
    forgetHostScans();
    const down = fakeRpc({ getEvents: vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))), getLedgerEntries: ledgerOf(data) });
    const fallback = await loadHostView(down, NET, HOST, null);
    expect(fallback.eventsIncomplete).toBe(true);
    expect(fallback.sessions.map((s) => s.session)).toEqual(["F3H9TXAB"]);
    expect(fallback.stations.map((s) => s.id).sort()).toEqual(["ERZGCG", "K7M2QX"]);
  });

  it("reads each event once when two loads run at the same time", async () => {
    const { data, events } = chain();
    const getEvents = vi.fn(async (_req: unknown) => eventsPage(events));
    const server = fakeRpc({ getEvents, getLedgerEntries: ledgerOf(data) });
    await loadHostView(server, NET, HOST, null);
    // Both start from the same cursor; the page they read must not be kept twice.
    const late = settleEvent(HOST, "ERZGCG", "F9999999", "proof", 1n, 1n, 29_000);
    getEvents.mockImplementation(async () => eventsPage([late], 31_000));
    const [a, b] = await Promise.all([loadHostView(server, NET, HOST, null), loadHostView(server, NET, HOST, null)]);
    expect(getEvents).toHaveBeenCalledTimes(2);
    expect(a.settled.map((e) => e.session)).toEqual(["F9999999", "F2222222"]);
    expect(b.settled).toEqual(a.settled);
    const again = await loadHostView(server, NET, HOST, null);
    expect(again.settled.map((e) => e.session)).toEqual(["F9999999", "F2222222"]);
  });

  it("follows the registry's escrow after a testnet reset, not the one built into the app", async () => {
    // The registry, re-signed after a reset, names a new deployment; the app was not rebuilt.
    const NEW = StrKey.encodeContract(new Uint8Array(32).fill(9));
    const moved: CustodyStation = { ...ERZGCG, escrow: NEW };
    expect(defaultEscrow(reg([moved, { ...moved, id: "K7M2QX", host_key: OTHER_HOST }]), NET)).toBe(NEW);
    // No custody station in the registry (or no registry): the app's own.
    expect(defaultEscrow(reg([]), NET)).toBe(ESCROW);
    expect(defaultEscrow(null, NET)).toBe(ESCROW);
    // A tie keeps the app's own.
    expect(defaultEscrow(reg([moved, { ...ERZGCG, id: "K7M2QX" }]), NET)).toBe(ESCROW);

    const data = new Map<string, xdr.ScVal>([
      [instanceKey(NEW).toXdr("base64"), instanceVal(C.escrowWasm[0])],
      [stationKey(NEW, HOST, "ERZGCG").toXdr("base64"), stationCfg(TERMS)],
    ]);
    const server = fakeRpc({ getEvents: vi.fn(async () => eventsPage([])), getLedgerEntries: ledgerOf(data) });
    // Another host's station on the new escrow: a new station of this host goes there too.
    const view = await loadHostView(server, NET, HOST, reg([{ ...moved, host_key: OTHER_HOST }]));
    expect(view.escrows).toEqual([{ id: NEW, wasmHash: C.escrowWasm[0], pinned: true }]);
    const form = readFileSync(fileURLToPath(new URL("../routes/host/station.tsx", import.meta.url)), "utf8");
    expect(form).toContain("defaultEscrow(ctx.registry, net)");
    expect(form).not.toContain("net.custody!.escrowContract");
  });

  it("flags an escrow whose code the app does not pin, and an archived session", async () => {
    const { data, events } = chain();
    data.set(instanceKey(ESCROW).toXdr("base64"), instanceVal("00".repeat(32)));
    const server = fakeRpc({ getEvents: vi.fn(async () => eventsPage(events)), getLedgerEntries: ledgerOf(data, 30_000, 29_999) });
    const view = await loadHostView(server, NET, HOST, null);
    expect(view.escrows[0].pinned).toBe(false);
    expect(view.sessions[0].archived).toBe(true);
  });

  it("updates the view after this phone's own release, refund or register", () => {
    const view = {
      network: "testnet" as const,
      host: HOST,
      escrows: [],
      stations: [],
      sessions: [SESSION],
      settled: [],
      owed: [],
      eventsIncomplete: false,
      latestLedger: 1,
    };
    const done: HostCallDone = { hash: "h1", ledger: 9, closedAt: 1_790_009_999, amount: 30_000_000n };
    const released = settleFromCall(SESSION, "deadline", done);
    expect(released).toMatchObject({ how: "deadline", toHost: 30_000_000n, toPayer: 0n, unusedUnits: 0, txHash: "h1" });
    // Another session under the same ID (another anchor) settling leaves this one open.
    expect(afterSettle(view, { ...released, anchor: OTHER_ANCHOR }).sessions).toEqual([SESSION]);
    const after = afterSettle(view, released);
    expect(after.sessions).toEqual([]);
    expect(after.settled[0].txHash).toBe("h1");
    // host_refund returns the payer's share.
    expect(settleFromCall(SESSION, "host", { ...done, amount: 7_000_000n }, 7)).toMatchObject({ toPayer: 7_000_000n, toHost: 23_000_000n, unusedUnits: 7 });
    const registered = afterRegister(view, NET, reg([ERZGCG]), ESCROW, "ERZGCG", TERMS);
    expect(registered.stations).toEqual([expect.objectContaining({ id: "ERZGCG", registryState: "match", terms: TERMS })]);
    const changed = afterRegister(registered, NET, reg([ERZGCG]), ESCROW, "ERZGCG", { ...TERMS, active: false });
    expect(changed.stations).toHaveLength(1);
    expect(changed.stations[0].terms?.active).toBe(false);
  });
});

describe("prepare and send (simulated before anything is signed)", () => {
  const ref = { escrow: ESCROW, host: HOST, station: "ERZGCG", session: "F3H9TXAB", anchor: ANCHOR };

  it("refuses terms out of bounds before calling the network", async () => {
    const simulateTransaction = vi.fn();
    const server = fakeRpc({ simulateTransaction });
    await expect(prepareRegister(server, NET, { escrow: ESCROW, host: HOST, station: "ERZGCG", terms: { ...TERMS, unitSecs: 45 } })).rejects.toMatchObject({
      code: "BadConfig",
      detail: "unit_divides",
    });
    await expect(prepareRegister(server, NET, { escrow: ESCROW, host: HOST, station: "erzgcg", terms: TERMS })).rejects.toMatchObject({ code: "BadConfig", detail: "id" });
    expect(simulateTransaction).not.toHaveBeenCalled();
  });

  it("assembles register when the simulation asks for the host's register alone", async () => {
    const want = registerAuth(ESCROW, HOST, "ERZGCG", TERMS);
    const p = await prepareRegister(fakeRpc({ simulateTransaction: simulates([want]) }), NET, { escrow: ESCROW, host: HOST, station: "ERZGCG", terms: TERMS });
    expect(invocation(p.tx).functionName.toString()).toBe("register");
    expect(p.tx.source).toBe(HOST);
    expect(p.tx.signatures).toHaveLength(0);
    // Asked to authorize anything else: refused, nothing signed.
    const other = fakeRpc({ simulateTransaction: simulates([registerAuth(ESCROW, HOST, "ERZGCG", { ...TERMS, graceSecs: 300 })]) });
    await expect(prepareRegister(other, NET, { escrow: ESCROW, host: HOST, station: "ERZGCG", terms: TERMS })).rejects.toMatchObject({ code: "bad_auth" });
  });

  it("assembles release with no authorization at all, and refuses one that asks for any", async () => {
    const p = await prepareRelease(fakeRpc({ simulateTransaction: simulates([], i128(30_000_000n)) }), NET, ref);
    expect(invocation(p.tx).functionName.toString()).toBe("release");
    expect(scValToNative(p.result!)).toBe(30_000_000n);
    const asks = fakeRpc({ simulateTransaction: simulates([hostRefundAuth(ref, 30)]) });
    await expect(prepareRelease(asks, NET, ref)).rejects.toMatchObject({ code: "bad_auth" });
  });

  it("assembles host_refund for exactly these units, and maps TooEarly before signing", async () => {
    const p = await prepareHostRefund(fakeRpc({ simulateTransaction: simulates([hostRefundAuth(ref, 30)], i128(30_000_000n)) }), NET, ref, 30);
    expect(scValToNative(invocation(p.tx).args[4])).toBe(30);
    await expect(prepareHostRefund(fakeRpc({ simulateTransaction: simulates([hostRefundAuth(ref, 29)]) }), NET, ref, 30)).rejects.toMatchObject({ code: "bad_auth" });
    await expect(prepareHostRefund(fakeRpc(), NET, ref, 0)).rejects.toThrow(RangeError);
    // TooEarly (#9), as the RPC reports a contract error without events.
    const tooEarly = fakeRpc({
      simulateTransaction: vi.fn(async () => rpc.parseRawSimulation({ id: "1", error: "HostError: Error(Contract, #9)", events: [], latestLedger: 1 })),
    });
    await expect(prepareHostRefund(tooEarly, NET, ref, 7)).rejects.toMatchObject({ code: "contract", detail: "#9" });
  });

  it("signs, sends and reads what the call returned", async () => {
    const kp = Keypair.random();
    const p = await prepareRelease(fakeRpc({ simulateTransaction: simulates([]) }), NET, { ...ref, host: kp.publicKey() });
    const sign = vi.fn((tx: Transaction) => {
      tx.sign(kp);
      return tx;
    });
    const server = fakeRpc({
      sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: "h" })),
      getTransaction: vi.fn(async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 77, createdAt: 1_790_000_100, returnValue: i128(30_000_000n) })),
    });
    const done = await sendHostCall(server, ESCROW, p, sign);
    expect(sign).toHaveBeenCalledOnce();
    expect(done).toMatchObject({ ledger: 77, closedAt: 1_790_000_100, amount: 30_000_000n });
    expect(done.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the host store (src/custody/host-store.ts)", () => {
  beforeEach(() => {
    forgetHostScans();
    useHost.setState({ key: null, view: null, loading: false, error: null, batch: null });
  });

  const expired = (session: string, deadline: number): HostSession => ({ ...SESSION, session, deadline });

  function chainWith(sessions: HostSession[]) {
    const data = new Map<string, xdr.ScVal>([[instanceKey(ESCROW).toXdr("base64"), instanceVal(C.escrowWasm[0])]]);
    data.set(stationKey(ESCROW, HOST, "ERZGCG").toXdr("base64"), stationCfg(TERMS));
    for (const x of sessions) data.set(sessionKey(ESCROW, HOST, "ERZGCG", x.session, x.anchor).toXdr("base64"), sessionVal(x));
    const events = sessions.map((x, i) => depositEvent(HOST, "ERZGCG", x.session, { fichas: 3, total: 3, deadline: x.deadline }, 1_000 + i));
    return { data, events };
  }

  it("loads the view, and drops it for another host", async () => {
    const { data, events } = chainWith([expired("FAAAAAAA", 100)]);
    const ctx: HostContext = { server: fakeRpc({ getEvents: vi.fn(async () => eventsPage(events)), getLedgerEntries: ledgerOf(data) }), net: NET, host: HOST, registry: null };
    await useHost.getState().load(ctx);
    expect(useHost.getState()).toMatchObject({ key: `testnet|${HOST}`, loading: false, error: null });
    expect(useHost.getState().view?.sessions.map((s) => s.session)).toEqual(["FAAAAAAA"]);

    const failing = { ...ctx, host: OTHER_HOST, server: fakeRpc({ getEvents: vi.fn(async () => eventsPage([])), getLedgerEntries: vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))) }) };
    await useHost.getState().load(failing);
    expect(useHost.getState()).toMatchObject({ key: `testnet|${OTHER_HOST}`, view: null, loading: false });
    expect(useHost.getState().error).toBeInstanceOf(TypeError);
  });

  it("keeps this phone's settlement over a load that started before it", async () => {
    const { data, events } = chainWith([expired("FAAAAAAA", 100)]);
    const ledger = ledgerOf(data);
    const ctx: HostContext = { server: fakeRpc({ getEvents: vi.fn(async () => eventsPage(events)), getLedgerEntries: ledger }), net: NET, host: HOST, registry: null };
    await useHost.getState().load(ctx);
    const session = useHost.getState().view!.sessions[0];

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    ledger.mockImplementationOnce(async (...keys: xdr.LedgerKey[]) => {
      await gate;
      return ledgerOf(data)(...keys);
    });
    const stale = useHost.getState().load(ctx);
    useHost.getState().settled(ctx, session, "deadline", { hash: "h", ledger: 5, closedAt: 1_790_000_000, amount: session.amount });
    release();
    await stale;
    expect(useHost.getState().view?.sessions).toEqual([]);
    expect(useHost.getState().view?.settled[0]).toMatchObject({ how: "deadline", txHash: "h" });
  });

  it("releases all, one batch at a time, keeping its progress in the store", async () => {
    const { data, events } = chainWith([expired("FAAAAAAA", 100), expired("FBBBBBBB", 200)]);
    const kp = Keypair.random();
    const sign = (tx: Transaction) => {
      tx.sign(kp);
      return tx;
    };
    let sent = 0;
    const server = fakeRpc({
      getEvents: vi.fn(async () => eventsPage(events)),
      getLedgerEntries: ledgerOf(data),
      simulateTransaction: simulates([], i128(30_000_000n)),
      sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: `h${++sent}` })),
      getTransaction: vi.fn(async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 77, createdAt: 1_790_000_100, returnValue: i128(30_000_000n) })),
    });
    const ctx: HostContext = { server, net: NET, host: HOST, registry: null };
    await useHost.getState().load(ctx);
    const sessions = useHost.getState().view!.sessions;
    const checkFee = vi.fn(async () => undefined);
    const run = useHost.getState().releaseAll(ctx, sessions, sign, checkFee);
    expect(await useHost.getState().releaseAll(ctx, sessions, sign)).toBeNull(); // one at a time
    const res = await run;
    expect(res).toMatchObject({ total: 2, done: 2, stopped: null, running: false });
    expect(checkFee).toHaveBeenCalledTimes(2);
    expect(useHost.getState().batch).toMatchObject({ done: 2, running: false });
    expect(useHost.getState().view?.sessions).toEqual([]);
    expect(useHost.getState().view?.settled.map((s) => s.session)).toEqual(["FBBBBBBB", "FAAAAAAA"]);
    useHost.getState().clearBatch();
    expect(useHost.getState().batch).toBeNull();
  });
});

describe("release all", () => {
  const s = (session: string): HostSession => ({ ...SESSION, session });
  const ok = (hash: string): HostCallDone => ({ hash, ledger: 1, closedAt: 1, amount: 1n });

  it("releases one after another, skips one someone else settled, and reports progress", async () => {
    const order: string[] = [];
    const release = vi.fn(async (x: HostSession) => {
      order.push(x.session);
      if (x.session === "FBBBBBBB") throw new EscrowError("NoSession");
      return ok(x.session);
    });
    const progress = vi.fn();
    const res = await releaseMany([s("FAAAAAAA"), s("FBBBBBBB"), s("FCCCCCCC")], release, progress);
    expect(order).toEqual(["FAAAAAAA", "FBBBBBBB", "FCCCCCCC"]);
    expect(res).toMatchObject({ total: 3, done: 3, running: false, stopped: null, current: null });
    expect(res.released.map((r) => r.session.session)).toEqual(["FAAAAAAA", "FCCCCCCC"]);
    expect(res.skipped.map((r) => code(r.error))).toEqual(["NoSession"]);
    expect(progress.mock.calls.map(([p]) => p.current?.session ?? null)).toEqual(["FAAAAAAA", "FBBBBBBB", "FCCCCCCC", null]);
  });

  it("stops when the wallet locks or the network does not answer", async () => {
    const locked = await releaseMany([s("FAAAAAAA"), s("FBBBBBBB")], async (x) => {
      if (x.session === "FAAAAAAA") throw new WalletLockedError();
      return ok(x.session);
    });
    expect(locked).toMatchObject({ done: 0, released: [], running: false });
    expect(locked.stopped).toBeInstanceOf(WalletLockedError);

    const unknown = await releaseMany([s("FAAAAAAA"), s("FBBBBBBB"), s("FCCCCCCC")], async (x) => {
      if (x.session === "FBBBBBBB") throw new EscrowError("unknown_outcome");
      return ok(x.session);
    });
    expect(unknown.done).toBe(1);
    expect(code(unknown.stopped)).toBe("unknown_outcome");
  });
});

describe("what the contract holds for the host, and pay_host (contract §7.1 owed; review gap g1)", () => {
  beforeEach(() => {
    forgetHostScans();
    vi.stubGlobal("window", { localStorage: fakeStorage() });
    useHost.setState({ key: null, view: null, loading: false, error: null, batch: null });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const USDC_SAC = NET.usdc;
  const xlmOwed = owedKey(ESCROW, HOST, C.xlmSac);

  /** The fixture's NoSession simulation (#5), as the escrow's #13 NothingOwed. */
  function nothingOwed() {
    const events = F.no_session.events.map((b64) => {
      const d = xdr.DiagnosticEvent.fromXdr(b64, "base64");
      const body = d.event.body;
      if (body.type === "v0" && body.v0.topics[1]?.type === "scvError") body.v0.topics[1] = xdr.ScVal.scvError(xdr.ScError.sceContract(13));
      return d.toXdr("base64");
    });
    return vi.fn(async () => rpc.parseRawSimulation({ id: "1", ...F.no_session, error: F.no_session.error.replace("#5", "#13"), events }));
  }

  it("reads what is owed per token with the rest of the view, and lists only amounts above zero", async () => {
    const data = new Map<string, xdr.ScVal>([
      [instanceKey(ESCROW).toXdr("base64"), instanceVal(C.escrowWasm[0])],
      [stationKey(ESCROW, HOST, "ERZGCG").toXdr("base64"), stationCfg(TERMS)],
      [xlmOwed.toXdr("base64"), i128(5_000_000n)],
      // An entry pay_host left at 0 (it stays, at 0): nothing to collect.
      [owedKey(ESCROW, HOST, assetContractOf(USDC_SAC)).toXdr("base64"), i128(0n)],
    ]);
    const getLedgerEntries = ledgerOf(data);
    const view = await loadHostView(fakeRpc({ getEvents: vi.fn(async () => eventsPage([])), getLedgerEntries }), NET, HOST, null);
    expect(view.owed).toEqual([{ escrow: ESCROW, token: C.xlmSac, amount: 5_000_000n, archived: false }]);
    // One ledger read: the code, the terms, the sessions and the owed entries together.
    expect(getLedgerEntries).toHaveBeenCalledOnce();
    expect(afterPayout(view, ESCROW, C.xlmSac).owed).toEqual([]);
    // The UI: one panel per escrow and token, collect under the unlocked wallet.
    const page = readFileSync(fileURLToPath(new URL("../routes/host/index.tsx", import.meta.url)), "utf8");
    expect(page).toContain("mine.owed.map((o) => (");
    expect(page).toContain("collectOwed(ctx.server, ctx.net, { escrow: owed.escrow, token: owed.token, host: ctx.host }, signTransaction, xlmFeeCheck(ctx.net, ctx.host))");
    expect(page).toContain("useHost.getState().paidOut(ctx, owed.escrow, owed.token)");
  });

  it("builds pay_host(host, token) with no authorization at all, and reads what it pays from the simulation", async () => {
    expect(payHostArgs(HOST, C.xlmSac).map((a) => a.type)).toEqual(["scvAddress", "scvAddress"]);
    const p = await preparePayHost(fakeRpc({ simulateTransaction: simulates([], i128(5_000_000n)) }), NET, { escrow: ESCROW, host: HOST, token: C.xlmSac });
    expect(invocation(p.tx).functionName.toString()).toBe("pay_host");
    expect(invocation(p.tx).args.map((a) => scValToNative(a))).toEqual([HOST, C.xlmSac]);
    expect(p.tx.source).toBe(HOST);
    expect(p.amount).toBe(5_000_000n);
    // Asked to authorize anything: refused, nothing signed.
    const asks = fakeRpc({ simulateTransaction: simulates([hostRefundAuth({ escrow: ESCROW, host: HOST, station: "ERZGCG", session: "F3H9TXAB", anchor: ANCHOR }, 1)], i128(1n)) });
    await expect(preparePayHost(asks, NET, { escrow: ESCROW, host: HOST, token: C.xlmSac })).rejects.toMatchObject({ code: "bad_auth" });
    // Nothing owed: the contract's NothingOwed, before signing.
    await expect(preparePayHost(fakeRpc({ simulateTransaction: nothingOwed() }), NET, { escrow: ESCROW, host: HOST, token: C.xlmSac })).rejects.toMatchObject({
      code: "NothingOwed",
    });
  });

  it("collects: the fee checked, signed once, sent, and the store forgets the amount", async () => {
    const kp = Keypair.random();
    const host = kp.publicKey();
    const data = new Map<string, xdr.ScVal>([
      [instanceKey(ESCROW).toXdr("base64"), instanceVal(C.escrowWasm[0])],
      [owedKey(ESCROW, host, C.xlmSac).toXdr("base64"), i128(7_000_000n)],
    ]);
    const sign = vi.fn((tx: Transaction) => {
      tx.sign(kp);
      return tx;
    });
    const server = fakeRpc({
      getEvents: vi.fn(async () => eventsPage([])),
      getLedgerEntries: ledgerOf(data),
      simulateTransaction: simulates([], i128(7_000_000n)),
      sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: "h" })),
      getTransaction: vi.fn(async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 80, createdAt: 1_790_000_200, returnValue: i128(7_000_000n) })),
    });
    const ctx: HostContext = { server, net: NET, host, registry: null };
    await useHost.getState().load(ctx);
    expect(useHost.getState().view?.owed.map((o) => o.amount)).toEqual([7_000_000n]);
    const checkFee = vi.fn(async () => undefined);
    const done = await collectOwed(server, NET, { escrow: ESCROW, token: C.xlmSac, host }, sign, checkFee);
    expect(done).toMatchObject({ ledger: 80, amount: 7_000_000n });
    expect(checkFee).toHaveBeenCalledOnce();
    expect(sign).toHaveBeenCalledOnce();
    useHost.getState().paidOut(ctx, ESCROW, C.xlmSac);
    expect(useHost.getState().view?.owed).toEqual([]);
  });

  it("says a claim's host share is held for the host, not paid to it", () => {
    for (const lang of ["pt-BR", "en"] as const) {
      const dict = DICTS[lang];
      expect(dict["host.settled.proof"]).toMatch(lang === "pt-BR" ? /retidos para você/ : /held for you/);
      for (const k of ["host.owed.title", "host.owed.body", "host.owed.collect", "host.owed.done", "host.err.NothingOwed"]) expect(dict[k], k).toBeDefined();
    }
  });
});

function assetContractOf(a: { code: string; issuer: string }): string {
  return assetContract(a, NET);
}
