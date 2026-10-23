/**
 * Biometric unlock (Android app only): when the lock screen may open with the
 * phone's fingerprint or face instead of the PIN.
 *
 * Stored in IndexedDB, next to the vault (whose format does not change):
 *  - ficha.biometric.v1: the PIN sealed (AES-256-GCM) with a random unlock
 *    key, and that unlock key wrapped by an Android Keystore key that only a
 *    strong biometric check can use, once per check (src/native/biometric.ts):
 *    { ciphertext, iv, pin: { iv, data }, enabledAt }. The unlock key is made
 *    in native code so the PIN never crosses the bridge as a call argument
 *    (Capacitor logs those in debug builds). A biometric unlock gets the PIN
 *    back and opens the vault with it, as if it had been typed.
 *  - ficha.biometric.meta.v1: when the PIN was last typed right, biometric
 *    tries in a row that did not unlock, and whether the one-time offer was
 *    answered.
 *
 * Rules:
 *  - Offered once, right after a PIN unlock, on a phone with strong
 *    biometrics. Ajustes has the switch: on asks for the PIN, off does not.
 *  - The PIN is required instead when it was last typed PIN_EVERY_MS ago or
 *    more (or the clock is behind that moment), after MAX_BIOMETRIC_FAILURES
 *    tries in a row that did not unlock (a lockout counts as all of them), and
 *    when the key was invalidated (a fingerprint or face was added): then
 *    biometrics are switched off and the lock screen says why.
 *  - A PIN typed right restarts the clock and clears the failures. A
 *    biometric unlock does neither the clock nor the PIN attempt limit.
 *  - Creating, importing or removing a wallet forgets all of it.
 *  - Show words and Remove wallet always ask for the PIN; they never come here.
 *  - On the web there is no plugin: everything reports "unsupported".
 */
import { del, get, set } from "idb-keyval";
import {
  BiometricError,
  biometricSupport,
  createBiometricKey,
  deleteBiometricKey,
  openBiometricKey,
  type BiometricErrorCode,
  type BiometricPromptText,
  type WrappedKey,
} from "@/native/biometric";

/** The PIN is asked again this long after it was last typed right. */
/** Once a week; everyday opening is by biometrics (owner's rule). */
export const PIN_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** Biometric tries in a row that end without unlocking before the PIN is required. */
export const MAX_BIOMETRIC_FAILURES = 3;

export interface BiometricRecord extends WrappedKey {
  /** The PIN sealed with the unlock key (AES-256-GCM, base64). */
  pin: { iv: string; data: string };
  /** Epoch ms when it was turned on. */
  enabledAt: number;
}

export interface BiometricMeta {
  /** Epoch ms of the last PIN typed right on this wallet; null: none recorded. */
  lastPinAt: number | null;
  /** Biometric tries in a row that ended without unlocking. */
  failures: number;
  /** The one-time "use biometrics?" question was answered (or biometrics were turned on). */
  offered: boolean;
}

export const NO_META: BiometricMeta = { lastPinAt: null, failures: 0, offered: false };

/**
 * What the lock screen may do:
 *  unsupported: web, or no strong biometrics on this phone right now
 *  off:         not turned on
 *  pin-due:     the PIN was last typed PIN_EVERY_MS ago or more
 *  paused:      MAX_BIOMETRIC_FAILURES tries in a row did not unlock
 *  ready:       open the biometric prompt
 */
export type BiometricGate = "unsupported" | "off" | "pin-due" | "paused" | "ready";

export interface BiometricState {
  /** Strong biometrics are enrolled and usable (false on the web). */
  supported: boolean;
  record: BiometricRecord | null;
  meta: BiometricMeta;
}

// ---------------------------------------------------------------- pure rules

/** The PIN must be typed: none recorded, typed PIN_EVERY_MS ago or more, or the clock is behind it. */
export function pinDue(lastPinAt: number | null, now: number): boolean {
  if (lastPinAt === null) return true;
  return now < lastPinAt || now - lastPinAt >= PIN_EVERY_MS;
}

export function biometricGate(s: BiometricState, now: number): BiometricGate {
  if (!s.supported) return "unsupported";
  if (!s.record) return "off";
  if (pinDue(s.meta.lastPinAt, now)) return "pin-due";
  if (s.meta.failures >= MAX_BIOMETRIC_FAILURES) return "paused";
  return "ready";
}

/** Ask "use biometrics?" after a PIN unlock: only once, only where it can work, only while off. */
export function shouldOfferBiometric(s: BiometricState): boolean {
  return s.supported && !s.record && !s.meta.offered;
}

/** A PIN typed right: restarts the clock and clears the failures. */
export function afterPinEntry(meta: BiometricMeta, now: number): BiometricMeta {
  return { ...meta, lastPinAt: now, failures: 0 };
}

export function afterBiometricSuccess(meta: BiometricMeta): BiometricMeta {
  return { ...meta, failures: 0 };
}

/**
 * A biometric try that did not unlock. `disable`: switch biometrics off (the
 * key is gone, or the PIN it gave back does not open this wallet).
 * Interruptions by the system, a busy prompt or missing hardware are not the
 * user's doing and do not count.
 */
export function afterBiometricError(meta: BiometricMeta, code: BiometricErrorCode | "stale"): { meta: BiometricMeta; disable: boolean } {
  switch (code) {
    case "invalidated":
    case "stale":
      return { meta: { ...meta, failures: 0 }, disable: true };
    case "lockout":
      return { meta: { ...meta, failures: Math.max(meta.failures, MAX_BIOMETRIC_FAILURES) }, disable: false };
    case "cancelled":
    case "failed":
      return { meta: { ...meta, failures: meta.failures + 1 }, disable: false };
    default:
      return { meta, disable: false };
  }
}

// ---------------------------------------------------------------- storage

const RECORD_KEY = "ficha.biometric.v1";
const META_KEY = "ficha.biometric.meta.v1";

function isRecord(x: unknown): x is BiometricRecord {
  const r = x as Partial<BiometricRecord> | undefined;
  return (
    !!r &&
    typeof r.ciphertext === "string" &&
    typeof r.iv === "string" &&
    typeof r.pin?.iv === "string" &&
    typeof r.pin?.data === "string" &&
    Number.isFinite(r.enabledAt)
  );
}

function asMeta(x: unknown): BiometricMeta {
  const m = x as Partial<BiometricMeta> | undefined;
  if (!m) return NO_META;
  return {
    lastPinAt: Number.isFinite(m.lastPinAt) ? m.lastPinAt! : null,
    failures: Number.isFinite(m.failures) && m.failures! > 0 ? m.failures! : 0,
    offered: m.offered === true,
  };
}

export async function loadBiometricRecord(): Promise<BiometricRecord | null> {
  const r = await get<unknown>(RECORD_KEY);
  return isRecord(r) ? r : null;
}

export async function loadBiometricMeta(): Promise<BiometricMeta> {
  return asMeta(await get<unknown>(META_KEY));
}

async function saveMeta(meta: BiometricMeta): Promise<void> {
  await set(META_KEY, meta);
}

/** Everything the rules need, now. */
export async function loadBiometricState(): Promise<BiometricState> {
  const [support, record, meta] = await Promise.all([biometricSupport(), loadBiometricRecord(), loadBiometricMeta()]);
  return { supported: support?.strong === true, record, meta };
}

export async function currentBiometricGate(now = Date.now()): Promise<BiometricGate> {
  try {
    return biometricGate(await loadBiometricState(), now);
  } catch {
    return "unsupported"; // IndexedDB unavailable: the PIN, as always
  }
}

export async function shouldOfferBiometricNow(): Promise<boolean> {
  try {
    return shouldOfferBiometric(await loadBiometricState());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the PIN under the unlock key

const AAD = new TextEncoder().encode("ficha-biometric/1");

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function unlockKey(key: string): Promise<CryptoKey> {
  const raw = unb64(key);
  try {
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

async function sealPin(key: string, pin: string): Promise<BiometricRecord["pin"]> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, await unlockKey(key), new TextEncoder().encode(pin));
  return { iv: b64(iv), data: b64(new Uint8Array(data)) };
}

/** Throws if the key or the sealed PIN does not match (AES-GCM tag). */
async function openPin(key: string, sealed: BiometricRecord["pin"]): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv), additionalData: AAD }, await unlockKey(key), unb64(sealed.data));
  return new TextDecoder().decode(plain);
}

// ---------------------------------------------------------------- actions

/** Called by the wallet store after a PIN typed right (unlock, words, remove, switch on). */
export async function notePinEntry(now = Date.now()): Promise<void> {
  await saveMeta(afterPinEntry(await loadBiometricMeta(), now));
}

/**
 * A new wallet (created or imported: its PIN was just typed, `now`) or none
 * (removed: null). Biometrics are off and the offer comes again.
 */
export async function resetBiometric(lastPinAt: number | null): Promise<void> {
  await del(RECORD_KEY);
  if (lastPinAt === null) await del(META_KEY);
  else await saveMeta({ ...NO_META, lastPinAt });
  await deleteBiometricKey();
}

/** Switch biometrics off (Ajustes, or the key is gone). No PIN needed; the offer does not come back. */
export async function turnOffBiometric(): Promise<void> {
  await del(RECORD_KEY);
  await saveMeta({ ...(await loadBiometricMeta()), failures: 0, offered: true });
  await deleteBiometricKey();
}

/** The offer was declined: Ajustes still has the switch. */
export async function markBiometricOffered(): Promise<void> {
  await saveMeta({ ...(await loadBiometricMeta()), offered: true });
}

/**
 * Put a PIN the caller has just checked (useWallet.enableBiometric) behind
 * the biometric prompt and store it. Throws BiometricError.
 */
export async function wrapPin(pin: string, text: BiometricPromptText, now = Date.now()): Promise<void> {
  const { key, wrapped } = await createBiometricKey(text);
  const record: BiometricRecord = { ciphertext: wrapped.ciphertext, iv: wrapped.iv, pin: await sealPin(key, pin), enabledAt: now };
  await set(RECORD_KEY, record);
  await saveMeta({ ...(await loadBiometricMeta()), failures: 0, offered: true });
}

export type BiometricFailure = Exclude<BiometricGate, "ready"> | BiometricErrorCode | "stale";

/** A biometric try that did not unlock; `disabled`: biometrics were switched off (say why). */
export interface BiometricMiss {
  ok: false;
  reason: BiometricFailure;
  disabled: boolean;
}

/**
 * The PIN behind the biometric prompt, if the rules allow a biometric unlock
 * now and the owner passes it. Counts failures and switches biometrics off on
 * an invalidated key. Only for useWallet.unlockWithBiometric.
 */
export async function readPinWithBiometric(text: BiometricPromptText, now = Date.now()): Promise<{ ok: true; pin: string } | BiometricMiss> {
  const state = await loadBiometricState();
  const gate = biometricGate(state, now);
  if (gate !== "ready") return { ok: false, reason: gate, disabled: false };
  const record = state.record!;
  let key: string;
  try {
    key = await openBiometricKey(record, text);
  } catch (e) {
    return biometricMissed(e instanceof BiometricError ? e.code : "failed");
  }
  try {
    return { ok: true, pin: await openPin(key, record.pin) };
  } catch {
    return biometricMissed("stale"); // this key never sealed that PIN: start over
  }
}

/** Record a try that did not unlock. */
export async function biometricMissed(code: BiometricErrorCode | "stale"): Promise<BiometricMiss> {
  const next = afterBiometricError(await loadBiometricMeta(), code);
  if (next.disable) await turnOffBiometric();
  else await saveMeta(next.meta);
  return { ok: false, reason: code, disabled: next.disable };
}

export async function biometricSucceeded(): Promise<void> {
  await saveMeta(afterBiometricSuccess(await loadBiometricMeta()));
}
