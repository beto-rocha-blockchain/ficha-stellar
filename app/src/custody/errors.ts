/**
 * What went wrong in a custody call, as a code the screens translate
 * (docs/station-app-contract.md §7.1, Errors). The contract's own errors
 * come by number; the asset contract's (the SAC that moves the money) are
 * told apart by the diagnostic events, since their numbers overlap: the
 * SAC's "account missing" is #6, like the escrow's OtherPayer.
 */
import { StrKey, scValToNative, type xdr } from "@stellar/stellar-sdk";

/** The escrow's errors, Error(Contract, #n) from its own contract ID. */
export const CONTRACT_ERRORS = {
  1: "BadConfig",
  2: "UnknownStation",
  3: "Inactive",
  4: "BadFichas",
  5: "NoSession",
  6: "OtherPayer",
  // 7 was AnchorMismatch: a session is its ID and its anchor now, so another anchor is another session.
  8: "Expired",
  9: "TooEarly",
  10: "BadProof",
  11: "Overflow",
  12: "TermsChanged",
  13: "NothingOwed",
} as const;

export type ContractErrorName = (typeof CONTRACT_ERRORS)[keyof typeof CONTRACT_ERRORS];

/**
 * The Stellar Asset Contract's errors a transfer can meet: the payer's own
 * (a deposit, or the refund leg of a claim: the host's leg never fails a
 * claim, its share is kept for it instead). #14: an XLM payment too small to
 * create the missing account it goes to.
 */
const ASSET_ERRORS: Record<number, AssetErrorCode> = { 6: "no_account", 10: "balance", 11: "not_authorized", 13: "no_trustline", 14: "no_account" };
type AssetErrorCode = "no_account" | "balance" | "not_authorized" | "no_trustline" | "asset";

export type EscrowErrorCode =
  | ContractErrorName
  /** The asset contract refused the transfer. */
  | AssetErrorCode
  /** Some other contract error: `detail` has it. */
  | "contract"
  /** A signature is missing or wrong (only when sent). */
  | "auth"
  /** A ledger entry the call needs was archived: it must be restored first. */
  | "archived"
  /** The simulation asks to authorize something other than this call. */
  | "bad_auth"
  | "fee_too_high"
  /** The source account does not exist on the ledger. */
  | "not_funded"
  /** The network refused the transaction (`detail`: the result code); nothing happened. */
  | "rejected"
  /** The RPC asked to try again later; nothing was sent. */
  | "busy"
  /** The transaction's time ran out before it was included: nothing happened. */
  | "too_late"
  /** No answer: it MAY have been applied. Check before trying again. */
  | "unknown_outcome"
  /** The session read again right before a deposit is not what the page showed (settled, topped up, past the station's end): nothing was signed. */
  | "session_changed"
  /** The pay link's session (its ID and anchor) was paid and settled meanwhile: the QR is old. Nothing was signed. */
  | "stale_qr"
  /** The session's events could not all be read: whether it was already used is unknown, so nothing was signed. */
  | "unchecked";

export class EscrowError extends Error {
  constructor(
    public code: EscrowErrorCode,
    public detail?: string,
  ) {
    super(`escrow: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "EscrowError";
  }
}

interface ErrorEvent {
  contract: string | null;
  error: xdr.ScError;
}

/** The `error` diagnostic events, oldest first: the first one is the cause. */
function errorEvents(events: readonly xdr.DiagnosticEvent[]): ErrorEvent[] {
  const out: ErrorEvent[] = [];
  for (const d of events) {
    const body = d.event.body;
    if (body.type !== "v0") continue;
    const [name, err] = body.v0.topics;
    if (name?.type !== "scvSymbol" || scValToNative(name) !== "error" || err?.type !== "scvError") continue;
    out.push({ contract: d.event.contractId ? StrKey.encodeContract(d.event.contractId.toBytes()) : null, error: err.error });
  }
  return out;
}

/**
 * A failed simulation or transaction as an EscrowError. `message` is the
 * RPC's error text ("HostError: Error(Contract, #6) ..."), used only when
 * there are no diagnostic events to say which contract failed.
 */
export function classifyFailure(message: string | undefined, events: readonly xdr.DiagnosticEvent[], escrow: string): EscrowError {
  const first = errorEvents(events)[0];
  if (first) {
    const e = first.error;
    if (e.type === "sceAuth") return new EscrowError("auth");
    if (e.type === "sceContract") {
      const code = e.contractCode;
      if (first.contract === escrow) {
        const name = CONTRACT_ERRORS[code as keyof typeof CONTRACT_ERRORS];
        return name ? new EscrowError(name) : new EscrowError("contract", `#${code}`);
      }
      return new EscrowError(ASSET_ERRORS[code] ?? "asset", `${first.contract ?? "?"} #${code}`);
    }
    return new EscrowError("contract", e.type);
  }
  if (message && /Error\(Auth,/.test(message)) return new EscrowError("auth");
  const m = message ? /Error\(Contract, #(\d+)\)/.exec(message) : null;
  // Without events the number cannot say which contract raised it.
  return new EscrowError("contract", m ? `#${m[1]}` : message?.split("\n")[0]);
}
