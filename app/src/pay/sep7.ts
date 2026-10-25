/**
 * SEP-0007 `web+stellar:pay` parsing and Ficha memo parsing
 * (docs/station-app-contract.md §1). The app pays only these QRs.
 */
import { Networks, StrKey } from "@stellar/stellar-sdk";
import type { AssetRef } from "@/config";
import { isValidAmount, toStroops } from "@/stellar/amount";

const A = "[2-9A-HJKMNP-TV-Z]";
const SESSION_RE = new RegExp(`^F${A}{7}$`);
const PREFIXED_RE = new RegExp(`^(${A}{6})\\.(F${A}{7})$`);

export type FichaMemo =
  | { kind: "station"; stationId: string; session: string; memo: string }
  | { kind: "legacy"; session: string; memo: string };

/** `K7M2QX.F3H9TXAB` -> station memo; `F3H9TXAB` -> legacy; anything else -> null. */
export function parseFichaMemo(memo: string): FichaMemo | null {
  const m = PREFIXED_RE.exec(memo);
  if (m) return { kind: "station", stationId: m[1], session: m[2], memo };
  if (SESSION_RE.test(memo)) return { kind: "legacy", session: memo, memo };
  return null;
}

export interface PayRequest {
  destination: string;
  /** The amount the QR asks for (the station puts one ficha's price here). */
  amount: string | null;
  asset: AssetRef;
  memo: string;
  msg: string | null;
  networkPassphrase: string | null;
  uri: string;
}

/**
 * The network a request is for. SEP-0007: without network_passphrase it is
 * the public network, and the station leaves it out there (stellar.py sep7_uri).
 */
export function requestPassphrase(req: Pick<PayRequest, "networkPassphrase">): string {
  return req.networkPassphrase ?? Networks.PUBLIC;
}

export class Sep7Error extends Error {
  constructor(
    public code: "not_pay" | "bad_destination" | "bad_amount" | "bad_asset" | "no_memo" | "memo_type" | "memo_too_long",
  ) {
    super(`SEP-0007: ${code}`);
    this.name = "Sep7Error";
  }
}

export function isSep7Pay(text: string): boolean {
  return /^web\+stellar:pay\?/i.test(text.trim());
}

export function parseSep7Pay(text: string): PayRequest {
  const uri = text.trim();
  if (!isSep7Pay(uri)) throw new Sep7Error("not_pay");
  const q = new URLSearchParams(uri.slice(uri.indexOf("?") + 1));
  const destination = q.get("destination") ?? "";
  // Only plain G... accounts: a station's host key is never a muxed or contract address.
  if (!StrKey.isValidEd25519PublicKey(destination)) throw new Sep7Error("bad_destination");

  const rawAmount = q.get("amount");
  let amount: string | null = null;
  if (rawAmount !== null && rawAmount !== "") {
    if (!isValidAmount(rawAmount) || toStroops(rawAmount) <= 0n) throw new Sep7Error("bad_amount");
    amount = rawAmount.trim();
  }

  const code = q.get("asset_code");
  const issuer = q.get("asset_issuer");
  let asset: AssetRef;
  if (!code || (code.toUpperCase() === "XLM" && !issuer)) {
    if (issuer) throw new Sep7Error("bad_asset");
    asset = { code: "XLM", issuer: null };
  } else {
    if (!issuer || !StrKey.isValidEd25519PublicKey(issuer) || !/^[A-Za-z0-9]{1,12}$/.test(code)) throw new Sep7Error("bad_asset");
    asset = { code, issuer };
  }

  const memo = q.get("memo");
  if (!memo) throw new Sep7Error("no_memo");
  const memoType = q.get("memo_type");
  if (memoType !== null && memoType.toUpperCase() !== "MEMO_TEXT") throw new Sep7Error("memo_type");
  if (new TextEncoder().encode(memo).length > 28) throw new Sep7Error("memo_too_long");

  return {
    destination,
    amount,
    asset,
    memo,
    msg: q.get("msg"),
    networkPassphrase: q.get("network_passphrase"),
    uri,
  };
}
