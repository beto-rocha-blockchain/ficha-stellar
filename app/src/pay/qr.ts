/** What a scanned (or pasted) QR is, and where the app sends it. */
import { payLinkSearch } from "@/custody/link";
import { isSep7Pay } from "./sep7";
import { receiptSearch } from "./receipt";

export type ScanTarget =
  | { kind: "pay"; uri: string }
  /** A custody station's pay link (contract §7.3): `<APP_URL>/p?v=1&...` or `ficha:/p?v=1&...`. */
  | { kind: "custody"; search: string }
  | { kind: "receipt"; search: string }
  | { kind: "wifi"; ssid: string; password: string | null }
  | { kind: "unknown"; text: string };

function wifiField(body: string, key: string): string | null {
  // Fields are K:value; with \ escaping ; , : " and \ (the station's qr.wifi_payload).
  const re = new RegExp(`(?:^|;)${key}:((?:\\\\.|[^;])*)`);
  const m = re.exec(body);
  return m ? m[1].replace(/\\(.)/g, "$1") : null;
}

export function classifyQr(raw: string): ScanTarget {
  const text = raw.trim();
  if (isSep7Pay(text)) return { kind: "pay", uri: text };
  const pay = payLinkSearch(text);
  if (pay !== null) return { kind: "custody", search: pay };
  const search = receiptSearch(text);
  if (search !== null) return { kind: "receipt", search };
  if (/^WIFI:/i.test(text)) {
    const body = text.slice(5);
    const password = wifiField(body, "P");
    return { kind: "wifi", ssid: wifiField(body, "S") ?? "", password: password || null };
  }
  return { kind: "unknown", text };
}

/**
 * The in-app page a pay or receipt link opens: the scanner and the Android
 * deep links (src/native/deep-links.ts) route the same inputs the same way.
 * null for anything else (a WIFI: code is the scanner's own business).
 */
export function routeFor(target: ScanTarget): string | null {
  if (target.kind === "pay") return `/pay?uri=${encodeURIComponent(target.uri)}`;
  if (target.kind === "custody") return `/p?${target.search}`;
  if (target.kind === "receipt") return `/r?${target.search}`;
  return null;
}

export function linkRoute(raw: string): string | null {
  return routeFor(classifyQr(raw));
}
