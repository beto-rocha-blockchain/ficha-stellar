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
import { buildRefundTx, connectFreighter, freighterBlocks, readFreighter, sendRefund, type FreighterSession } from "./freighter";
import { RefundError, checkRefund, parseRefundRef, parseRefundUri, refundCap } from "./request";

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
  let submitted: Transaction[];

  beforeEach(() => {
    for (const f of Object.values(freighter)) f.mockReset();
    submitted = [];
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

  afterEach(() => vi.restoreAllMocks());

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
    expect(await sendRefund(r, host.publicKey())).toEqual({ hash: "f".repeat(64), ledger: 7 });
    expect(freighter.signTransaction).toHaveBeenCalledTimes(1);
    expect(freighter.signTransaction.mock.calls[0][1]).toEqual({ networkPassphrase: Networks.PUBLIC, address: host.publicKey() });
    expect(submitted).toHaveLength(1);
    const sent = submitted[0];
    expect(sent.source).toBe(host.publicKey());
    expect((sent.operations[0] as Operation.Payment).destination).toBe(PAYER);
    expect(sent.signatures).toHaveLength(1);
    expect(host.verify(sent.hash(), sent.signatures[0].signature)).toBe(true);
  });

  it("submits nothing when Freighter refuses, signs another transaction, or signs as another account", async () => {
    const r = parseRefundUri(uri());
    freighter.signTransaction.mockResolvedValueOnce({ signedTxXdr: "", signerAddress: "", error: { code: -4, message: "The user rejected this request." } });
    await expect(sendRefund(r, host.publicKey())).rejects.toMatchObject({ code: "refused" });

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
    await expect(sendRefund(r, host.publicKey())).rejects.toMatchObject({ code: "bad_signature", message: "another transaction" });

    freighter.signTransaction.mockImplementationOnce(async (xdr: string, opts: { networkPassphrase: string }) => {
      const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase) as Transaction;
      tx.sign(stranger);
      return { signedTxXdr: tx.toXDR(), signerAddress: host.publicKey() };
    });
    await expect(sendRefund(r, host.publicKey())).rejects.toMatchObject({ code: "bad_signature", message: "no signature by the host" });

    freighter.signTransaction.mockImplementationOnce(async (xdr: string, opts: { networkPassphrase: string }) => {
      const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase) as Transaction;
      tx.sign(host);
      return { signedTxXdr: tx.toXDR(), signerAddress: stranger.publicKey() };
    });
    await expect(sendRefund(r, host.publicKey())).rejects.toMatchObject({ code: "bad_signature", message: "signed by another account" });
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
    const keys = [...states.map((s) => `block.${s}`), "badLink", "wrongNetwork", "wrongAccount", "notInstalled", "refused", "badSignature", "unknownOutcome"];
    const page = read("../routes/refund.tsx");
    for (const s of states) expect(page, s).toContain(`case "${s}":`);
    for (const lang of LANGS) for (const k of keys) expect(DICTS[lang][`refund.${k}`], `${lang} ${k}`).toBeTruthy();
  });
});
