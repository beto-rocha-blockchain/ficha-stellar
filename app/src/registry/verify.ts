/**
 * Signed station registry (docs/station-app-contract.md §2): parsing and
 * signature check. Pure functions, no I/O, so tests can use the real files.
 *
 * The signature is ed25519 over the EXACT bytes of stations.json; never
 * re-serialize the JSON before verifying.
 */
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import type { AssetRef, NetworkId } from "@/config";
import { isValidAmount, toStroops } from "@/stellar/amount";

export const STATION_ID_RE = /^[2-9A-HJKMNP-TV-Z]{6}$/;

export interface StationLocation {
  lat: number;
  lng: number;
  address?: string;
  city?: string;
  country?: string;
}

export interface Station {
  id: string;
  name: string;
  host_key: string;
  asset: AssetRef;
  /** Decimal string in `asset`. */
  ficha_price: string;
  ficha_minutes: number;
  max_session_minutes: number;
  location?: StationLocation;
  hours?: string;
  active: boolean;
  /** Payment mode (contract §2, §7); absent = direct. */
  mode?: PaymentMode;
  /** Custody only: the FichaEscrow contract (C...), the only one the app calls for this station. */
  escrow?: string;
  /** Custody only: the refund unit, in seconds (contract §7.7). */
  unit_seconds?: number;
  /** Custody only: from the end of the paid time to the deadline, in seconds. */
  grace_seconds?: number;
}

export type PaymentMode = "direct" | "custody";

/** A station that sells by deposit into its escrow (contract §7): the four custody fields are present. */
export type CustodyStation = Station & { mode: "custody"; escrow: string; unit_seconds: number; grace_seconds: number };

export interface Registry {
  format: "ficha-registry/1";
  issued_at: string;
  network: NetworkId;
  stations: Station[];
}

export interface RegistrySig {
  format: "ficha-registry-sig/1";
  key: string;
  sig: string;
}

export class RegistryError extends Error {
  constructor(
    public code: "no_key" | "bad_sig_file" | "wrong_key" | "bad_signature" | "bad_format" | "wrong_network",
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

/** How many fichas one session may buy at most (contract §4). */
export function maxFichas(s: Pick<Station, "max_session_minutes" | "ficha_minutes">): number {
  return Math.max(0, Math.floor(s.max_session_minutes / s.ficha_minutes));
}

function isStation(x: unknown): x is Station {
  const s = x as Station;
  if (!s || typeof s !== "object") return false;
  if (typeof s.id !== "string" || !STATION_ID_RE.test(s.id)) return false;
  if (typeof s.name !== "string" || typeof s.host_key !== "string" || !StrKey.isValidEd25519PublicKey(s.host_key)) return false;
  if (!s.asset || typeof s.asset.code !== "string") return false;
  if (s.asset.issuer !== null && !StrKey.isValidEd25519PublicKey(String(s.asset.issuer))) return false;
  if (typeof s.ficha_price !== "string" || !isValidAmount(s.ficha_price) || toStroops(s.ficha_price) <= 0n) return false;
  if (!Number.isInteger(s.ficha_minutes) || s.ficha_minutes <= 0) return false;
  if (!Number.isInteger(s.max_session_minutes) || s.max_session_minutes < s.ficha_minutes) return false;
  if (typeof s.active !== "boolean") return false;
  return paymentModeOk(s);
}

/** The contract's own bounds (contract §7.1 register): an entry outside them can never match it. */
const MAX_CHAIN = 256;
const MAX_SESSION_SECONDS = 86_400;
const MIN_GRACE_SECONDS = 300;
const MAX_GRACE_SECONDS = 86_400;

/**
 * The payment-mode fields (contract §2): absent or "direct" with none of the
 * custody fields, or "custody" with all of them, in bounds. Anything else
 * drops the entry, as tools/registry.py refuses to sign it.
 */
function paymentModeOk(s: Station): boolean {
  const custodyFields = [s.escrow, s.unit_seconds, s.grace_seconds];
  if (s.mode === undefined || s.mode === "direct") return custodyFields.every((v) => v === undefined);
  if (s.mode !== "custody") return false;
  if (typeof s.escrow !== "string" || !StrKey.isValidContract(s.escrow)) return false;
  const fichaSecs = s.ficha_minutes * 60;
  const unit = s.unit_seconds;
  if (!Number.isInteger(unit) || unit! <= 0 || fichaSecs % unit! !== 0) return false;
  const sessionSecs = maxFichas(s) * fichaSecs;
  if (sessionSecs > MAX_SESSION_SECONDS || sessionSecs / unit! > MAX_CHAIN) return false;
  const grace = s.grace_seconds;
  return Number.isInteger(grace) && grace! >= MIN_GRACE_SECONDS && grace! <= MAX_GRACE_SECONDS;
}

export function isCustody(s: Station | undefined | null): s is CustodyStation {
  return s?.mode === "custody";
}

/**
 * The display-only fields, kept only when they are text. React throws on an
 * object ("hours": {"mon-fri": ...} took the whole app down on the station
 * page), and a station is still listed and paid without them.
 */
function readable(s: Station): Station {
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const { hours, location, ...rest } = s;
  const out: Station = rest;
  if (text(hours) !== undefined) out.hours = hours;
  if (location && typeof location === "object") {
    out.location = { ...location, address: text(location.address), city: text(location.city), country: text(location.country) };
  }
  return out;
}

/**
 * Verify the detached signature over `bytes` with the PINNED key, then parse.
 * Throws RegistryError on any problem; a registry that fails is never used.
 * `custody`: whether this network has custody payments (config.ts
 * NetworkConfig.custody). Where it has none (the public network, until the
 * contract is audited, contract §7), a custody entry could be neither paid
 * nor run, so it is dropped like any other entry that cannot be used.
 */
export function verifyRegistry(bytes: Uint8Array, sigText: string, pinnedKey: string | null, network: NetworkId, custody = network === "testnet"): Registry {
  if (!pinnedKey) throw new RegistryError("no_key", "no registry key pinned for this network");
  let sig: RegistrySig;
  try {
    sig = JSON.parse(sigText) as RegistrySig;
  } catch {
    throw new RegistryError("bad_sig_file", "signature file is not JSON");
  }
  if (sig?.format !== "ficha-registry-sig/1" || typeof sig.sig !== "string") {
    throw new RegistryError("bad_sig_file", "unknown signature file format");
  }
  // The key inside the .sig file is informative only; we verify with the pinned key.
  if (sig.key !== pinnedKey) throw new RegistryError("wrong_key", "registry signed by an unexpected key");
  let ok = false;
  try {
    ok = Keypair.fromPublicKey(pinnedKey).verify(Buffer.from(bytes), Buffer.from(sig.sig, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) throw new RegistryError("bad_signature", "registry signature does not verify");

  let reg: Registry;
  try {
    reg = JSON.parse(new TextDecoder().decode(bytes)) as Registry;
  } catch {
    throw new RegistryError("bad_format", "registry is not JSON");
  }
  if (reg?.format !== "ficha-registry/1" || !Array.isArray(reg.stations)) {
    throw new RegistryError("bad_format", "unknown registry format");
  }
  if (reg.network !== network) throw new RegistryError("wrong_network", `registry is for ${reg.network}, app is on ${network}`);
  // A malformed entry is dropped, not trusted with defaults; a display field
  // that is not text is left out.
  return { ...reg, stations: reg.stations.filter((s) => isStation(s) && (custody || !isCustody(s))).map(readable) };
}

/** Where the registry in use came from (src/registry/index.ts loadRegistry). */
export type RegistrySource = "live" | "bundled" | "cache";

/** What the app says about the registry in use (RegistryStatus). */
export type RegistryNotice = "loading" | "verified" | "bundled" | "cached" | "rejected" | "older" | "none" | "failed";

export function registryNotice(r: {
  status: string;
  source?: RegistrySource;
  freshError?: unknown;
  liveIssuedAt?: string;
  error?: unknown;
}): RegistryNotice {
  if (r.status === "loading" || r.status === "idle") return "loading";
  if (r.status === "error") return r.error instanceof RegistryError && r.error.code === "no_key" ? "none" : "failed";
  if (r.source === "live") return "verified";
  // The live copy failed verification: that is not the same as being offline.
  if (r.freshError instanceof RegistryError) return "rejected";
  // The site serves an older (valid) registry than the one in use: not offline either.
  if (r.liveIssuedAt) return "older";
  return r.source === "cache" ? "cached" : "bundled";
}

export function stationById(reg: Registry | null, id: string): Station | undefined {
  return reg?.stations.find((s) => s.id === id);
}

export function stationsByHostKey(reg: Registry | null, hostKey: string): Station[] {
  return reg?.stations.filter((s) => s.host_key === hostKey) ?? [];
}

/**
 * The station a session memo belongs to: the one its station ID names, or,
 * for a legacy memo (no ID), the only station with that host key. Several
 * stations may share a host key, so an ID that is not in the registry never
 * falls back to another station's name.
 */
export function stationForMemo(reg: Registry | null, stationId: string | null, hostKey: string): Station | undefined {
  if (stationId) return stationById(reg, stationId);
  const hits = stationsByHostKey(reg, hostKey);
  return hits.length === 1 ? hits[0] : undefined;
}

export function hostKeys(reg: Registry | null): Set<string> {
  return new Set(reg?.stations.map((s) => s.host_key) ?? []);
}
