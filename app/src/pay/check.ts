/**
 * A station's pay QR checked against the signed registry (contract §4)
 * before the confirm button is enabled. A custody station is paid only by
 * deposit, from its own pay link (src/routes/p.tsx): its SEP-0007 QR is refused.
 * Off the testnet the money is real: a QR without a station code is paid only
 * to the one station the registry lists at its address, at that station's price.
 */
import type { NetworkConfig } from "@/config";
import { isCustody, maxFichas, stationById, stationsByHostKey, type Registry, type Station } from "@/registry/verify";
import { compareAmounts, toStroops } from "@/stellar/amount";
import { sameAsset } from "@/stellar/horizon";
import type { MyPayment } from "./history";
import { requestPassphrase, type FichaMemo, type PayRequest } from "./sep7";

export type Check =
  | { state: "ok"; station: Station }
  /** The QR is for another network than the app's (no network_passphrase = the public network). */
  | { state: "wrong_network" }
  | { state: "mismatch"; stationId: string }
  | { state: "asset_mismatch"; station: Station }
  | { state: "price_mismatch"; station: Station }
  | { state: "unknown_station"; stationId: string }
  | { state: "inactive"; stationId: string }
  /** The registry sells this station in custody mode: never a direct payment to its host. */
  | { state: "custody_only"; stationId: string }
  /** stationId null: a QR without a station code, off the testnet. */
  | { state: "no_registry"; stationId: string | null }
  /** Off the testnet, a QR without a station code whose address is not exactly one listed station's. */
  | { state: "unlisted" }
  | { state: "legacy"; station: Station | null };

/**
 * The station puts one ficha at its own FICHA_PRICE in the QR and credits
 * by that price; a QR asking another price than the registry means one of
 * them is wrong, and the fichas and minutes the app shows would not be what
 * the station credits.
 */
function priceDiffers(req: PayRequest, st: Station): boolean {
  return req.amount !== null && compareAmounts(req.amount, st.ficha_price) !== 0;
}

export function checkAgainstRegistry(req: PayRequest, memo: FichaMemo, reg: Registry | null, net: Pick<NetworkConfig, "id" | "passphrase">): Check {
  if (requestPassphrase(req) !== net.passphrase) return { state: "wrong_network" };
  if (memo.kind === "legacy") {
    // On the testnet a legacy QR may still be paid at its own amount after
    // "I understand the risk"; with real money, never on the QR's word alone.
    const listedOnly = net.id !== "testnet";
    if (listedOnly && !reg) return { state: "no_registry", stationId: null };
    // A custody station always has a station ID: a QR without one is not its.
    const known = stationsByHostKey(reg, req.destination).filter((s) => sameAsset(s.asset, req.asset) && !isCustody(s));
    // active: false is how the operator stops payments to a station: a QR
    // without a station code must not get around it (nor say there is no data).
    if (known.length > 0 && known.every((s) => !s.active)) return { state: "inactive", stationId: known.map((s) => s.id).join(", ") };
    const hits = known.filter((s) => s.active);
    const station = hits.length === 1 ? hits[0] : null;
    if (listedOnly && !station) return { state: "unlisted" };
    if (station && priceDiffers(req, station)) return { state: "price_mismatch", station };
    return { state: "legacy", station };
  }
  const id = memo.stationId;
  if (!reg) return { state: "no_registry", stationId: id };
  const st = stationById(reg, id);
  if (!st) return { state: "unknown_station", stationId: id };
  if (st.host_key !== req.destination) return { state: "mismatch", stationId: id };
  if (isCustody(st)) return { state: "custody_only", stationId: id };
  if (!sameAsset(st.asset, req.asset)) return { state: "asset_mismatch", station: st };
  if (!st.active) return { state: "inactive", stationId: id };
  if (priceDiffers(req, st)) return { state: "price_mismatch", station: st };
  return { state: "ok", station: st };
}

/** Fichas the station credited for these payments: it floors each payment on its own. */
export function fichasPaid(payments: Pick<MyPayment, "amount">[], fichaPrice: string): number {
  const price = toStroops(fichaPrice);
  let n = 0n;
  for (const p of payments) n += toStroops(p.amount) / price;
  return Number(n);
}

/**
 * Fichas a session can still take. The station caps a session at
 * max_session_minutes from its start (session.py _extend), so what was
 * already paid for it counts against the cap (contract §4), whichever wallet
 * paid it: pass this wallet's payments and the others' (fetchSessionPayments).
 */
export function fichasLeft(station: Station, paid: Pick<MyPayment, "amount">[]): number {
  return Math.max(0, maxFichas(station) - fichasPaid(paid, station.ficha_price));
}
