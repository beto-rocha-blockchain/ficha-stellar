import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORKS } from "@/config";
import type { Registry } from "@/registry/verify";
import { checkAgainstRegistry, fichasLeft, fichasPaid } from "./check";
import { classifyQr, linkRoute } from "./qr";
import { estimatedEnd, formatMmss } from "./format";
import {
  crossCheckReceipt,
  cursorAfter,
  fetchMyPayments,
  fetchReceiptPayments,
  fetchSessionPayments,
  groupSessions,
  mayBeShared,
  othersFor,
  receiptShareFraction,
  receiptStanding,
  recheckReceipt,
  sessionHosts,
  type HostPayment,
  type MyPayment,
} from "./history";
import { ReceiptError, isReceiptUri, parseReceipt, unusedSeconds } from "./receipt";
import { Sep7Error, parseFichaMemo, parseSep7Pay, requestPassphrase } from "./sep7";

const HOST = "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
// Exactly what stellar.py sep7_uri() emits (urlencode with quote).
const STATION_URI =
  `web+stellar:pay?destination=${HOST}&amount=1&memo=ERZGCG.F3H9TXAB&memo_type=MEMO_TEXT` +
  `&network_passphrase=Test%20SDF%20Network%20%3B%20September%202015` +
  `&msg=${encodeURIComponent("Ficha Demo bench · session ERZGCG.F3H9TXAB")}`;

describe("SEP-0007 pay", () => {
  it("parses the station's native XLM QR", () => {
    const r = parseSep7Pay(STATION_URI);
    expect(r.destination).toBe(HOST);
    expect(r.amount).toBe("1");
    expect(r.asset).toEqual({ code: "XLM", issuer: null });
    expect(r.memo).toBe("ERZGCG.F3H9TXAB");
    expect(r.msg).toBe("Ficha Demo bench · session ERZGCG.F3H9TXAB");
    // SEP-0007: no passphrase would mean the public network.
    expect(r.networkPassphrase).toBe(NETWORKS.testnet.passphrase);
  });

  it("parses an issued asset", () => {
    const r = parseSep7Pay(`web+stellar:pay?destination=${HOST}&amount=0.25&asset_code=USDC&asset_issuer=${USDC_ISSUER}&memo=F3H9TXAB`);
    expect(r.asset).toEqual({ code: "USDC", issuer: USDC_ISSUER });
    expect(r.amount).toBe("0.25");
  });

  it("rejects what the app must not pay", () => {
    const bad = (uri: string, code: Sep7Error["code"]) => {
      let err: unknown = null;
      try {
        parseSep7Pay(uri);
      } catch (e) {
        err = e;
      }
      expect(err, uri).toBeInstanceOf(Sep7Error);
      expect((err as Sep7Error).code, uri).toBe(code);
    };
    bad("web+stellar:tx?xdr=AAAA", "not_pay");
    bad("https://example.org/pay?destination=x", "not_pay");
    bad("web+stellar:pay?destination=GBAD&amount=1&memo=F3H9TXAB", "bad_destination");
    bad(`web+stellar:pay?destination=${HOST}&amount=-1&memo=F3H9TXAB`, "bad_amount");
    bad(`web+stellar:pay?destination=${HOST}&amount=1e3&memo=F3H9TXAB`, "bad_amount");
    bad(`web+stellar:pay?destination=${HOST}&amount=1.12345678&memo=F3H9TXAB`, "bad_amount");
    bad(`web+stellar:pay?destination=${HOST}&amount=1`, "no_memo");
    bad(`web+stellar:pay?destination=${HOST}&amount=1&memo=123&memo_type=MEMO_ID`, "memo_type");
    bad(`web+stellar:pay?destination=${HOST}&amount=1&memo=${"A".repeat(29)}`, "memo_too_long");
    bad(`web+stellar:pay?destination=${HOST}&amount=1&asset_code=USDC&memo=F3H9TXAB`, "bad_asset");
  });

  it("reads Ficha memos", () => {
    expect(parseFichaMemo("ERZGCG.F3H9TXAB")).toEqual({ kind: "station", stationId: "ERZGCG", session: "F3H9TXAB", memo: "ERZGCG.F3H9TXAB" });
    expect(parseFichaMemo("F3H9TXAB")).toEqual({ kind: "legacy", session: "F3H9TXAB", memo: "F3H9TXAB" });
    expect(parseFichaMemo("ERZGC0.F3H9TXAB")).toBeNull(); // 0 is not in the alphabet
    expect(parseFichaMemo("ERZGCG.X3H9TXAB")).toBeNull();
    expect(parseFichaMemo("hello")).toBeNull();
  });
});

const RECEIPT_Q = `v=1&m=ERZGCG.F3H9TXAB&n=t&h=${HOST}&a=3&k=XLM&f=3&p=900&u=842&wh=4.250&x=1830&vd=d&c=1&t=1790000000`;

describe("QR against the signed registry", () => {
  const station = {
    id: "ERZGCG",
    name: "Demo bench",
    host_key: HOST,
    asset: { code: "XLM", issuer: null },
    ficha_price: "1",
    ficha_minutes: 5,
    max_session_minutes: 60,
    active: true,
  };
  const reg: Registry = { format: "ficha-registry/1", issued_at: "2026-09-30T00:00:00Z", network: "testnet", stations: [station] };
  const check = (uri: string) => {
    const req = parseSep7Pay(uri);
    return checkAgainstRegistry(req, parseFichaMemo(req.memo)!, reg, NETWORKS.testnet).state;
  };

  it("accepts the station's own QR", () => {
    expect(check(STATION_URI)).toBe("ok");
    expect(check(STATION_URI.replace("amount=1&", "amount=1.0&"))).toBe("ok");
  });

  it("blocks a QR whose price is not the registry's (the station credits by its own price)", () => {
    expect(check(STATION_URI.replace("amount=1&", "amount=2&"))).toBe("price_mismatch");
    expect(check(STATION_URI.replace("amount=1&", "amount=0.5&"))).toBe("price_mismatch");
    const legacy = STATION_URI.replace("ERZGCG.F3H9TXAB", "F3H9TXAB");
    expect(check(legacy)).toBe("legacy");
    expect(check(legacy.replace("amount=1&", "amount=2&"))).toBe("price_mismatch");
  });

  it("counts what this wallet already paid for the session against the session cap", () => {
    // 1 XLM per 5 min, 60 min per session: 12 fichas in all.
    expect(fichasLeft(station, [])).toBe(12);
    expect(fichasLeft(station, [{ amount: "6" }])).toBe(6);
    expect(fichasLeft(station, [{ amount: "12" }])).toBe(0);
    expect(fichasLeft(station, [{ amount: "10" }, { amount: "5" }])).toBe(0);
    // The station floors each payment on its own: 2.5 + 0.5 buys 2 fichas, not 3.
    expect(fichasPaid([{ amount: "2.5" }, { amount: "0.5" }], "1")).toBe(2);
    expect(fichasLeft(station, [{ amount: "2.5" }, { amount: "0.5" }])).toBe(10);
  });

  it("blocks a legacy QR to the host key of a station the registry disables, as its own QR is", () => {
    const off: Registry = { ...reg, stations: [{ ...station, active: false }] };
    const at = (uri: string, r: Registry) => {
      const req = parseSep7Pay(uri);
      return checkAgainstRegistry(req, parseFichaMemo(req.memo)!, r, NETWORKS.testnet);
    };
    const legacy = STATION_URI.replace("ERZGCG.F3H9TXAB", "F3H9TXAB");
    expect(at(STATION_URI, off)).toEqual({ state: "inactive", stationId: "ERZGCG" });
    expect(at(legacy, off)).toEqual({ state: "inactive", stationId: "ERZGCG" });
    // One active station at the host key still answers for a legacy QR.
    const mixed: Registry = { ...reg, stations: [{ ...station, id: "K7M2QX", active: false }, station] };
    expect(at(legacy, mixed)).toMatchObject({ state: "legacy", station: { id: "ERZGCG" } });
    // No station at all for this host key: still the legacy override, one ficha.
    expect(at(legacy.replace(`destination=${HOST}`, `destination=${USDC_ISSUER}`), off)).toEqual({ state: "legacy", station: null });
  });

  it("never pays a custody station directly: only its pay link deposits (contract §4)", () => {
    const custody: Registry = {
      ...reg,
      stations: [{ ...station, mode: "custody", escrow: "CBRNN2W726PIWP7DLLCAOW663I2TBSMR6N7J7S4CGGUIWIXK4HYI6KYC", unit_seconds: 30, grace_seconds: 1680 }],
    };
    const at = (uri: string) => {
      const req = parseSep7Pay(uri);
      return checkAgainstRegistry(req, parseFichaMemo(req.memo)!, custody, NETWORKS.testnet);
    };
    expect(at(STATION_URI)).toEqual({ state: "custody_only", stationId: "ERZGCG" });
    // A legacy QR to its host key is not the custody station's (it always has an ID).
    expect(at(STATION_URI.replace("ERZGCG.F3H9TXAB", "F3H9TXAB"))).toEqual({ state: "legacy", station: null });
  });

  it("blocks another destination or asset, and unknown stations", () => {
    expect(check(STATION_URI.replace(`destination=${HOST}`, `destination=${USDC_ISSUER}`))).toBe("mismatch");
    expect(check(STATION_URI.replace("ERZGCG.", "K7M2QX."))).toBe("unknown_station");
    expect(check(STATION_URI.replace("&memo=", `&asset_code=USDC&asset_issuer=${USDC_ISSUER}&memo=`))).toBe("asset_mismatch");
  });

  describe("a QR without a station code (legacy)", () => {
    const legacy = STATION_URI.replace("ERZGCG.F3H9TXAB", "F3H9TXAB");
    // On the public network the station leaves network_passphrase out (stellar.py sep7_uri).
    const mainnet = legacy.replace(/&network_passphrase=[^&]*/, "");
    const pub: Registry = { ...reg, network: "public", stations: [{ ...station, ficha_price: "0.5" }] };
    const at = (uri: string, r: Registry | null, net: keyof typeof NETWORKS) => {
      const req = parseSep7Pay(uri);
      return checkAgainstRegistry(req, parseFichaMemo(req.memo)!, r, NETWORKS[net]);
    };

    it("on Mainnet with no registry is blocked (none is published for the public network yet)", () => {
      expect(at(mainnet, null, "public")).toEqual({ state: "no_registry", stationId: null });
      expect(at(mainnet.replace("amount=1&", ""), null, "public")).toEqual({ state: "no_registry", stationId: null });
    });

    it("on Mainnet to an address the registry does not list as exactly one station is blocked", () => {
      expect(at(mainnet.replace(`destination=${HOST}`, `destination=${USDC_ISSUER}`), pub, "public")).toEqual({ state: "unlisted" });
      // Listed, but in another asset, or only as a custody station.
      expect(at(mainnet.replace("&memo=", `&asset_code=USDC&asset_issuer=${USDC_ISSUER}&memo=`), pub, "public")).toEqual({ state: "unlisted" });
      const custody: Registry = { ...pub, stations: [{ ...pub.stations[0], mode: "custody", escrow: "C", unit_seconds: 30, grace_seconds: 1680 }] };
      expect(at(mainnet, custody, "public")).toEqual({ state: "unlisted" });
      // Two active stations at one address: which one the QR is for cannot be told.
      const two: Registry = { ...pub, stations: [pub.stations[0], { ...pub.stations[0], id: "K7M2QX" }] };
      expect(at(mainnet, two, "public")).toEqual({ state: "unlisted" });
      // A disabled station stays disabled.
      expect(at(mainnet, { ...pub, stations: [{ ...pub.stations[0], active: false }] }, "public")).toEqual({ state: "inactive", stationId: "ERZGCG" });
    });

    it("on Mainnet to the one listed station is paid at the registry's price, not the QR's", () => {
      const ok = at(mainnet.replace("amount=1&", ""), pub, "public");
      expect(ok).toMatchObject({ state: "legacy", station: { id: "ERZGCG", ficha_price: "0.5" } });
      expect(at(mainnet.replace("amount=1&", "amount=0.5&"), pub, "public")).toMatchObject({ state: "legacy", station: { id: "ERZGCG" } });
      expect(at(mainnet, pub, "public")).toMatchObject({ state: "price_mismatch", station: { id: "ERZGCG" } });
    });

    it("on the testnet is paid as before: the QR's own amount when no station is listed", () => {
      expect(at(legacy, null, "testnet")).toEqual({ state: "legacy", station: null });
      expect(at(legacy.replace(`destination=${HOST}`, `destination=${USDC_ISSUER}`), reg, "testnet")).toEqual({ state: "legacy", station: null });
      expect(at(legacy, reg, "testnet")).toMatchObject({ state: "legacy", station: { id: "ERZGCG" } });
      const two: Registry = { ...reg, stations: [station, { ...station, id: "K7M2QX" }] };
      expect(at(legacy, two, "testnet")).toEqual({ state: "legacy", station: null });
    });
  });

  it("reads a QR without network_passphrase as a Mainnet request (SEP-0007), never as 'any network'", () => {
    const mainnet = STATION_URI.replace(/&network_passphrase=[^&]*/, "");
    const pub: Registry = { ...reg, network: "public" };
    const at = (uri: string, r: Registry | null, net: keyof typeof NETWORKS) => {
      const req = parseSep7Pay(uri);
      return checkAgainstRegistry(req, parseFichaMemo(req.memo)!, r, NETWORKS[net]).state;
    };
    expect(requestPassphrase(parseSep7Pay(mainnet))).toBe(NETWORKS.public.passphrase);
    // A Mainnet QR in a testnet app, and a testnet QR in a Mainnet app.
    expect(at(mainnet, reg, "testnet")).toBe("wrong_network");
    expect(at(mainnet.replace("ERZGCG.F3H9TXAB", "F3H9TXAB"), reg, "testnet")).toBe("wrong_network");
    expect(at(STATION_URI, pub, "public")).toBe("wrong_network");
    expect(at(STATION_URI, null, "public")).toBe("wrong_network");
    // The Mainnet QR in a Mainnet app goes on to the registry.
    expect(at(mainnet, pub, "public")).toBe("ok");
    expect(at(mainnet, null, "public")).toBe("no_registry");
    expect(at(mainnet.replace(`destination=${HOST}`, `destination=${USDC_ISSUER}`), pub, "public")).toBe("mismatch");
  });
});

describe("receipt QR", () => {
  it("parses the ficha: and https forms identically", () => {
    const a = parseReceipt(`ficha:/r?${RECEIPT_Q}`);
    const b = parseReceipt(`https://app.example.org/r?${RECEIPT_Q}`);
    const c = parseReceipt(`?${RECEIPT_Q}`);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a).toEqual({
      memo: "ERZGCG.F3H9TXAB",
      network: "testnet",
      hostKey: HOST,
      amount: "3",
      assetCode: "XLM",
      fichas: 3,
      paidSeconds: 900,
      usedSeconds: 842,
      wh: 4.25,
      maxMa: 1830,
      verdict: "delivered",
      cutConfirmed: true,
      finishedAt: 1790000000,
    });
  });

  it("keeps decimal amounts as exact strings", () => {
    expect(parseReceipt(`ficha:/r?${RECEIPT_Q.replace("a=3", "a=0.1500000")}`).amount).toBe("0.1500000");
  });

  it("rejects incomplete or wrong receipts", () => {
    expect(() => parseReceipt(`ficha:/r?${RECEIPT_Q.replace("vd=d", "vd=z")}`)).toThrow(ReceiptError);
    expect(() => parseReceipt(`ficha:/r?${RECEIPT_Q.replace("v=1", "v=2")}`)).toThrow(ReceiptError);
    expect(() => parseReceipt(`ficha:/r?${RECEIPT_Q.replace(`h=${HOST}`, "h=GBAD")}`)).toThrow(ReceiptError);
    expect(() => parseReceipt(`ficha:/r?${RECEIPT_Q.replace("&wh=4.250", "")}`)).toThrow(ReceiptError);
  });

  it("reports every second of paid time not delivered, even under a minute", () => {
    // paused_too_long 30 s into a 1-minute ficha: the station logs 0.5 ficha for refund.
    expect(unusedSeconds(parseReceipt(`ficha:/r?${RECEIPT_Q.replace("p=900", "p=60").replace("u=842", "u=30")}`))).toBe(30);
    expect(unusedSeconds(parseReceipt(`ficha:/r?${RECEIPT_Q}`))).toBe(58);
    expect(unusedSeconds(parseReceipt(`ficha:/r?${RECEIPT_Q.replace("u=842", "u=900")}`))).toBe(0);
    expect(unusedSeconds({ paidSeconds: 60, usedSeconds: 61 })).toBe(0);
    expect(formatMmss(30)).toBe("0:30");
    expect(formatMmss(90)).toBe("1:30");
  });

  it("recognizes receipt URIs only", () => {
    expect(isReceiptUri(`ficha:/r?${RECEIPT_Q}`)).toBe(true);
    expect(isReceiptUri(`https://app.example.org/sub/r?${RECEIPT_Q}`)).toBe(true);
    expect(isReceiptUri(`https://app.example.org/bar?${RECEIPT_Q}`)).toBe(false);
    expect(isReceiptUri("https://example.org/r?x=1")).toBe(false);
  });
});

describe("QR routing", () => {
  it("classifies station QRs", () => {
    expect(classifyQr(STATION_URI)).toEqual({ kind: "pay", uri: STATION_URI });
    expect(classifyQr(`ficha:/r?${RECEIPT_Q}`)).toEqual({ kind: "receipt", search: RECEIPT_Q });
    expect(classifyQr("WIFI:T:WPA;S:Ficha\\;Guest;P:p\\:ss;;")).toEqual({ kind: "wifi", ssid: "Ficha;Guest", password: "p:ss" });
    expect(classifyQr("WIFI:T:nopass;S:Open;P:;;")).toEqual({ kind: "wifi", ssid: "Open", password: null });
    expect(classifyQr("hello").kind).toBe("unknown");
  });

  it("opens a pay QR on Pay and a receipt on Receipt (the scanner and the Android links alike)", () => {
    expect(linkRoute(STATION_URI)).toBe(`/pay?uri=${encodeURIComponent(STATION_URI)}`);
    expect(new URLSearchParams(linkRoute(STATION_URI)!.split("?").slice(1).join("?")).get("uri")).toBe(STATION_URI);
    for (const u of [`ficha:/r?${RECEIPT_Q}`, `https://ficha-stellar.vercel.app/r?${RECEIPT_Q}`]) expect(linkRoute(u)).toBe(`/r?${RECEIPT_Q}`);
    expect(linkRoute("WIFI:T:nopass;S:Open;P:;;")).toBeNull();
    expect(linkRoute("https://ficha-stellar.vercel.app/registry/stations.json")).toBeNull();
  });
});

describe("sessions and cross-check", () => {
  const pay = (over: Partial<MyPayment>): MyPayment => ({
    id: "1",
    txHash: "h1",
    createdAt: "2026-09-30T10:00:00Z",
    to: HOST,
    amount: "1",
    assetCode: "XLM",
    assetIssuer: null,
    memo: "ERZGCG.F3H9TXAB",
    ...over,
  });

  it("groups payments by memo and ignores other destinations and non-session memos", () => {
    const rows = groupSessions(
      [
        pay({ id: "3", txHash: "h3", amount: "2", createdAt: "2026-09-30T10:05:00Z" }),
        pay({ id: "1" }),
        pay({ id: "2", to: USDC_ISSUER }),
        pay({ id: "4", memo: null }),
        pay({ id: "5", memo: "coffee" }),
        pay({ id: "6", memo: "ERZGCG.coffee" }),
      ],
      new Set([HOST]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memo: "ERZGCG.F3H9TXAB", stationId: "ERZGCG", amount: "3", startedAt: "2026-09-30T10:00:00Z" });
    // A legacy (unprefixed) session memo is still a session.
    expect(groupSessions([pay({ memo: "F3H9TXAB" })], new Set([HOST]))).toMatchObject([{ memo: "F3H9TXAB", stationId: null }]);
  });

  it("lists a payment to a legacy station outside the registry (the pay screen allows it and points to History)", () => {
    const legacy = pay({ id: "7", to: USDC_ISSUER, memo: "F3H9TXAB" });
    const coffee = pay({ id: "8", to: USDC_ISSUER, memo: "coffee" });
    expect(groupSessions([legacy, coffee], new Set([HOST]))).toEqual([]);
    const hosts = sessionHosts(new Set([HOST]), [legacy, coffee]);
    expect(hosts).toEqual(new Set([HOST, USDC_ISSUER]));
    expect(groupSessions([legacy, coffee], hosts)).toMatchObject([{ memo: "F3H9TXAB", stationId: null, hostKey: USDC_ISSUER, amount: "1" }]);
    // Without a legacy memo, an address outside the registry is still not a station.
    expect(sessionHosts([HOST], [coffee, pay({ id: "9", to: USDC_ISSUER, memo: "ERZGCG.F3H9TXAB" })])).toEqual(new Set([HOST]));
  });

  it("confirms a receipt only when the user's payments add up", () => {
    const r = parseReceipt(`ficha:/r?${RECEIPT_Q}`);
    expect(crossCheckReceipt(r, [pay({ amount: "1" }), pay({ amount: "2" })]).check).toBe("confirmed");
    expect(crossCheckReceipt(r, [pay({ amount: "1" })])).toMatchObject({ check: "not_confirmed", reason: "amountDiffers" });
    expect(crossCheckReceipt(r, [pay({ amount: "3", to: USDC_ISSUER })])).toMatchObject({ check: "not_confirmed", reason: "noPayment" });
    expect(crossCheckReceipt(r, [])).toMatchObject({ check: "not_confirmed", reason: "noPayment" });
  });

  it("confirms later a receipt scanned offline, once its payments are fetched", () => {
    const offline = { receipt: parseReceipt(`ficha:/r?${RECEIPT_Q}`), check: "not_confirmed" as const, reason: "offline", savedAt: 1 };
    expect(recheckReceipt(offline, [pay({ amount: "3" })])).toEqual({ ...offline, check: "confirmed", reason: undefined, share: "3" });
    expect(recheckReceipt(offline, [pay({ amount: "2" })])).toBe(offline);
    expect(recheckReceipt(offline, [])).toBe(offline);
    const confirmed = { ...offline, check: "confirmed" as const, reason: undefined };
    expect(recheckReceipt(confirmed, [])).toBe(confirmed);
  });

  it("shows a confirmed receipt as confirmed only while the session total still matches it", () => {
    const confirmed = { receipt: parseReceipt(`ficha:/r?${RECEIPT_Q}`), check: "confirmed" as const, savedAt: 1 };
    const row = (ps: MyPayment[]) => groupSessions(ps, new Set([HOST]))[0];
    const credited = [pay({ id: "1", amount: "1" }), pay({ id: "2", amount: "2" })];
    expect(receiptStanding(row(credited), confirmed)).toEqual({ state: "confirmed" });
    // The old QR paid again after the session closed: the station logged it as orphan.
    const stale = pay({ id: "3", txHash: "h3", amount: "1", createdAt: "2026-09-30T11:00:00Z" });
    expect(receiptStanding(row([stale, ...credited]), confirmed)).toEqual({ state: "uncredited", extra: "1" });
    expect(receiptStanding(row([pay({ amount: "2" })]), confirmed)).toEqual({ state: "not_confirmed" });
    expect(receiptStanding(row([stale, ...credited]), { ...confirmed, check: "not_confirmed", reason: "amountDiffers" })).toEqual({ state: "not_confirmed" });
  });

  it("flags a payment made in the last seconds of the session, which closed on the ledger after the receipt, as not credited", () => {
    // 1 ficha paid, then 'Add fichas' paid with 3 s left: the ledger closed it
    // after FINISHED and the station logged it as orphan. Its receipt (a=1) is
    // only scanned after that, so the wallet's total (2) never matched it.
    const t = Date.parse("2026-09-30T10:05:24Z") / 1000;
    const r = parseReceipt(`ficha:/r?${RECEIPT_Q.replace("a=3", "a=1").replace("t=1790000000", `t=${t}`)}`);
    const credited = pay({ id: "1", amount: "1.0000000", createdAt: "2026-09-30T10:04:20Z" });
    const late = pay({ id: "2", txHash: "h2", amount: "1.0000000", createdAt: "2026-09-30T10:05:27Z" });
    expect(crossCheckReceipt(r, [late, credited])).toMatchObject({ check: "confirmed", uncredited: "1" });
    // Up to the finish second the payment was still the session's: no split.
    expect(crossCheckReceipt(r, [{ ...late, createdAt: "2026-09-30T10:05:24Z" }, credited])).toMatchObject({ check: "not_confirmed", reason: "amountDiffers" });
    // The payments up to the finish must still add up to the receipt.
    expect(crossCheckReceipt(r, [late, { ...late, id: "4", txHash: "h4" }])).toMatchObject({ check: "not_confirmed", reason: "amountDiffers" });
    const early = pay({ id: "3", txHash: "h3", amount: "1", createdAt: "2026-09-30T10:04:00Z" });
    expect(crossCheckReceipt(r, [late, credited, early])).toMatchObject({ check: "not_confirmed", reason: "amountDiffers" });
    // History: a receipt stored as not confirmed is confirmed on the next load and shows the refund hint.
    const stored = { receipt: r, check: "not_confirmed" as const, reason: "amountDiffers", savedAt: 1 };
    const rechecked = recheckReceipt(stored, [late, credited]);
    expect(rechecked).toEqual({ ...stored, check: "confirmed", reason: undefined, share: "1" });
    expect(receiptStanding(groupSessions([late, credited], new Set([HOST]))[0], rechecked)).toEqual({ state: "uncredited", extra: "1" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the path payments the station credits, and only this account's", async () => {
    const ME = USDC_ISSUER;
    const rec = (over: Record<string, unknown>) => ({
      id: "1",
      type: "payment",
      transaction_successful: true,
      transaction_hash: "h",
      created_at: "2026-09-30T10:00:00Z",
      from: ME,
      to: HOST,
      amount: "3.0000000",
      asset_type: "native",
      transaction: { memo_type: "text", memo: "ERZGCG.F3H9TXAB" },
      ...over,
    });
    const records = [
      rec({ id: "1" }),
      // Horizon's amount/asset_* are the destination side of a path payment.
      rec({ id: "2", type: "path_payment_strict_send", source_amount: "0.5", source_asset_type: "credit_alphanum4" }),
      rec({ id: "3", type: "path_payment_strict_receive", source_amount: "0.6", source_asset_type: "credit_alphanum4" }),
      rec({ id: "4", type: "create_account" }),
      rec({ id: "5", from: HOST, to: ME }),
      rec({ id: "6", type: "path_payment_strict_send", transaction_successful: false }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ _embedded: { records } }))));
    const ps = await fetchMyPayments(NETWORKS.testnet, ME, 1);
    expect(ps.map((p) => p.id)).toEqual(["1", "2", "3"]);
    expect(ps[1]).toMatchObject({ to: HOST, amount: "3.0000000", assetCode: "XLM", memo: "ERZGCG.F3H9TXAB" });
    const receipt = parseReceipt(`ficha:/r?${RECEIPT_Q}`);
    expect(crossCheckReceipt(receipt, [ps[1]]).check).toBe("confirmed");
  });

  it("counts another wallet's payments to the session against the session cap", async () => {
    const ME = USDC_ISSUER;
    const A = "GBC2MDBTM4MX3XJKRX5QM3YXUR2AISCOJGJ74MXLPIZHZDIDHOLFAASA";
    const memo = "ERZGCG.F3H9TXAB";
    const rec = (over: Record<string, unknown>) => ({
      id: "1",
      type: "payment",
      transaction_successful: true,
      transaction_hash: "h",
      created_at: "2026-09-30T10:00:00Z",
      from: A,
      to: HOST,
      amount: "6.0000000",
      asset_type: "native",
      transaction: { memo_type: "text", memo },
      ...over,
    });
    const records = [
      rec({ id: "1" }),
      rec({ id: "2", from: ME, amount: "1.0000000" }),
      rec({ id: "3", transaction: { memo_type: "text", memo: "ERZGCG.FN5V96VP" } }),
      rec({ id: "4", from: HOST, to: A }),
      rec({ id: "5", transaction_successful: false }),
      rec({ id: "6", type: "create_account" }),
      rec({ id: "7", asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER }),
    ];
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ _embedded: { records } })));
    vi.stubGlobal("fetch", fetchMock);
    const session = await fetchSessionPayments(NETWORKS.testnet, HOST, memo);
    // The host's payments, not this wallet's: that is where every payer shows.
    expect(fetchMock.mock.calls[0][0]).toContain(`/accounts/${HOST}/payments?join=transactions`);
    expect(session.map((p) => p.id)).toEqual(["1", "2", "7"]);
    // Another asset buys nothing at the station; this wallet's own come from fetchMyPayments.
    const others = othersFor(session, ME, { code: "XLM", issuer: null });
    expect(others.map((p) => p.id)).toEqual(["1"]);
    const station = { id: "ERZGCG", name: "Demo bench", host_key: HOST, asset: { code: "XLM", issuer: null }, ficha_price: "1", ficha_minutes: 5, max_session_minutes: 60, active: true };
    // Wallet A paid 6 of the 12 fichas: wallet B, with no payment of its own, may add only 6.
    expect(fichasLeft(station, others)).toBe(6);
    expect(fichasLeft(station, [pay({ amount: "1" }), ...others])).toBe(5);
    expect(fichasLeft(station, [...others, pay({ id: "8", amount: "6" })])).toBe(0);
  });
});

describe("receipt of a session paid by several wallets", () => {
  const ME = USDC_ISSUER;
  const FRIEND = "GBC2MDBTM4MX3XJKRX5QM3YXUR2AISCOJGJ74MXLPIZHZDIDHOLFAASA";
  const memo = "ERZGCG.F3H9TXAB";
  const finished = Date.parse("2026-09-30T10:20:00Z") / 1000;
  // 3 fichas (15 min) in all; the session finished at 10:20.
  const r = parseReceipt(`ficha:/r?${RECEIPT_Q.replace("t=1790000000", `t=${finished}`)}`);
  const XLM = { code: "XLM", issuer: null };
  const pay = (over: Partial<HostPayment>): HostPayment => ({
    id: "1",
    txHash: "h1",
    createdAt: "2026-09-30T10:05:00Z",
    from: ME,
    to: HOST,
    amount: "1.0000000",
    assetCode: "XLM",
    assetIssuer: null,
    memo,
    ...over,
  });
  const mine = pay({ id: "11" });
  const friend = pay({ id: "12", txHash: "h12", from: FRIEND, amount: "2.0000000", createdAt: "2026-09-30T10:06:00Z" });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("single payer: the user's own payments are the whole receipt", () => {
    const own = [pay({ id: "1", amount: "1" }), pay({ id: "2", amount: "2" })];
    expect(mayBeShared(r, own)).toBe(false);
    expect(crossCheckReceipt(r, own)).toMatchObject({ check: "confirmed", share: "3", total: "3" });
    // The host's list adds nothing when the user alone paid.
    expect(crossCheckReceipt(r, own, { payments: own, asset: XLM, fichaPrice: "1" })).toMatchObject({ check: "confirmed", share: "3", total: "3" });
  });

  it("two payers: every wallet's payments to the host with the memo add up; the user sees their share", () => {
    expect(crossCheckReceipt(r, [mine])).toMatchObject({ check: "not_confirmed", reason: "amountDiffers" });
    expect(mayBeShared(r, [mine])).toBe(true);
    // The host's list holds the user's own payment too: it is counted once.
    const c = crossCheckReceipt(r, [mine], { payments: [friend, mine], asset: XLM, fichaPrice: "1" });
    expect(c).toMatchObject({ check: "confirmed", share: "1", total: "3" });
    expect(c.uncredited).toBeUndefined();
    // Horizon lagging on the host's list: the user's own payment still counts.
    expect(crossCheckReceipt(r, [mine], { payments: [friend] }).check).toBe("confirmed");
    // History: the row is the user's own money only, and matches the share kept with the receipt.
    const row = groupSessions([mine], new Set([HOST]))[0];
    expect(row.amount).toBe("1.0000000");
    const stored = recheckReceipt({ receipt: r, check: "not_confirmed", reason: "amountDiffers", savedAt: 1 }, [mine], { payments: [friend, mine] });
    expect(stored).toMatchObject({ check: "confirmed", share: "1", reason: undefined });
    expect(receiptStanding(row, stored)).toEqual({ state: "confirmed" });
  });

  it("History gives each payer its share of the session's unused time and energy, not the whole", () => {
    // 1 of 3 XLM: a third of the 900 s paid; 600 s unused -> 200 s (3:20) for this wallet.
    const idle = { ...r, paidSeconds: 900, usedSeconds: 300 };
    const part = receiptShareFraction({ receipt: idle, check: "confirmed", share: "1" });
    expect(part).toBeCloseTo(1 / 3);
    expect(formatMmss(Math.round(unusedSeconds(idle) * part))).toBe("3:20");
    // Paid alone, an older receipt with no share, or not confirmed: the whole session.
    expect(receiptShareFraction({ receipt: r, check: "confirmed", share: "3" })).toBe(1);
    expect(receiptShareFraction({ receipt: r, check: "confirmed" })).toBe(1);
    expect(receiptShareFraction({ receipt: r, check: "not_confirmed", share: "1" })).toBe(1);
  });

  it("mismatch: what the station credits on the ledger does not add up to the receipt", () => {
    const short = pay({ ...friend, amount: "1.0000000" });
    expect(crossCheckReceipt(r, [mine], { payments: [short, mine] })).toMatchObject({ check: "not_confirmed", reason: "amountDiffers" });
    // Another asset (refused), below one ficha (underpaid), another memo or a fake XLM: not credited, not counted.
    const usdc = pay({ ...friend, id: "13", assetCode: "USDC", assetIssuer: USDC_ISSUER });
    const tiny = pay({ ...friend, id: "14", amount: "0.5000000" });
    const other = pay({ ...friend, id: "15", memo: "ERZGCG.FN5V96VP" });
    const fake = pay({ ...friend, id: "16", assetIssuer: FRIEND });
    for (const extra of [usdc, tiny, other, fake]) {
      expect(crossCheckReceipt(r, [mine], { payments: [short, extra, mine], asset: XLM, fichaPrice: "1" }).check, extra.id).toBe("not_confirmed");
    }
    // Too much on the ledger is a mismatch too.
    expect(crossCheckReceipt(r, [mine], { payments: [friend, pay({ ...friend, id: "17" }), mine] }).check).toBe("not_confirmed");
    // Nothing of the user's in the session: another wallet's receipt.
    expect(crossCheckReceipt(r, [], { payments: [friend, mine] })).toMatchObject({ check: "not_confirmed", reason: "noPayment" });
  });

  it("orphan after the receipt: a payment that closed after the finish is not credited, whoever paid it", () => {
    const late = pay({ id: "18", txHash: "h18", createdAt: "2026-09-30T10:20:05Z" });
    const friendLate = pay({ ...friend, id: "19", createdAt: "2026-09-30T10:21:00Z", amount: "1.0000000" });
    const c = crossCheckReceipt(r, [late, mine], { payments: [friendLate, late, friend, mine] });
    expect(c).toMatchObject({ check: "confirmed", share: "1", total: "3", uncredited: "1" });
    // History: this wallet paid 2 for the session, 1 more than its share of the receipt.
    const row = groupSessions([late, mine], new Set([HOST]))[0];
    expect(receiptStanding(row, { receipt: r, check: "confirmed", share: c.share, savedAt: 1 })).toEqual({ state: "uncredited", extra: "1" });
    // Only late payments of its own: nothing of the user's was credited.
    expect(mayBeShared(r, [late])).toBe(false);
    expect(crossCheckReceipt(r, [late], { payments: [friend, pay({ ...friend, id: "20", amount: "1" }), late] }).check).toBe("not_confirmed");
  });

  it("reads the host's payments from the receipt's time back to the session's start, bounded", async () => {
    // Operation ids are TOIDs (ledger sequence in the high 32 bits). The user's payment closed in ledger 1 000 000 at 10:05.
    const toid = (ledger: number, n = 1) => ((BigInt(ledger) << 32n) + BigInt(n)).toString();
    const own = pay({ id: toid(1_000_000), createdAt: "2026-09-30T10:05:00Z" });
    const cursor = cursorAfter(own, finished + 120);
    // 17 min to 10:22 at 4 s a ledger, + 2: ledger 1 000 257.
    expect(cursor).toBe((1_000_257n << 32n).toString());
    expect(cursorAfter(pay({ id: "7" }), finished)).toBeUndefined();

    const rec = (over: Record<string, unknown>) => ({
      id: toid(1_000_100),
      type: "payment",
      transaction_successful: true,
      transaction_hash: "h",
      created_at: "2026-09-30T10:10:00Z",
      from: FRIEND,
      to: HOST,
      amount: "2.0000000",
      asset_type: "native",
      transaction: { memo_type: "text", memo },
      ...over,
    });
    const filler = (ledger: number, at: string) =>
      Array.from({ length: 199 }, (_, i) => rec({ id: toid(ledger, i + 2), created_at: at, transaction: { memo_type: "text", memo: "ERZGCG.FN5V96VP" } }));
    const pages = [
      // A path payment the station credits (Horizon's amount is the destination side).
      [rec({ type: "path_payment_strict_send", source_amount: "0.2", source_asset_type: "credit_alphanum4" }), ...filler(1_000_050, "2026-09-30T10:04:00Z")],
      // This page reaches back before 10:20 - 15 min paid - 15 min slack: the session cannot be older.
      [rec({ id: toid(1_000_000), from: ME, amount: "1.0000000", created_at: "2026-09-30T10:05:00Z" }), ...filler(999_000, "2026-09-30T09:40:00Z")],
      [rec({ id: toid(998_000), created_at: "2026-09-30T09:30:00Z" })],
    ];
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const i = urls.length - 1;
        return new Response(JSON.stringify({ _embedded: { records: pages[i] }, _links: { next: { href: `https://horizon.example/next${i + 1}` } } }));
      }),
    );
    const got = await fetchReceiptPayments(NETWORKS.testnet, r, [own]);
    expect(urls[0]).toContain(`/accounts/${HOST}/payments?join=transactions&order=desc&limit=200&cursor=${cursor}`);
    expect(urls).toHaveLength(2);
    expect(got.complete).toBe(true);
    expect(got.payments.map((p) => [p.from, p.amount])).toEqual([
      [FRIEND, "2.0000000"],
      [ME, "1.0000000"],
    ]);
    expect(crossCheckReceipt(r, [own], { payments: got.payments, asset: XLM, fichaPrice: "1" })).toMatchObject({ check: "confirmed", share: "1", total: "3" });
    // Bounded: a busy host whose pages never reach the session's start stops at maxPages.
    urls.length = 0;
    pages[1] = [rec({ id: toid(1_000_000), from: ME, amount: "1.0000000", created_at: "2026-09-30T10:05:00Z" }), ...filler(999_500, "2026-09-30T10:03:00Z")];
    const partial = await fetchReceiptPayments(NETWORKS.testnet, r, [own], 2);
    expect(urls).toHaveLength(2);
    expect(partial.complete).toBe(false);
  });
});

describe("pay success", () => {
  it("gives an end time only for a payment that starts the session's paid time", () => {
    const at = Date.parse("2026-09-30T00:53:20Z");
    expect(estimatedEnd(at, 5, false)?.toISOString()).toBe("2026-09-30T00:58:20.000Z");
    // A second ficha on a running session adds to its time left, which only the station knows.
    expect(estimatedEnd(at + 9_000, 5, true)).toBeNull();
    expect(estimatedEnd(at, null, false)).toBeNull();
  });
});
