/**
 * The custody pay link, a custody station's pay QR (docs/station-app-contract.md §7.3):
 *   <APP_URL>/p?v=1&n=<t|p>&h=<host G...>&s=<STATION_ID>&x=<SESSION>&a=<anchor>   or   ficha:/p?v=1&...
 * No amount and no contract ID: the user picks fichas, and the contract is
 * the signed registry's.
 */
import { StrKey } from "@stellar/stellar-sdk";
import type { NetworkId } from "@/config";
import { STATION_ID_RE } from "@/registry/verify";
import { fromB64url } from "./chain";

export const SESSION_ID_RE = /^F[2-9A-HJKMNP-TV-Z]{7}$/;

export interface PayLink {
  network: NetworkId;
  hostKey: string;
  stationId: string;
  /** The bare session ID (F + 7), the contract's `session` argument. */
  session: string;
  /** c[N] of the station's chain for this session, 32 bytes. */
  anchor: Uint8Array;
  /** The anchor as the link carries it (base64url, 43 characters). */
  anchorText: string;
}

export class PayLinkError extends Error {
  constructor(public field: string) {
    super(`pay link: bad or missing ${field}`);
    this.name = "PayLinkError";
  }
}

/** The query of `ficha:/p?...`, `ficha://p?...`, `/p?...` or `http(s)://host/.../p?...`; null for anything else. */
function payLinkQuery(s: string): URLSearchParams | null {
  const m = /^(?:ficha:\/{0,2}|https?:\/\/[^?#\s]*?)?\/?p\?([^#\s]*)$/i.exec(s);
  if (!m) return null;
  // For http(s) the path must end in /p (not e.g. /shop?...).
  if (/^https?:/i.test(s) && !/^https?:\/\/[^/?#]+(?:\/[^?#]*)?\/p\?/i.test(s)) return null;
  return new URLSearchParams(m[1]);
}

/** True for a pay link carrying v=, h= and a= (the scanner's test; parsePayLink checks the rest). */
export function isPayLink(text: string): boolean {
  const q = payLinkQuery(text.trim());
  return q !== null && q.has("v") && q.has("h") && q.has("a");
}

/** The query string part of a pay link (for routing to /p). */
export function payLinkSearch(text: string): string | null {
  const s = text.trim();
  if (!isPayLink(s)) return null;
  return s.slice(s.indexOf("?") + 1);
}

/** Parse from a full link or a bare query string (`v=1&n=t&...`). Throws PayLinkError. */
export function parsePayLink(input: string | URLSearchParams): PayLink {
  let q: URLSearchParams;
  if (typeof input === "string") {
    const s = input.trim();
    q = payLinkQuery(s) ?? new URLSearchParams(s.replace(/^\?/, ""));
  } else {
    q = input;
  }
  if (q.get("v") !== "1") throw new PayLinkError("v");
  const n = q.get("n");
  if (n !== "t" && n !== "p") throw new PayLinkError("n");
  const hostKey = q.get("h") ?? "";
  if (!StrKey.isValidEd25519PublicKey(hostKey)) throw new PayLinkError("h");
  const stationId = q.get("s") ?? "";
  if (!STATION_ID_RE.test(stationId)) throw new PayLinkError("s");
  const session = q.get("x") ?? "";
  if (!SESSION_ID_RE.test(session)) throw new PayLinkError("x");
  const anchorText = q.get("a") ?? "";
  let anchor: Uint8Array;
  try {
    anchor = fromB64url(anchorText);
  } catch {
    throw new PayLinkError("a");
  }
  return { network: n === "p" ? "public" : "testnet", hostKey, stationId, session, anchor, anchorText };
}

/** `ERZGCG.F3H9TXAB`: the session's name in the station's log and in the receipt (`m`). */
export function sessionName(stationId: string, session: string): string {
  return `${stationId}.${session}`;
}
