/**
 * A custody pay link checked before the confirm button is enabled
 * (docs/station-app-contract.md §7.4, steps 1 to 4): against the app's
 * network, the signed registry, the contract's code and the station's terms
 * on the ledger, and the session already open there. Pure functions.
 */
import type { NetworkConfig } from "@/config";
import { isCustody, maxFichas, stationById, type CustodyStation, type Registry } from "@/registry/verify";
import { toStroops } from "@/stellar/amount";
import { sameBytes, toB64url } from "./chain";
import type { DepositRecord } from "./deposits-store";
import { assetContract, type EscrowEvent, type EscrowSession, type EscrowView, type StationTerms } from "./escrow";
import type { PayLink } from "./link";

export type RegistryCheck =
  | { state: "ok"; station: CustodyStation }
  | { state: "wrong_network" }
  | { state: "no_custody" }
  | { state: "no_registry" }
  | { state: "unknown_station"; stationId: string }
  | { state: "mismatch"; stationId: string }
  | { state: "not_custody"; stationId: string }
  /** A custody station in an asset other than XLM: refused for now (custodyAssetOk). */
  | { state: "custody_asset"; stationId: string }
  | { state: "inactive"; stationId: string };

/**
 * Custody takes native XLM only, for now (review R2C2): a credit asset's
 * issuer can deauthorize a payer's balance before the claim, or claw back
 * the contract's own balance, and the refund the proof grants then never
 * comes (the contract trusts the token). XLM has no issuer.
 */
export function custodyAssetOk(st: Pick<CustodyStation, "asset">): boolean {
  return st.asset.issuer === null;
}

/** Steps 1 and 2: the link's network is the app's, and the registry lists the station under this host, active, in custody mode. */
export function checkRegistry(link: PayLink, reg: Registry | null, net: NetworkConfig): RegistryCheck {
  if (link.network !== net.id) return { state: "wrong_network" };
  if (!net.custody) return { state: "no_custody" };
  if (!reg) return { state: "no_registry" };
  const st = stationById(reg, link.stationId);
  if (!st) return { state: "unknown_station", stationId: link.stationId };
  if (st.host_key !== link.hostKey) return { state: "mismatch", stationId: link.stationId };
  if (!isCustody(st)) return { state: "not_custody", stationId: link.stationId };
  if (!custodyAssetOk(st)) return { state: "custody_asset", stationId: link.stationId };
  if (!st.active) return { state: "inactive", stationId: link.stationId };
  return { state: "ok", station: st };
}

export type TermsField = "token" | "price" | "ficha_secs" | "max_fichas" | "unit_secs" | "grace_secs";

/**
 * Step 3: where the station's terms on the contract differ from its signed
 * registry entry (token = the asset's SAC, price = ficha_price x 10^7,
 * ficha_secs, max_fichas, unit_secs, grace_secs). Empty = they match.
 */
export function termsMismatches(st: CustodyStation, t: StationTerms, net: NetworkConfig): TermsField[] {
  const out: TermsField[] = [];
  if (t.token !== assetContract(st.asset, net)) out.push("token");
  if (t.price !== toStroops(st.ficha_price)) out.push("price");
  if (t.fichaSecs !== st.ficha_minutes * 60) out.push("ficha_secs");
  if (t.maxFichas !== maxFichas(st)) out.push("max_fichas");
  if (t.unitSecs !== st.unit_seconds) out.push("unit_secs");
  if (t.graceSecs !== st.grace_seconds) out.push("grace_secs");
  return out;
}

export type ChainCheck =
  | { state: "ok"; terms: StationTerms }
  /** The registry's escrow runs code the app does not pin (or is not a contract). */
  | { state: "unknown_code"; wasmHash: string | null }
  /** No terms under (host, station) on the contract. */
  | { state: "not_registered" }
  | { state: "archived" }
  | { state: "inactive" }
  | { state: "terms_differ"; fields: TermsField[] };

/** Steps 2 (the code) and 3 (the terms), from one readEscrow. */
export function checkChain(st: CustodyStation, view: EscrowView, net: NetworkConfig): ChainCheck {
  const pinned = net.custody?.escrowWasm ?? [];
  if (!view.wasmHash || !pinned.includes(view.wasmHash)) return { state: "unknown_code", wasmHash: view.wasmHash };
  if (!view.station) return { state: "not_registered" };
  if (view.archived) return { state: "archived" };
  const fields = termsMismatches(st, view.station, net);
  if (fields.length > 0) return { state: "terms_differ", fields };
  if (!view.station.active) return { state: "inactive" };
  return { state: "ok", terms: view.station };
}

/**
 * The station's claim window (its CLAIM_WINDOW_SECONDS, contract §7.5 and
 * §7.7): it ends every custody session this long before the session's
 * deadline, leaving the payer that long to claim, and credits nothing after.
 */
export const CLAIM_WINDOW_SECONDS = 900;

/**
 * A top-up is refused this much before the station's end too: the time from
 * reading the ledger to the deposit landing (signing, sending, a ledger or
 * two). The deposit itself would still go through: the station would not
 * serve it.
 */
export const TOPUP_MARGIN_SECONDS = 30;

export type DepositPlan =
  /** No session open: a new one, 1 to `max` fichas at `price` (stroops). */
  | { kind: "new"; max: number; price: bigint }
  /** This wallet's session with this anchor: a top-up of 1 to `max`, at the session's own price. */
  | { kind: "topup"; max: number; price: bigint; session: EscrowSession }
  /** This wallet's session already holds every ficha it may. */
  | { kind: "full"; session: EscrowSession }
  /** Its deadline has passed: the host gets it at release. */
  | { kind: "expired"; session: EscrowSession }
  /** The station has ended it (its claim window before the deadline has begun): a top-up would never be served. */
  | { kind: "ended"; session: EscrowSession }
  /** Another wallet paid this session (its ID and this QR's anchor): ask the station for a new QR. */
  | { kind: "taken" };

/**
 * Step 4: what a deposit into this session can be. `ledgerNow` is the
 * ledger's time (src/custody/escrow.ts ledgerTime), never the phone's clock;
 * null = unknown, and the simulation has the last word (Expired). A top-up
 * ends where the station ends the session, CLAIM_WINDOW_SECONDS before its
 * deadline (less TOPUP_MARGIN_SECONDS): the contract would take it until the
 * deadline, but no station would serve it.
 */
export function planDeposit(session: EscrowSession | null, me: string, link: Pick<PayLink, "anchor">, terms: StationTerms, ledgerNow: number | null): DepositPlan {
  if (!session) return { kind: "new", max: terms.maxFichas, price: terms.price };
  if (session.payer !== me || !sameBytes(session.anchor, link.anchor)) return { kind: "taken" };
  if (ledgerNow !== null && ledgerNow > session.deadline) return { kind: "expired", session };
  if (ledgerNow !== null && ledgerNow >= session.deadline - CLAIM_WINDOW_SECONDS - TOPUP_MARGIN_SECONDS) return { kind: "ended", session };
  const max = session.maxFichas - session.fichas;
  if (max <= 0) return { kind: "full", session };
  return { kind: "topup", max, price: session.price, session };
}

/**
 * Step 4, a new session: the link's session (its ID and its anchor) was
 * already paid, by anyone, while no session is open under it now. It was
 * settled: the QR is stale (another payer's finished session, a page left
 * open), and a deposit would open a session no station serves. `events` are
 * the session ID's deposit and settle events (sessionEvents); another anchor
 * under the same ID is another session and does not count.
 */
export function staleSession(events: readonly EscrowEvent[], link: Pick<PayLink, "session" | "anchor">): boolean {
  return events.some((e) => e.session === link.session && sameBytes(e.anchor, link.anchor));
}

/**
 * A record's ledger this far past the network's latest ledger means the
 * network was reset since (the testnet's resets start the ledger over from
 * 1): its session went with the old ledger, and no RPC node is merely
 * behind by this much. The station drops its saved cursors by the same
 * margin (contract §7.10).
 */
export const LEDGER_RESET_MARGIN = 1000;

export function ledgerWasReset(recordLedger: number | undefined, latestLedger: number): boolean {
  return recordLedger !== undefined && latestLedger > 0 && recordLedger > latestLedger + LEDGER_RESET_MARGIN;
}

/**
 * Step 4, this phone's side: whether this wallet's own session under the
 * link is over. A receipt kept for it (the station shows one only when the
 * session is finished), a settlement seen (not one only guessed from a
 * missing read while the contract shows it open), or its record with no
 * session on the contract. "lagging": the RPC node answered at a ledger
 * before the record's first deposit, so the missing session says nothing yet.
 * `record` must be this link's (same anchor).
 */
export function sessionOver(
  local: { record?: DepositRecord; receipt: boolean },
  view: Pick<EscrowView, "session" | "latestLedger">,
  me: string,
): "over" | "lagging" | null {
  const r = local.record;
  if (local.receipt) return "over";
  const open = r !== undefined && view.session !== null && view.session.payer === me && toB64url(view.session.anchor) === r.anchor;
  if (r?.settled && !(r.settled.how === "unknown" && open)) return "over";
  // Missing at a ledger before its first deposit's: a node behind, unless the network was reset since.
  if (r && view.session === null) return r.ledger !== undefined && view.latestLedger < r.ledger && !ledgerWasReset(r.ledger, view.latestLedger) ? "lagging" : "over";
  return null;
}
