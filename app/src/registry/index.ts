/**
 * Station registry loader, shared by Pay (destination check) and Stations (map).
 *
 *   const { registry, status, source, issuedAt, error, reload } = useRegistry();
 *   stationById(registry, "ERZGCG"); stationsByHostKey(registry, "G...");
 *
 * Fetches the LIVE registry from the Ficha site first (config liveRegistryUrl
 * + ".sig") and verifies the signature with the key pinned in config.ts. The
 * copy bundled with the app (registryUrl, copied from ../registry at build) is
 * the fallback when the site cannot be reached, and the last verified live
 * copy is kept in IndexedDB (raw bytes + sig, re-verified on every read) for
 * offline use. A copy that fails verification is never used, and neither is a
 * verified copy older (issued_at) than another one the app holds: a replayed
 * old registry cannot bring back a station's previous host key.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { createStore, get, set } from "idb-keyval";
import type { NetworkConfig, NetworkId } from "@/config";
import { useNetwork } from "@/stellar/network";
import { RegistryError, verifyRegistry, type Registry, type RegistrySource } from "./verify";

export * from "./verify";

interface Cached {
  bytes: string; // stations.json as base64 of the exact bytes
  sig: string;
  savedAt: number;
}

let idbStore: ReturnType<typeof createStore> | null = null;
function store() {
  idbStore ??= createStore("ficha.registry.v1", "registry");
  return idbStore;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export interface RegistryLoad {
  registry: Registry;
  /** live = the Ficha site's copy; bundled = the copy shipped with the app; cache = the last live copy verified here. */
  source: RegistrySource;
  /** When the cached copy was saved (source = cache). */
  savedAt?: number;
  /** Why the live copy is not the one in use: a network error, or a RegistryError when it failed verification. */
  freshError?: unknown;
  /** issued_at of the live copy when it verified but is older than the copy in use (a rollback or a replay). */
  liveIssuedAt?: string;
}

interface Verified {
  registry: Registry;
  bytes: Uint8Array;
  sig: string;
}

async function fetchVerified(net: NetworkConfig, url: string, sigUrl: string, timeoutMs: number): Promise<Verified> {
  const [rb, rs] = await Promise.all([
    fetch(url, { cache: "no-cache", signal: AbortSignal.timeout(timeoutMs) }),
    fetch(sigUrl, { cache: "no-cache", signal: AbortSignal.timeout(timeoutMs) }),
  ]);
  if (!rb.ok || !rs.ok) throw new Error(`registry HTTP ${rb.status}/${rs.status}`);
  const bytes = new Uint8Array(await rb.arrayBuffer());
  const sig = await rs.text();
  return { registry: verifyRegistry(bytes, sig, net.registryKey, net.id, net.custody !== null), bytes, sig };
}

async function readCache(net: NetworkConfig): Promise<{ registry: Registry; savedAt: number } | null> {
  try {
    const c = await get<Cached>(net.id, store());
    if (!c) return null;
    return { registry: verifyRegistry(fromB64(c.bytes), c.sig, net.registryKey, net.id, net.custody !== null), savedAt: c.savedAt };
  } catch {
    return null;
  }
}

/** issued_at as a number to compare copies; an unreadable one loses to any other. */
function issued(r: Registry): number {
  const t = Date.parse(r.issued_at);
  return Number.isFinite(t) ? t : -Infinity;
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

function attempt<T>(p: Promise<T>): Promise<Attempt<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

export async function loadRegistry(net: NetworkConfig): Promise<RegistryLoad> {
  if (!net.registryKey) throw new RegistryError("no_key", "no registry for this network");
  const live = net.liveRegistryUrl;
  // On the Ficha site the bundled copy IS the live one: fetch it once.
  const here = typeof location !== "undefined" ? location.href : "http://localhost/";
  const bundledIsLive = live !== null && new URL(net.registryUrl, here).href === live;
  const [fresh, bundled, cached] = await Promise.all([
    live ? attempt(fetchVerified(net, live, `${live}.sig`, 10_000)) : null,
    bundledIsLive ? null : attempt(fetchVerified(net, net.registryUrl, net.registrySigUrl, 15_000)),
    readCache(net),
  ]);

  if (fresh?.ok && (!cached || issued(fresh.value.registry) >= issued(cached.registry))) {
    try {
      const { bytes, sig } = fresh.value;
      await set(net.id, { bytes: toB64(bytes), sig, savedAt: Date.now() } satisfies Cached, store());
    } catch {
      /* no IndexedDB: fine, just no offline copy */
    }
  }

  // The newest verified copy wins; on the same issued_at: live, then bundled, then cache.
  const candidates: RegistryLoad[] = [];
  if (fresh?.ok) candidates.push({ registry: fresh.value.registry, source: "live" });
  if (bundled?.ok) candidates.push({ registry: bundled.value.registry, source: "bundled" });
  if (cached) candidates.push({ registry: cached.registry, source: "cache", savedAt: cached.savedAt });
  let best: RegistryLoad | undefined;
  for (const c of candidates) if (!best || issued(c.registry) > issued(best.registry)) best = c;
  if (!best) {
    if (fresh && !fresh.ok) throw fresh.error;
    if (bundled && !bundled.ok) throw bundled.error;
    throw new Error("registry unavailable");
  }
  if (best.source !== "live" && fresh && !fresh.ok) best.freshError = fresh.error;
  // The site answered with a valid but older registry: that is not being offline.
  if (best.source !== "live" && fresh?.ok) best.liveIssuedAt = fresh.value.registry.issued_at;
  return best;
}

interface RegistryState {
  net: NetworkId | null;
  status: "idle" | "loading" | "ready" | "error";
  data: RegistryLoad | null;
  error: unknown;
  load: (net: NetworkConfig, force?: boolean) => Promise<void>;
}

const useRegistryStore = create<RegistryState>((setState, getState) => ({
  net: null,
  status: "idle",
  data: null,
  error: null,
  load: async (net, force = false) => {
    const s = getState();
    if (!force && s.net === net.id && (s.status === "loading" || s.status === "ready")) return;
    setState({ net: net.id, status: "loading", error: null, ...(s.net === net.id ? {} : { data: null }) });
    try {
      const data = await loadRegistry(net);
      if (getState().net === net.id) setState({ status: "ready", data, error: null });
    } catch (e) {
      if (getState().net === net.id) setState({ status: "error", data: null, error: e });
    }
  },
}));

/** The verified registry of the active network (loads it on first use). */
export function useRegistry() {
  const net = useNetwork();
  const st = useRegistryStore();
  useEffect(() => {
    void st.load(net);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net.id]);
  const current = st.net === net.id;
  return {
    registry: current ? (st.data?.registry ?? null) : null,
    status: current ? st.status : ("loading" as const),
    source: current ? st.data?.source : undefined,
    /** issued_at of the registry in use. */
    issuedAt: current ? st.data?.registry.issued_at : undefined,
    savedAt: current ? st.data?.savedAt : undefined,
    freshError: current ? st.data?.freshError : undefined,
    liveIssuedAt: current ? st.data?.liveIssuedAt : undefined,
    error: current ? st.error : null,
    reload: () => st.load(net, true),
  };
}

/** Plain code: resolve the registry for `net` (uses the store's copy when loaded). */
export async function getRegistry(net: NetworkConfig): Promise<Registry | null> {
  const s = useRegistryStore.getState();
  if (s.net === net.id && s.status === "ready" && s.data) return s.data.registry;
  try {
    return (await loadRegistry(net)).registry;
  } catch {
    return null;
  }
}
