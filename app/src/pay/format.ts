/** Energy for display: 3 decimals (as the receipt carries it), in the user's language. */
export function formatWh(wh: number, lang: "pt-BR" | "en", decimals = 3): string {
  return wh.toLocaleString(lang === "pt-BR" ? "pt-BR" : "en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Seconds as m:ss (a receipt's paid and used time). */
export function formatMmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Clock time the charging bought by a payment should end, or null when the
 * app cannot tell: fichas that extend a session already paid for add to the
 * time it had left, which only the station's screen shows.
 */
export function estimatedEnd(paidAt: number, minutes: number | null, extendsSession: boolean): Date | null {
  return minutes === null || extendsSession ? null : new Date(paidAt + minutes * 60_000);
}
