import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { NETWORKS } from "@/config";
import { RegistryError, isCustody, maxFichas, registryNotice, stationById, stationForMemo, stationsByHostKey, verifyRegistry } from "./verify";

// The real registry of the repo, byte for byte.
const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL("../../../registry/stations.json", import.meta.url))));
const sig = readFileSync(fileURLToPath(new URL("../../../registry/stations.json.sig", import.meta.url)), "utf8");
const KEY = NETWORKS.testnet.registryKey!;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RegistryError);
    return (e as RegistryError).code;
  }
  return "ok";
}

describe("signed registry", () => {
  it("verifies the repo registry with the pinned testnet key", () => {
    const reg = verifyRegistry(bytes, sig, KEY, "testnet");
    expect(reg.stations.length).toBeGreaterThan(0);
    const st = stationById(reg, "ERZGCG")!;
    expect(st.host_key).toMatch(/^G[A-Z2-7]{55}$/);
    expect(stationsByHostKey(reg, st.host_key).map((s) => s.id)).toContain("ERZGCG");
    expect(maxFichas(st)).toBe(Math.floor(st.max_session_minutes / st.ficha_minutes));
  });

  it("names a session's station only by its own ID, or by the host key when it is the only one", () => {
    const reg = verifyRegistry(bytes, sig, KEY, "testnet");
    const st = stationById(reg, "ERZGCG")!;
    expect(stationForMemo(reg, "ERZGCG", st.host_key)?.id).toBe("ERZGCG");
    // Several stations may share a host key: an ID not in the registry is not another station.
    expect(stationForMemo(reg, "K7M2QX", st.host_key)).toBeUndefined();
    const single = { ...reg, stations: [st] };
    expect(stationForMemo(single, null, st.host_key)?.id).toBe("ERZGCG");
    const shared = { ...single, stations: [st, { ...st, id: "K7M2QX", name: "Second bench" }] };
    expect(stationForMemo(shared, "K7M2QX", st.host_key)?.name).toBe("Second bench");
    expect(stationForMemo(shared, null, st.host_key)).toBeUndefined();
  });

  it("tells a served copy that failed verification apart from being offline", () => {
    const bad = new RegistryError("bad_signature", "x");
    expect(registryNotice({ status: "ready", source: "live" })).toBe("verified");
    expect(registryNotice({ status: "ready", source: "bundled", freshError: new TypeError("Failed to fetch") })).toBe("bundled");
    expect(registryNotice({ status: "ready", source: "bundled", freshError: bad })).toBe("rejected");
    expect(registryNotice({ status: "ready", source: "cache", freshError: new TypeError("Failed to fetch") })).toBe("cached");
    expect(registryNotice({ status: "ready", source: "cache", freshError: bad })).toBe("rejected");
    expect(registryNotice({ status: "ready", source: "cache", freshError: new RegistryError("wrong_key", "x") })).toBe("rejected");
    expect(registryNotice({ status: "error", error: bad })).toBe("failed");
    expect(registryNotice({ status: "error", error: new RegistryError("no_key", "x") })).toBe("none");
    expect(registryNotice({ status: "loading" })).toBe("loading");
  });

  it("rejects a single changed byte", () => {
    const tampered = bytes.slice();
    const i = new TextDecoder().decode(bytes).indexOf('"ficha_price": "') + 16;
    tampered[i] = tampered[i] === 0x39 ? 0x38 : 0x39;
    expect(code(() => verifyRegistry(tampered, sig, KEY, "testnet"))).toBe("bad_signature");
  });

  it("rejects re-serialized JSON (the signature covers the exact bytes)", () => {
    const reserialized = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(bytes))));
    expect(code(() => verifyRegistry(reserialized, sig, KEY, "testnet"))).toBe("bad_signature");
  });

  it("leaves out hours or an address that is not text, and keeps the station", () => {
    const kp = Keypair.random();
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    const st = doc.stations[0];
    doc.stations = [
      { ...st, hours: { "mon-fri": "08:00-20:00", sat: "09:00-13:00" }, location: { ...st.location, city: { name: "Rio" }, country: 55 } },
      { ...st, id: "K7M2QX", hours: 8, location: "Rio de Janeiro" },
    ];
    const signed = new TextEncoder().encode(JSON.stringify(doc));
    const sigText = JSON.stringify({ format: "ficha-registry-sig/1", key: kp.publicKey(), sig: Buffer.from(kp.sign(signed)).toString("base64") });
    const reg = verifyRegistry(signed, sigText, kp.publicKey(), "testnet");
    expect(reg.stations.map((s) => s.id)).toEqual(["ERZGCG", "K7M2QX"]);
    const [a, b] = reg.stations;
    expect(a.hours).toBeUndefined();
    expect(a.location).toMatchObject({ lat: st.location.lat, lng: st.location.lng, address: st.location.address });
    expect(a.location?.city).toBeUndefined();
    expect(a.location?.country).toBeUndefined();
    expect(b.hours).toBeUndefined();
    expect(b.location).toBeUndefined();
    // What the repo registry says is kept as it is.
    expect(stationById(verifyRegistry(bytes, sig, KEY, "testnet"), "ERZGCG")).toMatchObject({ hours: st.hours, location: st.location });
  });

  it("reads the payment mode: direct by default, custody with its four fields in the contract's bounds (contract §2)", () => {
    const kp = Keypair.random();
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    const base = { ...doc.stations[0], ficha_minutes: 5, max_session_minutes: 60 };
    delete base.mode;
    delete base.escrow;
    delete base.unit_seconds;
    delete base.grace_seconds;
    const custody = { ...base, mode: "custody", escrow: NETWORKS.testnet.custody!.escrowContract, unit_seconds: 30, grace_seconds: 1680 };
    const ids = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
    const entries: [Record<string, unknown>, boolean][] = [
      [base, true],
      [{ ...base, mode: "direct" }, true],
      [custody, true],
      [{ ...custody, unit_seconds: 15 }, true], // 12 x 300 / 15 = 240 links
      [{ ...custody, unit_seconds: 10 }, false], // 360 links: above 256
      [{ ...custody, unit_seconds: 7 }, false], // does not divide 300 s
      [{ ...custody, unit_seconds: 0 }, false],
      [{ ...custody, unit_seconds: "30" }, false],
      [{ ...custody, grace_seconds: 299 }, false],
      [{ ...custody, grace_seconds: 86_401 }, false],
      [{ ...custody, grace_seconds: 300 }, true],
      [{ ...custody, max_session_minutes: 1445 }, false], // 289 fichas of 5 min: more than a day
      [{ ...custody, escrow: base.host_key }, false], // an account, not a contract
      [{ ...custody, escrow: undefined }, false],
      [{ ...custody, grace_seconds: undefined }, false],
      [{ ...custody, mode: "escrow" }, false],
      [{ ...base, mode: "direct", escrow: custody.escrow }, false],
      [{ ...base, unit_seconds: 30 }, false],
    ];
    doc.stations = entries.map(([s], i) => ({ ...s, id: `ERZG${ids[i]}${ids[i]}` }));
    const signed = new TextEncoder().encode(JSON.stringify(doc));
    const sigText = JSON.stringify({ format: "ficha-registry-sig/1", key: kp.publicKey(), sig: Buffer.from(kp.sign(signed)).toString("base64") });
    const reg = verifyRegistry(signed, sigText, kp.publicKey(), "testnet");
    expect(reg.stations.map((s) => s.id)).toEqual(doc.stations.filter((_: unknown, i: number) => entries[i][1]).map((s: { id: string }) => s.id));
    expect(reg.stations.map(isCustody)).toEqual([false, false, true, true, true]);
    expect(reg.stations[2]).toMatchObject({ mode: "custody", escrow: custody.escrow, unit_seconds: 30, grace_seconds: 1680 });
  });

  it("drops custody entries on a network without custody (the public one, until the contract is audited)", () => {
    const kp = Keypair.random();
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    const direct = { ...doc.stations[0], id: "K7M2QX" };
    delete direct.mode;
    delete direct.escrow;
    delete direct.unit_seconds;
    delete direct.grace_seconds;
    const custody = { ...direct, id: "M4P7RT", ficha_minutes: 5, max_session_minutes: 60, mode: "custody", escrow: NETWORKS.testnet.custody!.escrowContract, unit_seconds: 30, grace_seconds: 1680 };
    doc.network = "public";
    doc.stations = [direct, custody];
    const signed = new TextEncoder().encode(JSON.stringify(doc));
    const sigText = JSON.stringify({ format: "ficha-registry-sig/1", key: kp.publicKey(), sig: Buffer.from(kp.sign(signed)).toString("base64") });
    // A signed, published station nobody could pay or run: not listed at all.
    expect(verifyRegistry(signed, sigText, kp.publicKey(), "public").stations.map((s) => s.id)).toEqual(["K7M2QX"]);
    expect(verifyRegistry(signed, sigText, kp.publicKey(), "public", NETWORKS.public.custody !== null).stations.map((s) => s.id)).toEqual(["K7M2QX"]);
    // Where custody exists, both stay.
    expect(verifyRegistry(signed, sigText, kp.publicKey(), "public", true).stations.map((s) => s.id)).toEqual(["K7M2QX", "M4P7RT"]);
    const loader = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    expect(loader.match(/net\.registryKey, net\.id, net\.custody !== null\)/g)).toHaveLength(2);
  });

  it("rejects another key, no key, a forged signature and the wrong network", () => {
    const other = "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6";
    expect(code(() => verifyRegistry(bytes, sig, other, "testnet"))).toBe("wrong_key");
    expect(code(() => verifyRegistry(bytes, sig.replace(KEY, other), other, "testnet"))).toBe("bad_signature");
    expect(code(() => verifyRegistry(bytes, sig, null, "testnet"))).toBe("no_key");
    const forged = JSON.stringify({ ...JSON.parse(sig), sig: Buffer.alloc(64, 1).toString("base64") });
    expect(code(() => verifyRegistry(bytes, forged, KEY, "testnet"))).toBe("bad_signature");
    expect(code(() => verifyRegistry(bytes, "not json", KEY, "testnet"))).toBe("bad_sig_file");
    expect(code(() => verifyRegistry(bytes, sig, KEY, "public"))).toBe("wrong_network");
  });
});
