import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { clear, createStore } from "idb-keyval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORKS } from "@/config";
import { DICTS, LANGS } from "@/i18n";
import { reloadIsSafe } from "@/native/service-worker";
import { getRegistry, type Registry, type Station } from "@/registry";
import { LedgerBlockError, buildRefundTx, connectFreighter, freighterBlocks, readFreighter, sendRefund, type FreighterSession } from "./freighter";
import type { HostPayment } from "@/pay/history";
import { LEDGER_PAGES, RefundError, checkLedger, checkRefund, parseRefundRef, parseRefundUri, readRefundLedger, refundCap } from "./request";

const freighter = vi.hoisted(() => ({
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  getAddress: vi.fn(),
  getNetworkDetails: vi.fn(),
  signTransaction: vi.fn(),
}));
vi.mock("@stellar/freighter-api", () => freighter);

// The public registry's station (registry/stations.public.json): 0.5 XLM per 1-minute ficha, up to 10 minutes.
const PUBLIC_HOST = "GDVPPO2JSSCMTPAL2CY7WZQSUEONXU45MR4GCUY3CNAFQUTRZ5JK6ZCN";
const PAYER = "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6";
const USDC = NETWORKS.public.usdc;
const MEMO = encodeURIComponent("refund 8DY7RJ.FAFXJXBZ");
const MSG = encodeURIComponent("Ficha refund · unused 3:20");
/** A public-network refund as the station writes it: no network_passphrase. */
const uri = (amount = "2.5", memo = MEMO, extra = "") =>
  `web+stellar:pay?destination=${PAYER}&amount=${amount}&memo=${memo}&memo_type=MEMO_TEXT&msg=${MSG}${extra}`;

function code(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof RefundError ? e.code : "other";
  }
}

describe("refund URI", () => {
  it("reads the station's session refund on the public network (no network_passphrase)", () => {
    const r = parseRefundUri(uri());
    expect(r.net).toBe(NETWORKS.public);
    expect(r.amount).toBe("2.5");
    expect(r.req.destination).toBe(PAYER);
    expect(r.req.asset).toEqual({ code: "XLM", issuer: null });
    expect(r.req.memo).toBe("refund 8DY7RJ.FAFXJXBZ");
    expect(new TextEncoder().encode(r.req.memo).length).toBe(22);
    expect(r.refText).toBe("8DY7RJ.FAFXJXBZ");
    expect(r.ref).toEqual({ kind: "session", stationId: "8DY7RJ", session: "FAFXJXBZ" });
  });

  it("takes the network from network_passphrase, never from the app's setting", () => {
    const testnet = `&network_passphrase=${encodeURIComponent(Networks.TESTNET)}`;
    expect(parseRefundUri(uri("2.5", MEMO, testnet)).net).toBe(NETWORKS.testnet);
    expect(parseRefundUri(uri("2.5", MEMO, `&network_passphrase=${encodeURIComponent(Networks.PUBLIC)}`)).net).toBe(NETWORKS.public);
    expect(code(() => parseRefundUri(uri("2.5", MEMO, `&network_passphrase=${encodeURIComponent("Some Other Network")}`)))).toBe("bad_network");
  });

  it("reads each REF the station writes", () => {
    expect(parseRefundRef("8DY7RJ.FAFXJXBZ")).toEqual({ kind: "session", stationId: "8DY7RJ", session: "FAFXJXBZ" });
    expect(parseRefundRef("8DY7RJ.tx1a2b3c4d")).toEqual({ kind: "payment", stationId: "8DY7RJ", tx: "1a2b3c4d" });
    expect(parseRefundRef("tx1a2b3c4d5e6f")).toEqual({ kind: "payment", stationId: null, tx: "1a2b3c4d5e6f" });
    expect(parseRefundUri(uri("1", encodeURIComponent("refund 8DY7RJ.tx1a2b3c4d"))).ref).toEqual({ kind: "payment", stationId: "8DY7RJ", tx: "1a2b3c4d" });
    for (const bad of ["8DY7RJ", "FAFXJXBZ", "8DY7R0.FAFXJXBZ", "8DY7RJ.tx1a2b3c", "8DY7RJ.tx1a2b3c4dz", "tx1a2b3c4d", "8DY7RJ.FAFXJXBZ "]) {
      expect(parseRefundRef(bad), bad).toBeNull();
    }
  });

  it("refuses a URI that is not a refund pay request", () => {
    expect(code(() => parseRefundUri(`web+stellar:tx?xdr=AAAA`))).toBe("not_pay");
    expect(code(() => parseRefundUri(`https://ficha-stellar.vercel.app/pay?destination=${PAYER}`))).toBe("not_pay");
    // The pay QR's own memo, a bare session, no memo at all, or a memo that is not text.
    expect(code(() => parseRefundUri(uri("2.5", "8DY7RJ.FAFXJXBZ")))).toBe("not_refund");
    expect(code(() => parseRefundUri(uri("2.5", encodeURIComponent("Refund 8DY7RJ.FAFXJXBZ"))))).toBe("not_refund");
    expect(code(() => parseRefundUri(uri("2.5", encodeURIComponent("refund  8DY7RJ.FAFXJXBZ"))))).toBe("not_refund");
    expect(code(() => parseRefundUri(uri("2.5", encodeURIComponent("refund hello"))))).toBe("not_refund");
    expect(code(() => parseRefundUri(`web+stellar:pay?destination=${PAYER}&amount=1`))).toBe("no_memo");
    expect(code(() => parseRefundUri(`web+stellar:pay?destination=${PAYER}&amount=1&memo=${MEMO}&memo_type=MEMO_ID`))).toBe("memo_type");
    expect(code(() => parseRefundUri(uri().replace(PAYER, "GBAD")))).toBe("bad_destination");
  });

  it("refuses an amount that is missing, not positive, or has more than 7 decimals", () => {
    expect(code(() => parseRefundUri(`web+stellar:pay?destination=${PAYER}&memo=${MEMO}&memo_type=MEMO_TEXT`))).toBe("bad_amount");
    expect(code(() => parseRefundUri(uri("")))).toBe("bad_amount");
    for (const a of ["0", "0.0000000", "-1", "1e3", "1.12345678", "1,5", "abc"]) expect(code(() => parseRefundUri(uri(a))), a).toBe("bad_amount");
    expect(parseRefundUri(uri("0.0000001")).amount).toBe("0.0000001");
    expect(parseRefundUri(uri("1.1234567")).amount).toBe("1.1234567");
  });
});

const station: Station = {
  id: "8DY7RJ",
  name: "HackMeridian mainnet (direct)",
  host_key: PUBLIC_HOST,
  asset: { code: "XLM", issuer: null },
  ficha_price: "0.5",
  ficha_minutes: 1,
  max_session_minutes: 10,
  active: true,
};
const reg = (s: Partial<Station> = {}, network: Registry["network"] = "public"): Registry => ({
  format: "ficha-registry/1",
  issued_at: "2026-10-25T15:50:00Z",
  network,
  stations: [{ ...station, ...s }],
});
const check = (u: string, r: Registry | null = reg()) => checkRefund(parseRefundUri(u), r);

describe("refund against the signed registry", () => {
  it("caps a refund at a whole session at the registry price plus one ficha", () => {
    expect(refundCap(station)).toBe("5.5");
    // 2.5 fichas of session (25 min of 10-minute fichas) + 1.
    expect(refundCap({ ficha_price: "1", ficha_minutes: 10, max_session_minutes: 25 })).toBe("3.5");
    // Rounded up, never down: 10/3 stroops is 4, plus one ficha.
    expect(refundCap({ ficha_price: "0.0000001", ficha_minutes: 3, max_session_minutes: 10 })).toBe("0.0000005");
  });

  it("resolves the station named in REF and accepts a refund up to the cap", () => {
    expect(check(uri())).toMatchObject({ state: "ok", station: { id: "8DY7RJ", host_key: PUBLIC_HOST }, cap: "5.5" });
    expect(check(uri("5.5")).state).toBe("ok");
    expect(check(uri("5.5000001"))).toMatchObject({ state: "over_cap", cap: "5.5" });
    expect(check(uri("100")).state).toBe("over_cap");
    expect(check(uri("1", encodeURIComponent("refund 8DY7RJ.tx1a2b3c4d"))).state).toBe("ok");
  });

  it("blocks when the registry is missing or for another network, or the station is not one to refund here", () => {
    expect(check(uri(), null)).toEqual({ state: "no_registry", stationId: "8DY7RJ" });
    expect(check(uri(), reg({}, "testnet")).state).toBe("no_registry");
    expect(check(uri("1", encodeURIComponent("refund tx1a2b3c4d5e6f"))).state).toBe("no_station");
    expect(check(uri("1", encodeURIComponent("refund K7M2QX.FAFXJXBZ")))).toEqual({ state: "unknown_station", stationId: "K7M2QX" });
    expect(check(uri(), reg({ active: false })).state).toBe("inactive");
    const custody = { mode: "custody" as const, escrow: "CBRNN2W726PIWP7DLLCAOW663I2TBSMR6N7J7S4CGGUIWIXK4HYI6KYC", unit_seconds: 30, grace_seconds: 900 };
    expect(check(uri(), reg(custody)).state).toBe("custody");
    // USDC paid back at an XLM station: the cap is in XLM, so that one is refunded by hand.
    expect(check(uri("1", MEMO, `&asset_code=USDC&asset_issuer=${USDC.issuer}`)).state).toBe("asset_mismatch");
    expect(check(uri("1", MEMO, `&asset_code=USDC&asset_issuer=${USDC.issuer}`), reg({ asset: USDC })).state).toBe("ok");
    expect(check(uri("1"), reg({ asset: USDC })).state).toBe("asset_mismatch");
  });

  describe("loaded from the network's own signed registry", () => {
    const body = readFileSync(fileURLToPath(new URL("../../../registry/stations.public.json", import.meta.url)));
    const sig = readFileSync(fileURLToPath(new URL("../../../registry/stations.public.json.sig", import.meta.url)), "utf8");
    let served: Uint8Array;
    let urls: string[];

    beforeEach(async () => {
      urls = [];
      await clear(createStore("ficha.registry.v1", "registry"));
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          urls.push(url);
          return new Response(url.endsWith(".sig") ? sig : new Blob([new Uint8Array(served)]));
        }),
      );
    });

    afterEach(() => vi.unstubAllGlobals());

    it("finds 8DY7RJ and its host in the public registry, verified with the pinned key", async () => {
      served = body;
      const r = parseRefundUri(uri());
      const c = checkRefund(r, await getRegistry(r.net));
      expect(c).toMatchObject({ state: "ok", station: { id: "8DY7RJ", host_key: PUBLIC_HOST } });
      expect(urls).toContain("https://ficha-stellar.vercel.app/registry/stations.public.json");
      expect(urls.some((u) => u.endsWith("registry/stations.json"))).toBe(false);
    });

    it("blocks when the registry does not verify", async () => {
      served = new Uint8Array(body);
      served[served.indexOf("H".charCodeAt(0))] = "h".charCodeAt(0);
      const r = parseRefundUri(uri());
      expect(checkRefund(r, await getRegistry(r.net)).state).toBe("no_registry");
    });
  });
});

/** A successful payment operation as Horizon lists it with join=transactions. */
let opId = 1000;
const op = (from: string, to: string, amount: string, memo: string | null, o: { hash?: string; asset?: { code: string; issuer: string } } = {}) => ({
  id: String(opId++),
  type: "payment",
  transaction_successful: true,
  transaction_hash: o.hash ?? (opId.toString(16) + "e".repeat(64)).slice(0, 64),
  created_at: "2026-10-25T17:55:23Z",
  from,
  to,
  amount,
  ...(o.asset ? { asset_type: "credit_alphanum4", asset_code: o.asset.code, asset_issuer: o.asset.issuer } : { asset_type: "native" }),
  transaction: memo === null ? { memo_type: "none" } : { memo_type: "text", memo },
});
type Op = ReturnType<typeof op>;
/** The records as HostPayment, as fetchPaymentsBetween reads them. */
const hostPayments = (ops: Op[]): HostPayment[] =>
  ops.map((o) => ({
    id: o.id,
    txHash: o.transaction_hash,
    createdAt: o.created_at,
    from: o.from,
    to: o.to,
    amount: o.amount,
    assetCode: o.asset_type === "native" ? "XLM" : (o as { asset_code: string }).asset_code,
    assetIssuer: o.asset_type === "native" ? null : (o as { asset_issuer: string }).asset_issuer,
    memo: o.transaction.memo_type === "text" ? (o.transaction as { memo: string }).memo : null,
  }));
/** Horizon's /accounts/<host>/payments, newest first, one page. */
const stubHorizon = (ops: Op[]) => {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ _embedded: { records: ops }, _links: { next: { href: `${url}&next` } } }));
    }),
  );
  return urls;
};

describe("refund against the host's payments on the ledger", () => {
  const SESSION = "8DY7RJ.FAFXJXBZ";
  const HASH = "1a2b3c4d" + "0".repeat(56);
  const TX_MEMO = encodeURIComponent("refund 8DY7RJ.tx1a2b3c4d");
  // A look-alike of the payer: the same first and last 6 characters.
  const LOOKALIKE = PAYER.slice(0, 6) + Keypair.random().publicKey().slice(6, -6) + PAYER.slice(-6);
  const SPAMMER = Keypair.random().publicKey();
  const ledger = (u: string, ops: Op[], complete = true) => checkLedger(parseRefundUri(u), station, hostPayments(ops), complete);

  it("blocks a refund to an address that paid the host nothing under its REF", () => {
    expect(ledger(uri("0.95"), [])).toEqual({ state: "no_payment", complete: true });
    // Paid under another session, with no memo, to another account, in another asset, or by a look-alike.
    expect(ledger(uri("0.95"), [op(PAYER, PUBLIC_HOST, "1.0000000", "8DY7RJ.K7M2QXAB")]).state).toBe("no_payment");
    expect(ledger(uri("0.95"), [op(PAYER, PUBLIC_HOST, "1.0000000", null)]).state).toBe("no_payment");
    expect(ledger(uri("0.95"), [op(PAYER, USDC.issuer, "1.0000000", SESSION)]).state).toBe("no_payment");
    expect(ledger(uri("0.95"), [op(PAYER, PUBLIC_HOST, "1.0000000", SESSION, { asset: USDC })]).state).toBe("no_payment");
    expect(ledger(uri("0.95"), [op(LOOKALIKE, PUBLIC_HOST, "1.0000000", SESSION)]).state).toBe("no_payment");
    // The host's own payment under the session is not the payer's.
    expect(ledger(uri("0.95"), [op(PUBLIC_HOST, PAYER, "1.0000000", SESSION)]).state).toBe("no_payment");
    expect(ledger(uri("0.95"), [], false)).toEqual({ state: "no_payment", complete: false });
  });

  it("allows at most what the payer paid under the session", () => {
    const paid = [op(PAYER, PUBLIC_HOST, "1.0000000", SESSION), op(PAYER, PUBLIC_HOST, "0.5000000", SESSION)];
    expect(ledger(uri("1.5"), paid)).toMatchObject({ state: "ok", total: "1.5" });
    expect(ledger(uri("0.95"), paid)).toMatchObject({ state: "ok", total: "1.5" });
    expect(ledger(uri("1.5000001"), paid)).toMatchObject({ state: "more_than_paid", total: "1.5" });
    // A smaller payment than the refund: the amount is not the payer's own money.
    expect(ledger(uri("5.5"), [op(PAYER, PUBLIC_HOST, "1.0000000", SESSION)])).toMatchObject({ state: "more_than_paid", total: "1" });
  });

  it("blocks once the host has sent the payer a payment with this refund's memo, in its asset", () => {
    const paid = [op(PAYER, PUBLIC_HOST, "5.0000000", SESSION)];
    // The same 0.95 paid before (from this page, the phone's QR or another tab): never again, whatever is left of the 5.
    const before = op(PUBLIC_HOST, PAYER, "0.9500000", "refund 8DY7RJ.FAFXJXBZ");
    const c = ledger(uri("0.95"), [before, ...paid]);
    expect(c).toMatchObject({ state: "refunded", refunded: "0.95" });
    expect(c.state === "refunded" && c.refunds.map((p) => p.txHash)).toEqual([before.transaction_hash]);
    expect(ledger(uri("0.95"), [before, op(PUBLIC_HOST, PAYER, "0.1000000", "refund 8DY7RJ.FAFXJXBZ"), ...paid])).toMatchObject({ refunded: "1.05" });
    // Even with no payment found: a refund was sent under it.
    expect(ledger(uri("0.95"), [before]).state).toBe("refunded");
    // Another memo, another address (a look-alike too) or another asset is not this refund.
    const other = [
      op(PUBLIC_HOST, PAYER, "0.9500000", "rent"),
      op(PUBLIC_HOST, PAYER, "0.9500000", "refund 8DY7RJ.K7M2QXAB"),
      op(PUBLIC_HOST, LOOKALIKE, "0.9500000", "refund 8DY7RJ.FAFXJXBZ"),
      op(PUBLIC_HOST, PAYER, "0.9500000", "refund 8DY7RJ.FAFXJXBZ", { asset: USDC }),
    ];
    expect(ledger(uri("0.95"), [...other, ...paid])).toMatchObject({ state: "ok", total: "5" });
  });

  it("counts a session's payment below one ficha (underpaid, or after it closed) but never lets it cover more", () => {
    // Address poisoning's 0.0001 XLM under a session's memo: at most that 0.0001 back to its own sender.
    const dust = [op(LOOKALIKE, PUBLIC_HOST, "0.0001000", SESSION), op(PAYER, PUBLIC_HOST, "0.0001000", SESSION)];
    expect(ledger(uri("0.95"), dust)).toMatchObject({ state: "more_than_paid", total: "0.0001" });
    expect(ledger(uri("0.0001"), dust).state).toBe("ok");
    expect(ledger(uri("0.3"), [op(PAYER, PUBLIC_HOST, "0.3000000", SESSION)]).state).toBe("ok");
  });

  it("matches a payment's REF by its transaction hash, from the payer, for at least one ficha (less is dust)", () => {
    expect(ledger(uri("1", TX_MEMO), [op(PAYER, PUBLIC_HOST, "1.0000000", null, { hash: HASH })])).toMatchObject({ state: "ok", total: "1" });
    expect(ledger(uri("1", TX_MEMO), [op(PAYER, PUBLIC_HOST, "1.0000000", "hello", { hash: HASH.toUpperCase() })]).state).toBe("ok");
    expect(ledger(uri("1.5", TX_MEMO), [op(PAYER, PUBLIC_HOST, "1.0000000", null, { hash: HASH })]).state).toBe("more_than_paid");
    // The same hash prefix, from another sender: not the payer's money.
    expect(ledger(uri("1", TX_MEMO), [op(LOOKALIKE, PUBLIC_HOST, "1.0000000", null, { hash: HASH })]).state).toBe("no_payment");
    // Another transaction from the payer.
    expect(ledger(uri("1", TX_MEMO), [op(PAYER, PUBLIC_HOST, "1.0000000", null, { hash: "1a2b3c4e" + "0".repeat(56) })]).state).toBe("no_payment");
    // Dust: below one ficha (0.5 XLM) and naming no session, the station never refunds it.
    expect(ledger(uri("0.0001", TX_MEMO), [op(PAYER, PUBLIC_HOST, "0.0001000", null, { hash: HASH })]).state).toBe("no_payment");
    expect(ledger(uri("0.4999999", TX_MEMO), [op(PAYER, PUBLIC_HOST, "0.4999999", null, { hash: HASH })]).state).toBe("no_payment");
    expect(ledger(uri("0.5", TX_MEMO), [op(PAYER, PUBLIC_HOST, "0.5000000", null, { hash: HASH })]).state).toBe("ok");
  });

  it("reads the host's payments on the refund's network, with their transactions' memos", async () => {
    const urls = stubHorizon([op(PAYER, PUBLIC_HOST, "1.0000000", SESSION), op(SPAMMER, PUBLIC_HOST, "0.0001000", null)]);
    try {
      expect(await readRefundLedger(parseRefundUri(uri("0.95")), station)).toMatchObject({ state: "ok", total: "1" });
      expect(urls[0]).toBe(`https://horizon.stellar.org/accounts/${PUBLIC_HOST}/payments?join=transactions&order=desc&limit=200`);
      // A full page each time: it stops after LEDGER_PAGES, and says it did not read them all.
      stubHorizon(Array.from({ length: 200 }, () => op(SPAMMER, PUBLIC_HOST, "0.0001000", null)));
      expect(await readRefundLedger(parseRefundUri(uri("0.95")), station)).toEqual({ state: "no_payment", complete: false });
      expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(LEDGER_PAGES);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Freighter", () => {
  beforeEach(() => {
    for (const f of Object.values(freighter)) f.mockReset();
  });

  const at = (address: string, networkPassphrase: string, network = "PUBLIC") => {
    freighter.isConnected.mockResolvedValue({ isConnected: true });
    freighter.requestAccess.mockResolvedValue({ address });
    freighter.getAddress.mockResolvedValue({ address });
    freighter.getNetworkDetails.mockResolvedValue({ network, networkUrl: "https://horizon.stellar.org", networkPassphrase });
  };

  it("asks for access and reads the selected account and network", async () => {
    at(PUBLIC_HOST, Networks.PUBLIC);
    expect(await connectFreighter()).toEqual({ address: PUBLIC_HOST, network: "PUBLIC", networkPassphrase: Networks.PUBLIC });
    expect(freighter.requestAccess).toHaveBeenCalledTimes(1);
    // Right before signing: read again, without a prompt.
    expect((await readFreighter()).address).toBe(PUBLIC_HOST);
    expect(freighter.requestAccess).toHaveBeenCalledTimes(1);
    expect(freighter.getAddress).toHaveBeenCalledTimes(1);
  });

  it("says so when there is no Freighter or the host refuses access", async () => {
    freighter.isConnected.mockResolvedValue({ isConnected: false });
    await expect(connectFreighter()).rejects.toMatchObject({ code: "not_installed" });
    freighter.isConnected.mockResolvedValue({ isConnected: true });
    freighter.requestAccess.mockResolvedValue({ address: "", error: { code: -4, message: "The user rejected this request." } });
    await expect(connectFreighter()).rejects.toMatchObject({ code: "refused", message: "The user rejected this request." });
    expect(freighter.getNetworkDetails).not.toHaveBeenCalled();
  });

  it("blocks unless Freighter is on the refund's network with the station's host account", () => {
    const s = (address: string, networkPassphrase: string, network: string): FreighterSession => ({ address, network, networkPassphrase });
    expect(freighterBlocks(s(PUBLIC_HOST, Networks.PUBLIC, "PUBLIC"), NETWORKS.public, PUBLIC_HOST)).toEqual([]);
    expect(freighterBlocks(s(PUBLIC_HOST, Networks.TESTNET, "TESTNET"), NETWORKS.public, PUBLIC_HOST)).toEqual([
      { key: "wrongNetwork", vars: { got: "TESTNET", want: "MAINNET" } },
    ]);
    expect(freighterBlocks(s(PUBLIC_HOST, "Futurenet", "FUTURENET"), NETWORKS.public, PUBLIC_HOST)).toEqual([
      { key: "wrongNetwork", vars: { got: "FUTURENET", want: "MAINNET" } },
    ]);
    // The account to select, by its first 6 and last 6 characters.
    expect(freighterBlocks(s(PAYER, Networks.PUBLIC, "PUBLIC"), NETWORKS.public, PUBLIC_HOST)).toEqual([
      { key: "wrongAccount", vars: { got: "GCJC2P…E3XTN6", want: "GDVPPO…JK6ZCN" } },
    ]);
    expect(freighterBlocks(s(PAYER, Networks.TESTNET, "TESTNET"), NETWORKS.public, PUBLIC_HOST).map((b) => b.key)).toEqual(["wrongNetwork", "wrongAccount"]);
  });
});

describe("the refund transaction", () => {
  const host = Keypair.random();
  const hosted = { ...station, host_key: host.publicKey() };
  let submitted: Transaction[];

  beforeEach(() => {
    for (const f of Object.values(freighter)) f.mockReset();
    submitted = [];
    // The payer's 2.5 XLM to this host under the session, on the ledger.
    stubHorizon([op(PAYER, host.publicKey(), "2.5000000", "8DY7RJ.FAFXJXBZ")]);
    vi.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (id: string) => new Account(id, "41") as unknown as Horizon.AccountResponse);
    vi.spyOn(Horizon.Server.prototype, "feeStats").mockResolvedValue({
      last_ledger_base_fee: "100",
      ledger_capacity_usage: "0.2",
      fee_charged: { p90: "250" },
      max_fee: { mode: "100" },
    } as unknown as Horizon.HorizonApi.FeeStatsResponse);
    vi.spyOn(Horizon.Server.prototype, "submitTransaction").mockImplementation(async (tx) => {
      submitted.push(tx as Transaction);
      return { hash: "f".repeat(64), ledger: 7 } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
    });
    // Freighter signing as the host.
    freighter.signTransaction.mockImplementation(async (xdr: string, opts: { networkPassphrase: string }) => {
      const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase) as Transaction;
      tx.sign(host);
      return { signedTxXdr: tx.toXDR(), signerAddress: host.publicKey() };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("pays the payer from the host: amount, asset, memo text, network and a 180 s time bound", async () => {
    const r = parseRefundUri(uri());
    const tx = await buildRefundTx(r, host.publicKey());
    expect(tx.source).toBe(host.publicKey());
    expect(tx.sequence).toBe("42");
    expect(tx.networkPassphrase).toBe(Networks.PUBLIC);
    // The app's own fee policy (src/stellar/tx.ts feeBid): recent ledgers' p90.
    expect(tx.fee).toBe("250");
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0] as Operation.Payment;
    expect(op.type).toBe("payment");
    expect(op.source).toBeUndefined();
    expect(op.destination).toBe(PAYER);
    expect(op.amount).toBe("2.5000000");
    expect(op.asset.isNative()).toBe(true);
    expect(tx.memo.type).toBe("text");
    const memo = tx.memo.value;
    expect(typeof memo === "string" ? memo : new TextDecoder().decode(memo as Uint8Array)).toBe("refund 8DY7RJ.FAFXJXBZ");
    expect(tx.timeBounds?.minTime).toBe("0");
    const left = Number(tx.timeBounds?.maxTime) - Math.floor(Date.now() / 1000);
    expect(left).toBeGreaterThanOrEqual(178);
    expect(left).toBeLessThanOrEqual(180);
  });

  it("pays an issued asset by code and issuer, on the URI's network", async () => {
    const testnetUsdc = NETWORKS.testnet.usdc;
    const r = parseRefundUri(
      uri("0.25", MEMO, `&asset_code=USDC&asset_issuer=${testnetUsdc.issuer}&network_passphrase=${encodeURIComponent(Networks.TESTNET)}`),
    );
    const tx = await buildRefundTx(r, host.publicKey());
    expect(tx.networkPassphrase).toBe(Networks.TESTNET);
    const op = tx.operations[0] as Operation.Payment;
    expect(op.asset.getCode()).toBe("USDC");
    expect(op.asset.getIssuer()).toBe(testnetUsdc.issuer);
    expect(op.amount).toBe("0.2500000");
  });

  it("has Freighter sign it as the host on the refund's network, then submits that transaction once", async () => {
    const r = parseRefundUri(uri());
    expect(await sendRefund(r, hosted)).toEqual({ hash: "f".repeat(64), ledger: 7 });
    expect(freighter.signTransaction).toHaveBeenCalledTimes(1);
    expect(freighter.signTransaction.mock.calls[0][1]).toEqual({ networkPassphrase: Networks.PUBLIC, address: host.publicKey() });
    expect(submitted).toHaveLength(1);
    const sent = submitted[0];
    expect(sent.source).toBe(host.publicKey());
    expect((sent.operations[0] as Operation.Payment).destination).toBe(PAYER);
    expect(sent.signatures).toHaveLength(1);
    expect(host.verify(sent.hash(), sent.signatures[0].signature)).toBe(true);
  });

  it("reads the ledger again right before building, and builds nothing it does not allow", async () => {
    const r = parseRefundUri(uri("2.5000001"));
    const err = await sendRefund(r, hosted).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerBlockError);
    expect(err).toMatchObject({ check: { state: "more_than_paid", total: "2.5" } });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining(`/accounts/${host.publicKey()}/payments?join=transactions`), expect.anything());
    expect(Horizon.Server.prototype.loadAccount).not.toHaveBeenCalled();
    expect(freighter.signTransaction).not.toHaveBeenCalled();
    expect(submitted).toEqual([]);
  });

  it("signs nothing when Horizon already lists this refund, paid from anywhere", async () => {
    const r = parseRefundUri(uri());
    // Paid a minute ago, say from the phone's QR, while this page was open and its first check said ok.
    stubHorizon([op(host.publicKey(), PAYER, "2.5000000", "refund 8DY7RJ.FAFXJXBZ"), op(PAYER, host.publicKey(), "2.5000000", "8DY7RJ.FAFXJXBZ")]);
    await expect(sendRefund(r, hosted)).rejects.toMatchObject({ name: "LedgerBlockError", check: { state: "refunded", refunded: "2.5" } });
    expect(Horizon.Server.prototype.loadAccount).not.toHaveBeenCalled();
    expect(freighter.signTransaction).not.toHaveBeenCalled();
    expect(submitted).toEqual([]);
  });

  it("submits nothing when Freighter refuses, signs another transaction, or signs as another account", async () => {
    const r = parseRefundUri(uri());
    freighter.signTransaction.mockResolvedValueOnce({ signedTxXdr: "", signerAddress: "", error: { code: -4, message: "The user rejected this request." } });
    await expect(sendRefund(r, hosted)).rejects.toMatchObject({ code: "refused" });

    // A payment to another address, signed by the host: not the one the page showed.
    const stranger = Keypair.random();
    freighter.signTransaction.mockImplementationOnce(async (xdr: string, opts: { networkPassphrase: string }) => {
      const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase) as Transaction;
      const forged = new TransactionBuilder(new Account(tx.source, String(BigInt(tx.sequence) - 1n)), {
        fee: tx.fee,
        networkPassphrase: opts.networkPassphrase,
        timebounds: tx.timeBounds,
      })
        .addOperation(Operation.payment({ destination: stranger.publicKey(), asset: Asset.native(), amount: "2.5" }))
        .addMemo(tx.memo)
        .build();
      forged.sign(host);
      return { signedTxXdr: forged.toXDR(), signerAddress: host.publicKey() };
    });
    await expect(sendRefund(r, hosted)).rejects.toMatchObject({ code: "bad_signature", message: "another transaction" });

    freighter.signTransaction.mockImplementationOnce(async (xdr: string, opts: { networkPassphrase: string }) => {
      const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase) as Transaction;
      tx.sign(stranger);
      return { signedTxXdr: tx.toXDR(), signerAddress: host.publicKey() };
    });
    await expect(sendRefund(r, hosted)).rejects.toMatchObject({ code: "bad_signature", message: "no signature by the host" });

    freighter.signTransaction.mockImplementationOnce(async (xdr: string, opts: { networkPassphrase: string }) => {
      const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase) as Transaction;
      tx.sign(host);
      return { signedTxXdr: tx.toXDR(), signerAddress: stranger.publicKey() };
    });
    await expect(sendRefund(r, hosted)).rejects.toMatchObject({ code: "bad_signature", message: "signed by another account" });
    expect(submitted).toEqual([]);
  });
});

describe("the /refund page", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  it("is public: the host needs no Ficha wallet and no PIN, it signs in Freighter", () => {
    expect(read("../routes/__root.tsx")).toMatch(/const PUBLIC_PATHS = \[[^\]]*"\/refund"[^\]]*\];/);
    // A new build never reloads it under the host while a refund is being signed.
    expect(reloadIsSafe("/refund", "none")).toBe(false);
    expect(reloadIsSafe("/refund", "locked")).toBe(false);
  });

  it("has every message it shows, in every language", () => {
    const states = ["no_station", "no_registry", "unknown_station", "inactive", "custody", "asset_mismatch", "over_cap"];
    const ledger = ["no_payment", "more_than_paid", "refunded"];
    const keys = [
      ...states.map((s) => `block.${s}`),
      ...ledger.map((s) => `ledger.${s}`),
      ...["unreadable", "notAll", "dust", "ok", "paid", "refunds"].map((k) => `ledger.${k}`),
      "badLink",
      "wrongNetwork",
      "wrongAccount",
      "notInstalled",
      "refused",
      "badSignature",
      "unknownOutcome",
    ];
    const page = read("../routes/refund.tsx");
    for (const s of [...states, ...ledger]) expect(page, s).toContain(`case "${s}":`);
    for (const lang of LANGS) for (const k of keys) expect(DICTS[lang][`refund.${k}`], `${lang} ${k}`).toBeTruthy();
  });
});
