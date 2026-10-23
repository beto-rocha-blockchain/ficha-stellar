/**
 * SEP-5 key derivation: BIP-39 mnemonic -> seed -> SLIP-10 ed25519 -> m/44'/148'/i'.
 * Pure functions, no storage, no network. Verified against the official SEP-5
 * vectors in sep5.test.ts. English wordlist only (what every Stellar wallet uses).
 */
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";

const HARDENED = 0x80000000;
const ED25519_CURVE = new TextEncoder().encode("ed25519 seed");

/** 24 words (256 bits of entropy), as SEP-5 recommends. */
export function generateWords(): string {
  return generateMnemonic(wordlist, 256);
}

/** Lower-case, trim and single-space a typed phrase. */
export function normalizeWords(input: string): string {
  return input.normalize("NFKD").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export function isValidWords(input: string): boolean {
  const words = normalizeWords(input);
  const n = words.split(" ").length;
  return [12, 15, 18, 21, 24].includes(n) && validateMnemonic(words, wordlist);
}

export function isBip39Word(word: string): boolean {
  return wordlist.includes(word.trim().toLowerCase());
}

export function isValidSecret(input: string): boolean {
  return StrKey.isValidEd25519SecretSeed(input.trim());
}

export function seedFromWords(words: string, passphrase = ""): Uint8Array {
  return mnemonicToSeedSync(normalizeWords(words), passphrase);
}

/** SLIP-10 ed25519 derivation. Every index in `path` is hardened (ed25519 has no public derivation). */
export function deriveEd25519(seed: Uint8Array, path: readonly number[]): Uint8Array {
  let I = hmac(sha512, ED25519_CURVE, seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const index of path) {
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, (index | HARDENED) >>> 0, false);
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

/** m/44'/148'/index' as a path array. */
export function stellarPath(index: number): number[] {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED) throw new Error("bad account index");
  return [44, 148, index];
}

export function keypairFromSeed(seed: Uint8Array, index: number): Keypair {
  return Keypair.fromRawEd25519Seed(deriveEd25519(seed, stellarPath(index)));
}

export function keypairFromWords(words: string, index: number, passphrase = ""): Keypair {
  return keypairFromSeed(seedFromWords(words, passphrase), index);
}
