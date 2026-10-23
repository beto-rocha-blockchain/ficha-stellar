/**
 * The custody hash chain and its arithmetic (docs/station-app-contract.md
 * §7.3 and §7.7). Pure functions, checked against the shared vectors in
 * contracts/escrow/test-vectors.json.
 *
 * c[i+1] = SHA-256(c[i]) over the 32 raw bytes; the anchor is c[N]. The
 * station's proof that U units of paid time were NOT delivered is c[N-U]:
 * SHA-256 applied U times to it gives the anchor. The app checks a proof
 * against the anchor of its OWN deposit, never against one a receipt brings.
 */
import { sha256 } from "@noble/hashes/sha2.js";

/** A link (anchor or proof) in a URL: base64url, no padding, always 43 characters. */
const B64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainError";
  }
}

/** 32 bytes -> base64url without padding (RFC 4648 §5). */
export function toB64url(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new ChainError(`a chain link is 32 bytes, not ${bytes.length}`);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url (43 characters, no padding) -> 32 bytes. Anything else throws. */
export function fromB64url(text: string): Uint8Array {
  // The last character carries 4 bits of the 32nd byte and 2 zero bits: only 16 values are canonical.
  if (!B64URL_32.test(text)) throw new ChainError("not 32 bytes in base64url");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function isB64url32(text: string): boolean {
  return B64URL_32.test(text);
}

/** SHA-256 applied `times` times to `link`. */
export function hashForward(link: Uint8Array, times: number): Uint8Array {
  if (!Number.isInteger(times) || times < 0) throw new ChainError(`bad count: ${times}`);
  let h = link;
  for (let i = 0; i < times; i++) h = sha256(h);
  return h;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** The longest proof a claim takes (the contract's MAX_CHAIN): a station's N is never more. */
export const MAX_CHAIN = 256;

/**
 * Whether `proof` shows `units` unused units for the chain ending at
 * `anchor`: units at most MAX_CHAIN, and SHA-256 applied `units` times to
 * the proof is the anchor. What the contract's claim checks; it refunds
 * min(units, paid units). A station whose N is longer than the session's
 * chain (its terms changed) still proves a full refund this way.
 */
export function proofLeadsToAnchor(anchor: Uint8Array, units: number, proof: Uint8Array): boolean {
  if (!Number.isInteger(units) || units < 0 || units > MAX_CHAIN || proof.length !== 32 || anchor.length !== 32) return false;
  return sameBytes(hashForward(proof, units), anchor);
}

/** The terms a session froze at its first deposit (contract §7.1 Session). */
export interface ChainTerms {
  fichaSecs: number;
  unitSecs: number;
  maxFichas: number;
}

/** N = max_fichas x ficha_secs / unit_secs: the chain's length, the most units a proof shows. */
export function chainLength(t: ChainTerms): number {
  return (t.maxFichas * t.fichaSecs) / t.unitSecs;
}

/** Units the payer bought: total fichas x ficha_secs / unit_secs. */
export function paidUnits(fichas: number, t: Pick<ChainTerms, "fichaSecs" | "unitSecs">): number {
  return (fichas * t.fichaSecs) / t.unitSecs;
}

/**
 * U, the units the station proves were not delivered (contract §7.7):
 * min(paid units, ceil(max(0, paid_s - consumed_s) / unit_secs)), rounded
 * up in the payer's favour.
 */
export function unusedUnits(paidSeconds: number, consumedSeconds: number, unitSecs: number): number {
  const paid = Math.floor(paidSeconds / unitSecs);
  const unused = Math.max(0, paidSeconds - consumedSeconds);
  return Math.min(paid, Math.ceil(unused / unitSecs));
}

/**
 * The payer's share of `amount` (stroops) for `units` unused out of `paid`
 * units, as the contract computes it: ceil(amount x U' / paid) with
 * U' = min(units, paid). The host gets the rest.
 */
export function payerShare(amount: bigint, units: number, paid: number): { toPayer: bigint; toHost: bigint } {
  if (paid <= 0) throw new ChainError("no paid units");
  const u = BigInt(Math.min(units, paid));
  const p = BigInt(paid);
  const toPayer = (amount * u + p - 1n) / p;
  return { toPayer, toHost: amount - toPayer };
}

/** opened + total fichas x ficha_secs + grace_secs (ledger unix seconds). */
export function sessionDeadline(opened: number, totalFichas: number, fichaSecs: number, graceSecs: number): number {
  return opened + totalFichas * fichaSecs + graceSecs;
}
