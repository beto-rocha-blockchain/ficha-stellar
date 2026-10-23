/**
 * Buying saldo through a SEP-24 anchor (interactive deposit).
 *
 *   const anchor = await resolveAnchor(net);                 // stellar.toml + /info
 *   const jwt = await authenticate(anchor, net, publicKey);  // SEP-10, signed on the phone
 *   const { id, url } = await startDeposit(anchor, jwt, { asset, account, lang });
 *   // open `url` for the user, then poll:
 *   const tx = await fetchDepositTx(anchor, jwt, id);
 *
 * The anchor sends the asset straight to the user's own account. Ficha never
 * touches the money and nothing here ever sees the secret key: the SEP-10
 * challenge is checked (validateChallenge) and then signed through
 * src/wallet signTransaction.
 */
import { StellarToml, StrKey } from "@stellar/stellar-sdk";
import type { AssetRef, NetworkConfig } from "@/config";
import { signTransaction } from "@/wallet";
import { validateChallenge } from "./sep10";

export { validateChallenge } from "./sep10";

const TIMEOUT_MS = 20_000;

export class AnchorError extends Error {
  constructor(
    public code: "no_anchor" | "toml" | "network_mismatch" | "challenge" | "auth" | "deposit" | "status" | "http",
    message: string,
    /** The anchor's HTTP status, for code "http". */
    public status?: number,
  ) {
    super(message);
    this.name = "AnchorError";
  }
}

export interface AnchorCurrency {
  code: string;
  /** null = native XLM */
  issuer: string | null;
}

export interface Anchor {
  domain: string;
  webAuthEndpoint: string;
  signingKey: string;
  transferServer: string;
  /** Deposit assets the anchor offers AND the app counts as saldo (configured USDC, XLM). */
  assets: AnchorCurrency[];
}

function httpsUrl(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AnchorError("toml", `stellar.toml has no ${field}`);
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new AnchorError("toml", `${field} is not a URL`);
  }
  if (u.protocol !== "https:") throw new AnchorError("toml", `${field} must be https`);
  return value.replace(/\/+$/, "");
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new AnchorError("http", body?.error ?? `HTTP ${res.status}`, res.status);
  return body;
}

type InfoAsset = { enabled?: boolean };

/** Read the anchor's stellar.toml and SEP-24 /info for the given network. */
export async function resolveAnchor(net: NetworkConfig): Promise<Anchor> {
  const domain = net.anchorDomain;
  if (!domain) throw new AnchorError("no_anchor", "no anchor on this network");
  let toml: Record<string, unknown>;
  try {
    toml = (await StellarToml.Resolver.resolve(domain, { timeout: TIMEOUT_MS })) as Record<string, unknown>;
  } catch (e) {
    throw new AnchorError("toml", `stellar.toml: ${String(e)}`);
  }
  if (typeof toml.NETWORK_PASSPHRASE === "string" && toml.NETWORK_PASSPHRASE !== net.passphrase) {
    throw new AnchorError("network_mismatch", "anchor is on another network");
  }
  const signingKey = toml.SIGNING_KEY;
  if (typeof signingKey !== "string" || !StrKey.isValidEd25519PublicKey(signingKey)) throw new AnchorError("toml", "no SIGNING_KEY");
  const webAuthEndpoint = httpsUrl(toml.WEB_AUTH_ENDPOINT, "WEB_AUTH_ENDPOINT");
  const transferServer = httpsUrl(toml.TRANSFER_SERVER_SEP0024, "TRANSFER_SERVER_SEP0024");

  const currencies = (Array.isArray(toml.CURRENCIES) ? toml.CURRENCIES : []) as { code?: string; issuer?: string }[];
  const info = await getJson<{ deposit?: Record<string, InfoAsset> }>(`${transferServer}/info`);
  const enabled = (code: string) => info.deposit?.[code]?.enabled === true;

  const assets: AnchorCurrency[] = [];
  // USDC only when the anchor's USDC is the SAME asset (code AND issuer) the app counts as saldo.
  if (enabled(net.usdc.code) && currencies.some((c) => c.code === net.usdc.code && c.issuer === net.usdc.issuer)) {
    assets.push({ code: net.usdc.code, issuer: net.usdc.issuer });
  }
  if (enabled("native")) assets.push({ code: "XLM", issuer: null });
  return { domain, webAuthEndpoint, signingKey, transferServer, assets };
}

/** SEP-10: fetch the challenge, verify it, sign it with the unlocked key, get the session JWT. */
export async function authenticate(anchor: Anchor, net: NetworkConfig, account: string): Promise<string> {
  const ch = await getJson<{ transaction?: string; network_passphrase?: string }>(
    `${anchor.webAuthEndpoint}?account=${encodeURIComponent(account)}&home_domain=${encodeURIComponent(anchor.domain)}`,
  );
  if (!ch.transaction) throw new AnchorError("auth", "no challenge");
  const tx = validateChallenge(ch.transaction, {
    serverKey: anchor.signingKey,
    passphrase: net.passphrase,
    homeDomain: anchor.domain,
    webAuthEndpoint: anchor.webAuthEndpoint,
    account,
    serverPassphrase: ch.network_passphrase,
  });
  signTransaction(tx);
  const res = await getJson<Record<string, unknown>>(anchor.webAuthEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: tx.toXdr() }),
  });
  // SEP-10 names the JWT field "token".
  const jwt = res["token"];
  if (typeof jwt !== "string" || !jwt) throw new AnchorError("auth", "no JWT in the answer");
  return jwt;
}

/** SEP-24: start an interactive deposit of `asset` into `account`. */
export async function startDeposit(
  anchor: Anchor,
  jwt: string,
  p: { asset: AnchorCurrency; account: string; lang: string },
): Promise<{ id: string; url: string }> {
  const body: Record<string, string> = {
    asset_code: p.asset.issuer === null ? "native" : p.asset.code,
    account: p.account,
    lang: p.lang,
  };
  if (p.asset.issuer) body.asset_issuer = p.asset.issuer;
  const res = await getJson<{ type?: string; id?: string; url?: string }>(`${anchor.transferServer}/transactions/deposit/interactive`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  if (res.type !== "interactive_customer_info_needed" || !res.id || !res.url) throw new AnchorError("deposit", "unexpected deposit answer");
  if (new URL(res.url).protocol !== "https:") throw new AnchorError("deposit", "interactive URL is not https");
  return { id: res.id, url: res.url };
}

export interface DepositTx {
  id: string;
  status: string;
  amount_in?: string | null;
  amount_out?: string | null;
  amount_fee?: string | null;
  stellar_transaction_id?: string | null;
  message?: string | null;
  more_info_url?: string | null;
}

/** Statuses after which polling stops (SEP-24). */
export const FINAL_STATUSES = new Set(["completed", "refunded", "expired", "error", "no_market", "too_small", "too_large"]);

export async function fetchDepositTx(anchor: Anchor, jwt: string, id: string): Promise<DepositTx> {
  const res = await getJson<{ transaction?: DepositTx }>(`${anchor.transferServer}/transaction?id=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.transaction?.status) throw new AnchorError("status", "no transaction in the answer");
  return res.transaction;
}

/**
 * True when polling a deposit can never work again: the anchor refuses the
 * session's JWT or does not know the transaction. Network errors and 5xx are
 * worth retrying. An anchor that answers errors without CORS headers (the test
 * anchor's 403 has none) reaches the WebView as a network error instead: see
 * jwtExpired for the usual cause.
 */
export function isDepositGone(e: unknown): boolean {
  return e instanceof AnchorError && e.code === "http" && (e.status === 401 || e.status === 403 || e.status === 404);
}

/**
 * True once the SEP-10 JWT's exp has passed (24 h after login at the test
 * anchor): every request with it is refused from then on. False when the token
 * cannot be read, so an unusual token is still tried.
 */
export function jwtExpired(jwt: string, nowMs = Date.now()): boolean {
  try {
    const b64 = (jwt.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const exp: unknown = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))).exp;
    return typeof exp === "number" && nowMs >= exp * 1000;
  } catch {
    return false;
  }
}

/** The asset as the app's AssetRef. */
export function toAssetRef(a: AnchorCurrency): AssetRef {
  return { code: a.code, issuer: a.issuer };
}
