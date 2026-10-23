/**
 * Money math on Stellar amounts. Amounts are decimal STRINGS with at most
 * 7 decimals (the ledger's precision); math is done in stroops as BigInt.
 * Never use floats for money, never round silently: invalid input throws.
 */
export const STROOPS_PER_UNIT = 10_000_000n;
const AMOUNT_RE = /^(\d+)(?:\.(\d{1,7}))?$/;

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

export function isValidAmount(amount: string): boolean {
  return AMOUNT_RE.test(amount.trim());
}

/** "1.5" -> 15000000n. Throws on negatives, >7 decimals, exponents or junk. */
export function toStroops(amount: string): bigint {
  const m = AMOUNT_RE.exec(amount.trim());
  if (!m) throw new AmountError(`invalid amount: ${amount}`);
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(7, "0"));
  return whole * STROOPS_PER_UNIT + frac;
}

/** 15000000n -> "1.5". Canonical: no trailing zeros, no trailing dot. */
export function fromStroops(stroops: bigint): string {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const frac = (abs % STROOPS_PER_UNIT).toString().padStart(7, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** price x count, exact. Used for amount = fichas x ficha_price (contract §4). */
export function multiplyAmount(price: string, count: number): string {
  if (!Number.isSafeInteger(count) || count < 0) throw new AmountError(`invalid count: ${count}`);
  return fromStroops(toStroops(price) * BigInt(count));
}

export function addAmounts(a: string, b: string): string {
  return fromStroops(toStroops(a) + toStroops(b));
}

export function subtractAmounts(a: string, b: string): string {
  return fromStroops(toStroops(a) - toStroops(b));
}

/** -1, 0 or 1. */
export function compareAmounts(a: string, b: string): -1 | 0 | 1 {
  const x = toStroops(a);
  const y = toStroops(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Display only (never feed the result back into math). pt-BR uses a decimal
 * comma. Shows at least `minDecimals` and at most `maxDecimals`, truncating
 * (not rounding up) so a balance is never shown larger than it is.
 */
export function formatAmount(amount: string, lang: "pt-BR" | "en", maxDecimals = 2, minDecimals = 2): string {
  let s: bigint;
  try {
    s = toStroops(amount.replace(/^-/, ""));
  } catch {
    return amount;
  }
  const neg = amount.trim().startsWith("-");
  const whole = (s / STROOPS_PER_UNIT).toLocaleString(lang === "pt-BR" ? "pt-BR" : "en-US");
  let frac = (s % STROOPS_PER_UNIT).toString().padStart(7, "0").slice(0, maxDecimals);
  frac = frac.replace(/0+$/, "").padEnd(minDecimals, "0");
  const sep = lang === "pt-BR" ? "," : ".";
  return `${neg ? "-" : ""}${whole}${frac ? sep + frac : ""}`;
}
