import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { clear, createStore } from "idb-keyval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORKS, SITE_URL, type NetworkConfig } from "@/config";
import { loadRegistry } from "./index";
import { registryNotice } from "./verify";

const repoBytes = readFileSync(fileURLToPath(new URL("../../../registry/stations.json", import.meta.url)));
const kp = Keypair.random();
const LIVE = "https://site.example/registry/stations.json";
const net: NetworkConfig = {
  ...NETWORKS.testnet,
  registryKey: kp.publicKey(),
  liveRegistryUrl: LIVE,
  registryUrl: "http://localhost/registry/stations.json",
  registrySigUrl: "http://localhost/registry/stations.json.sig",
};

/** A registry signed with the test key, issued at `issuedAt`, with one station named `name`. */
function signed(issuedAt: string, name: string): { body: Uint8Array; sig: string } {
  const doc = JSON.parse(repoBytes.toString("utf8"));
  doc.issued_at = issuedAt;
  doc.stations[0].name = name;
  const body = new TextEncoder().encode(JSON.stringify(doc, null, 2));
  return { body, sig: JSON.stringify({ format: "ficha-registry-sig/1", key: kp.publicKey(), sig: Buffer.from(kp.sign(body)).toString("base64") }) };
}

type Served = { body: Uint8Array; sig: string } | "offline" | "404";
let served: { live: Served; bundled: Served };
let calls: string[];

beforeEach(async () => {
  calls = [];
  await clear(createStore("ficha.registry.v1", "registry"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const which = url.startsWith(LIVE) ? served.live : served.bundled;
      if (which === "offline") throw new TypeError("Failed to fetch");
      if (which === "404") return new Response("not found", { status: 404 });
      return new Response(url.endsWith(".sig") ? which.sig : new Blob([new Uint8Array(which.body)]));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registry loading: live first, the bundled copy as fallback", () => {
  it("points the testnet app at the registry on the Ficha site; none for the public network yet", () => {
    expect(SITE_URL).toBe("https://ficha-stellar.vercel.app/");
    expect(NETWORKS.testnet.liveRegistryUrl).toBe("https://ficha-stellar.vercel.app/registry/stations.json");
    expect(NETWORKS.public.liveRegistryUrl).toBeNull();
  });

  it("uses the live copy when it verifies", async () => {
    served = { live: signed("2026-09-30T00:00:00Z", "Live"), bundled: signed("2026-09-29T00:00:00Z", "Bundled") };
    const r = await loadRegistry(net);
    expect(r).toMatchObject({ source: "live", registry: { issued_at: "2026-09-30T00:00:00Z" } });
    expect(r.registry.stations[0].name).toBe("Live");
    expect(calls).toContain(LIVE);
    expect(calls).toContain(`${LIVE}.sig`);
    expect(registryNotice({ status: "ready", ...r })).toBe("verified");
  });

  it("falls back to the bundled copy when the site cannot be reached", async () => {
    served = { live: "offline", bundled: signed("2026-09-29T00:00:00Z", "Bundled") };
    const r = await loadRegistry(net);
    expect(r.source).toBe("bundled");
    expect(r.registry.stations[0].name).toBe("Bundled");
    expect(r.freshError).toBeInstanceOf(TypeError);
    expect(registryNotice({ status: "ready", ...r })).toBe("bundled");
    served = { live: "404", bundled: signed("2026-09-29T00:00:00Z", "Bundled") };
    expect((await loadRegistry(net)).source).toBe("bundled");
  });

  it("never uses a live copy that fails verification, and says so", async () => {
    const good = signed("2026-09-30T00:00:00Z", "Live");
    const tampered = new TextEncoder().encode(new TextDecoder().decode(good.body).replace('"ficha_price": "1"', '"ficha_price": "9"'));
    served = { live: { body: tampered, sig: good.sig }, bundled: signed("2026-09-29T00:00:00Z", "Bundled") };
    const r = await loadRegistry(net);
    expect(r.source).toBe("bundled");
    expect(r.registry.stations[0].ficha_price).toBe("1");
    expect(registryNotice({ status: "ready", ...r })).toBe("rejected");
  });

  it("does not go back to an older registry than one it already holds", async () => {
    served = { live: signed("2026-09-01T00:00:00Z", "Old live"), bundled: signed("2026-09-29T00:00:00Z", "Bundled") };
    const b = await loadRegistry(net);
    expect(b.registry.stations[0].name).toBe("Bundled");
    expect(b.liveIssuedAt).toBe("2026-09-01T00:00:00Z");
    expect(registryNotice({ status: "ready", ...b })).toBe("older");
    // The newest live copy seen is kept on the phone: a replayed older one does not replace it.
    served = { live: signed("2026-10-02T00:00:00Z", "New live"), bundled: signed("2026-09-29T00:00:00Z", "Bundled") };
    const l = await loadRegistry(net);
    expect(l.source).toBe("live");
    expect(l.liveIssuedAt).toBeUndefined();
    served = { live: signed("2026-10-01T00:00:00Z", "Replayed"), bundled: signed("2026-09-29T00:00:00Z", "Bundled") };
    const r = await loadRegistry(net);
    expect(r).toMatchObject({ source: "cache", registry: { issued_at: "2026-10-02T00:00:00Z" } });
    // The site answered: the notice says it serves an older registry, not that the phone is offline.
    expect(r.liveIssuedAt).toBe("2026-10-01T00:00:00Z");
    expect(r.freshError).toBeUndefined();
    expect(registryNotice({ status: "ready", ...r })).toBe("older");
  });

  it("works offline from the last verified live copy, and fails only with no copy at all", async () => {
    served = { live: signed("2026-10-02T00:00:00Z", "Live"), bundled: signed("2026-09-29T00:00:00Z", "Bundled") };
    await loadRegistry(net);
    served = { live: "offline", bundled: "404" };
    const r = await loadRegistry(net);
    expect(r).toMatchObject({ source: "cache", registry: { issued_at: "2026-10-02T00:00:00Z" } });
    expect(r.savedAt).toBeGreaterThan(0);
    expect(registryNotice({ status: "ready", ...r })).toBe("cached");
    await clear(createStore("ficha.registry.v1", "registry"));
    await expect(loadRegistry(net)).rejects.toBeInstanceOf(TypeError);
  });

  it("fetches once on the Ficha site, where the bundled copy is the live one", async () => {
    served = { live: signed("2026-09-30T00:00:00Z", "Live"), bundled: "404" };
    const site = { ...net, registryUrl: LIVE, registrySigUrl: `${LIVE}.sig` };
    expect((await loadRegistry(site)).source).toBe("live");
    expect(calls.filter((u) => u === LIVE)).toHaveLength(1);
  });
});
