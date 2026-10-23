/**
 * The vault: the ONLY place a secret is ever persisted, and only encrypted.
 *
 * - Plaintext = the recovery words (or an imported S... secret).
 * - Key = PBKDF2-SHA256(PIN, random 16-byte salt, 600 000 iterations) -> AES-256-GCM.
 * - Random 12-byte IV per encryption. The AAD binds the ciphertext to its kind
 *   and public key, so a swapped record fails to decrypt.
 * - Stored in IndexedDB (idb-keyval) under `ficha.vault.v1`. Never in
 *   localStorage, never sent over the network, never logged.
 * - A wrong PIN fails the AES-GCM tag check (WrongPinError); there is no
 *   PIN hash to brute-force offline other than the ciphertext itself.
 */
import { get, set, del } from "idb-keyval";
import { WALLET } from "@/config";

export type SecretKind = "mnemonic" | "secret";

export interface VaultRecord {
  v: 1;
  kind: SecretKind;
  /** Public, stored in clear so the app can show the address while locked. */
  publicKey: string;
  /** SEP-5 account index (mnemonic kind only). */
  account: number;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string; data: string };
  createdAt: string;
}

export class WrongPinError extends Error {
  constructor() {
    super("wrong PIN");
    this.name = "WrongPinError";
  }
}

const VAULT_KEY = "ficha.vault.v1";
const enc = new TextEncoder();
const dec = new TextDecoder();

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

function aad(kind: SecretKind, publicKey: string): Uint8Array<ArrayBuffer> {
  return enc.encode(`ficha-vault/1|${kind}|${publicKey}`);
}

async function deriveKey(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** All one character (000000) or a straight run up or down (123456, 654321, abcdef): the first PINs anyone tries. */
export function isTrivialPin(pin: string): boolean {
  const c = [...pin].map((ch) => ch.codePointAt(0)!);
  const digits = /^\d+$/.test(pin);
  // Step between neighbours; digits wrap, so 1234567890 is a run like 123456.
  const steps = new Set(c.slice(1).map((x, i) => (digits ? (x - c[i] + 10) % 10 : x - c[i])));
  return steps.size === 1 && [0, 1, digits ? 9 : -1].includes([...steps][0]);
}

/** A new PIN is long enough and not trivial. Existing vaults still open with whatever PIN they were sealed with. */
export function checkPin(pin: string): boolean {
  return pin.length >= WALLET.pinMinLength && !isTrivialPin(pin);
}

/** Encrypt a secret into a new vault record (does not store it). */
export async function sealVault(
  input: { kind: SecretKind; secret: string; publicKey: string; account: number },
  pin: string,
  iterations: number = WALLET.pbkdf2Iterations,
): Promise<VaultRecord> {
  if (!checkPin(pin)) throw new Error(`PIN must have at least ${WALLET.pinMinLength} characters and not be one repeated character or a straight run`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt, iterations);
  const data = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(input.kind, input.publicKey) },
      key,
      enc.encode(input.secret),
    ),
  );
  return {
    v: 1,
    kind: input.kind,
    publicKey: input.publicKey,
    account: input.account,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: b64(salt) },
    cipher: { name: "AES-GCM", iv: b64(iv), data: b64(data) },
    createdAt: new Date().toISOString(),
  };
}

/** Decrypt a vault record. Throws WrongPinError on a wrong PIN or a tampered record. */
export async function openVault(record: VaultRecord, pin: string): Promise<string> {
  const key = await deriveKey(pin, unb64(record.kdf.salt), record.kdf.iterations);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(record.cipher.iv), additionalData: aad(record.kind, record.publicKey) },
      key,
      unb64(record.cipher.data),
    );
    return dec.decode(plain);
  } catch {
    throw new WrongPinError();
  }
}

function isVaultRecord(x: unknown): x is VaultRecord {
  const r = x as VaultRecord | undefined;
  return !!r && r.v === 1 && (r.kind === "mnemonic" || r.kind === "secret") && typeof r.publicKey === "string";
}

export async function loadVault(): Promise<VaultRecord | null> {
  const r = await get<unknown>(VAULT_KEY);
  return isVaultRecord(r) ? r : null;
}

export async function saveVault(record: VaultRecord): Promise<void> {
  await set(VAULT_KEY, record);
}

export async function deleteVault(): Promise<void> {
  await del(VAULT_KEY);
}
