/** GABC…WXYZ */
export function shortAddress(g: string, head = 4, tail = 4): string {
  return g.length <= head + tail + 1 ? g : `${g.slice(0, head)}…${g.slice(-tail)}`;
}

/**
 * The locale dates and times are written in: pt-BR, or en-GB for English
 * (day first, 24-hour: 02/10/2026, 02:18). Never en-US's 10/2/26, 2:18 AM,
 * which a European reader takes for 10 February.
 */
export function dateLocale(lang: "pt-BR" | "en"): "pt-BR" | "en-GB" {
  return lang === "pt-BR" ? "pt-BR" : "en-GB";
}

/** Date/time in the user's language. */
export function formatDateTime(d: Date | string | number, lang: "pt-BR" | "en"): string {
  return new Date(d).toLocaleString(dateLocale(lang), { dateStyle: "short", timeStyle: "short" });
}

/** A time of day (unix seconds) in the phone's zone: 22:23. */
export function formatTimeOfDay(unixSec: number, lang: "pt-BR" | "en"): string {
  return new Date(unixSec * 1000).toLocaleTimeString(dateLocale(lang), { hour: "2-digit", minute: "2-digit" });
}

/** A wait as "30 s", "5 min" or "4 h" / "1 h 20 min", rounded up (same in pt-BR and en). */
export function formatWait(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** A plain number in the user's language: 1,200 and 4.9 in en, 1.200 and 4,9 in pt-BR. */
export function formatNumber(n: number, lang: "pt-BR" | "en", digits = 0): string {
  return n.toLocaleString(lang === "pt-BR" ? "pt-BR" : "en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * A deadline as the time of day in the phone's zone and, while it is ahead,
 * how long is left: "22:23 (em 28 min)". The station's screen may run in
 * another time zone than the phone; the time left reads the same on both.
 */
export function formatDeadline(unixSec: number, lang: "pt-BR" | "en", nowSec = Date.now() / 1000): string {
  const time = formatTimeOfDay(unixSec, lang);
  const left = unixSec - nowSec;
  if (!(left > 0)) return time;
  const wait = formatWait(left * 1000);
  return lang === "pt-BR" ? `${time} (em ${wait})` : `${time} (in ${wait})`;
}
