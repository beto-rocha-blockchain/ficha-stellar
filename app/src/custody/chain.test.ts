/**
 * The custody chain, pay link and receipt v2 against the vectors the
 * contract's tests and the station check too (contracts/escrow/test-vectors.json).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Asset, Networks } from "@stellar/stellar-sdk";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { NETWORKS } from "@/config";
import { classifyQr, linkRoute } from "@/pay/qr";
import { ReceiptError, isCustodyReceipt, parseReceipt } from "@/pay/receipt";
import {
  ChainError,
  MAX_CHAIN,
  chainLength,
  fromB64url,
  hashForward,
  isB64url32,
  paidUnits,
  payerShare,
  proofLeadsToAnchor,
  sessionDeadline,
  toB64url,
  unusedUnits,
} from "./chain";
import { PayLinkError, isPayLink, parsePayLink, payLinkSearch, sessionName } from "./link";

interface Vectors {
  chains: { seed_hex: string; seed_b64url: string; n: number; anchor_hex: string; anchor_b64url: string; proofs: { u: number; proof_hex: string; proof_b64url: string }[]; chain_hex?: string[] }[];
  unused_units: { paid_seconds: number; consumed_seconds: number; unit_seconds: number; paid_units: number; u: number }[];
  payer_share: { amount: string; paid_units: number; u: number; to_payer: string; to_host: string }[];
  deadline: { opened: number; total_fichas: number; ficha_seconds: number; grace_seconds: number; deadline: number }[];
  pay_link: { app_url: string; network: string; host: string; station: string; session: string; anchor_b64url: string; link: string; link_without_app_url: string };
  receipt_v2: { params: Record<string, string>; link: string };
}

const V = JSON.parse(readFileSync(fileURLToPath(new URL("../../../contracts/escrow/test-vectors.json", import.meta.url)), "utf8")) as Vectors;

describe("custody config", () => {
  it("names XLM's contract on testnet, and no custody on the public network", () => {
    expect(NETWORKS.testnet.custody?.xlmSac).toBe(Asset.native().contractId(Networks.TESTNET));
    expect(NETWORKS.testnet.custody?.escrowWasm.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(NETWORKS.public.custody).toBeNull();
  });
});

describe("hash chain (test vectors: chains)", () => {
  it("encodes 32 bytes as 43 base64url characters, both ways", () => {
    for (const c of V.chains) {
      expect(toB64url(hexToBytes(c.seed_hex))).toBe(c.seed_b64url);
      expect(bytesToHex(fromB64url(c.anchor_b64url))).toBe(c.anchor_hex);
      for (const p of c.proofs) {
        expect(toB64url(hexToBytes(p.proof_hex))).toBe(p.proof_b64url);
        expect(p.proof_b64url).toHaveLength(43);
        expect(isB64url32(p.proof_b64url)).toBe(true);
      }
    }
  });

  it("refuses anything that is not exactly 32 bytes, or not canonical", () => {
    const a = V.chains[1].anchor_b64url; // has both - and _
    for (const bad of [a.slice(1), `${a}A`, `${a}=`, a.replace("_", "/"), a.replace("-", "+"), a.replace(/.$/, "V"), "", "!".repeat(43)]) {
      expect(isB64url32(bad), bad).toBe(false);
      expect(() => fromB64url(bad), bad).toThrow(ChainError);
    }
    expect(() => toB64url(new Uint8Array(31))).toThrow(ChainError);
  });

  it("hashes the seed N times to the anchor, and each proof U times to it", () => {
    for (const c of V.chains) {
      const seed = hexToBytes(c.seed_hex);
      const anchor = hexToBytes(c.anchor_hex);
      expect(bytesToHex(hashForward(seed, c.n))).toBe(c.anchor_hex);
      if (c.chain_hex) c.chain_hex.forEach((h, i) => expect(bytesToHex(hashForward(seed, i))).toBe(h));
      for (const p of c.proofs) {
        expect(bytesToHex(hashForward(seed, c.n - p.u))).toBe(p.proof_hex);
        expect(proofLeadsToAnchor(anchor, p.u, fromB64url(p.proof_b64url)), `u=${p.u}`).toBe(true);
      }
    }
  });

  it("never accepts a proof for more units than it shows, nor beyond MAX_CHAIN", () => {
    const c = V.chains[0];
    const anchor = hexToBytes(c.anchor_hex);
    const p7 = hexToBytes(c.proofs.find((p) => p.u === 7)!.proof_hex);
    expect(proofLeadsToAnchor(anchor, 7, p7)).toBe(true);
    expect(proofLeadsToAnchor(anchor, 8, p7)).toBe(false);
    expect(proofLeadsToAnchor(anchor, 6, p7)).toBe(false);
    // The seed proves the whole chain, never more.
    const seed = hexToBytes(c.seed_hex);
    expect(proofLeadsToAnchor(anchor, c.n, seed)).toBe(true);
    expect(proofLeadsToAnchor(anchor, c.n + 1, seed)).toBe(false);
    expect(proofLeadsToAnchor(anchor, -1, seed)).toBe(false);
    expect(proofLeadsToAnchor(anchor, 2.5, seed)).toBe(false);
    expect(proofLeadsToAnchor(hexToBytes(V.chains[1].anchor_hex), 7, p7)).toBe(false);
    // Like the contract's claim: a chain longer than the session's N (its terms
    // changed on the contract) still proves its units, up to MAX_CHAIN (256).
    const long = hashForward(seed, MAX_CHAIN);
    expect(proofLeadsToAnchor(long, MAX_CHAIN, seed)).toBe(true);
    expect(proofLeadsToAnchor(hashForward(seed, MAX_CHAIN + 1), MAX_CHAIN + 1, seed)).toBe(false);
  });
});

describe("units, shares and deadlines (test vectors)", () => {
  it("rounds unused time up, in the payer's favour, at most the units paid", () => {
    for (const v of V.unused_units) {
      expect(v.paid_seconds / v.unit_seconds).toBe(v.paid_units);
      expect(unusedUnits(v.paid_seconds, v.consumed_seconds, v.unit_seconds), JSON.stringify(v)).toBe(v.u);
    }
  });

  it("splits the amount as the contract does, and the shares add up", () => {
    for (const v of V.payer_share) {
      const s = payerShare(BigInt(v.amount), v.u, v.paid_units);
      expect(s.toPayer.toString(), JSON.stringify(v)).toBe(v.to_payer);
      expect(s.toHost.toString(), JSON.stringify(v)).toBe(v.to_host);
      expect(s.toPayer + s.toHost).toBe(BigInt(v.amount));
    }
  });

  it("puts the deadline at opened + paid time + grace", () => {
    for (const v of V.deadline) expect(sessionDeadline(v.opened, v.total_fichas, v.ficha_seconds, v.grace_seconds)).toBe(v.deadline);
    expect(chainLength({ maxFichas: 12, fichaSecs: 300, unitSecs: 30 })).toBe(120);
    expect(paidUnits(2, { fichaSecs: 300, unitSecs: 30 })).toBe(20);
  });
});

describe("custody pay link (test vectors: pay_link)", () => {
  const L = V.pay_link;

  it("parses the station's link, with or without APP_URL, in any order", () => {
    for (const link of [L.link, L.link_without_app_url, L.link.replace("https://ficha-stellar.vercel.app", "ficha://")]) {
      expect(isPayLink(link), link).toBe(true);
      const p = parsePayLink(link);
      expect(p).toMatchObject({ network: "testnet", hostKey: L.host, stationId: L.station, session: L.session, anchorText: L.anchor_b64url });
      expect(toB64url(p.anchor)).toBe(L.anchor_b64url);
    }
    const q = new URLSearchParams(L.link.split("?")[1]);
    const shuffled = [...q.entries()].reverse().map(([k, v]) => `${k}=${v}`).join("&");
    expect(parsePayLink(`ficha:/p?${shuffled}`).session).toBe(L.session);
    expect(sessionName(L.station, L.session)).toBe("ERZGCG.F3H9TXAB");
  });

  it("refuses a malformed link, naming the field", () => {
    const field = (link: string) => {
      try {
        parsePayLink(link);
      } catch (e) {
        expect(e).toBeInstanceOf(PayLinkError);
        return (e as PayLinkError).field;
      }
      return "ok";
    };
    const L1 = L.link_without_app_url;
    expect(field(L1.replace("v=1", "v=2"))).toBe("v");
    expect(field(L1.replace("n=t", "n=x"))).toBe("n");
    expect(field(L1.replace(`h=${L.host}`, "h=GBAD"))).toBe("h");
    expect(field(L1.replace("s=ERZGCG", "s=ERZGC0"))).toBe("s");
    expect(field(L1.replace("x=F3H9TXAB", "x=ERZGCG.F3H9TXAB"))).toBe("x");
    expect(field(L1.replace(`a=${L.anchor_b64url}`, `a=${L.anchor_b64url.slice(2)}`))).toBe("a");
    expect(field(L1.replace(/&a=[^&]*/, ""))).toBe("a");
  });

  it("is routed to /p by the scanner and the Android links, apart from receipts", () => {
    const search = L.link.split("?")[1];
    expect(classifyQr(L.link)).toEqual({ kind: "custody", search });
    expect(linkRoute(L.link)).toBe(`/p?${search}`);
    expect(linkRoute(L.link_without_app_url)).toBe(`/p?${search}`);
    expect(payLinkSearch(`https://ficha-stellar.vercel.app/shop?${search}`)).toBeNull();
    expect(classifyQr(V.receipt_v2.link).kind).toBe("receipt");
  });
});

describe("receipt v2 (test vectors: receipt_v2)", () => {
  it("parses q and z, and the proof leads to the chain's anchor", () => {
    const r = parseReceipt(V.receipt_v2.link);
    expect(isCustodyReceipt(r)).toBe(true);
    expect(r).toMatchObject({ memo: "ERZGCG.F3H9TXAB", amount: "2", fichas: 2, paidSeconds: 600, usedSeconds: 400, version: 2, refund: { units: 7, proof: V.receipt_v2.params.z } });
    const c = V.chains[0];
    expect(proofLeadsToAnchor(hexToBytes(c.anchor_hex), r.refund!.units, fromB64url(r.refund!.proof))).toBe(true);
    expect(unusedUnits(r.paidSeconds, r.usedSeconds, 30)).toBe(r.refund!.units);
    // v1 stays as it was: no version, no refund.
    const v1 = parseReceipt(V.receipt_v2.link.replace("v=2", "v=1").replace(/&q=.*$/, ""));
    expect(isCustodyReceipt(v1)).toBe(false);
    expect(v1.version).toBeUndefined();
  });

  it("refuses a v2 receipt without a valid proof or station ID", () => {
    const link = V.receipt_v2.link;
    for (const bad of [
      link.replace(/&z=[^&]*/, ""),
      link.replace(/&q=[^&]*/, ""),
      link.replace("q=7", "q=257"),
      link.replace("q=7", "q=-1"),
      link.replace(/z=[^&]*/, "z=abc"),
      link.replace("m=ERZGCG.F3H9TXAB", "m=F3H9TXAB"),
    ]) {
      expect(() => parseReceipt(bad), bad).toThrow(ReceiptError);
    }
  });
});
