/** Turn any Stellar/Horizon failure into a short, translated, user-safe message. */
import { tr } from "@/i18n";
import { AmountError } from "./amount";
import { SubmitError } from "./tx";

const OP_CODES: Record<string, string> = {
  op_underfunded: "stellar.err.underfunded",
  op_low_reserve: "stellar.err.lowReserve",
  op_no_trust: "stellar.err.noTrust",
  op_src_no_trust: "stellar.err.srcNoTrust",
  op_no_destination: "stellar.err.noDestination",
  op_line_full: "stellar.err.lineFull",
  op_not_authorized: "stellar.err.notAuthorized",
};

export function describeStellarError(e: unknown): string {
  if (e instanceof SubmitError) {
    if (e.kind === "unknown") return tr("stellar.err.unknownOutcome");
    for (const op of e.resultCodes?.operations ?? []) if (OP_CODES[op]) return tr(OP_CODES[op]);
    const t = e.resultCodes?.transaction;
    if (t === "tx_bad_seq") return tr("stellar.err.badSeq");
    if (t === "tx_too_late") return tr("stellar.err.tooLate");
    if (t === "tx_insufficient_fee") return tr("stellar.err.fee");
    // The fee would take the account below its reserve (the payment itself fails as op_underfunded).
    if (t === "tx_insufficient_balance") return tr("stellar.err.feeReserve");
    return tr("stellar.err.rejected");
  }
  if (e instanceof AmountError) return tr("stellar.err.amount");
  if ((e as { name?: string })?.name === "WalletLockedError") return tr("stellar.err.locked");
  if ((e as { response?: { status?: number } })?.response?.status === 404) return tr("stellar.err.notFunded");
  if (e instanceof TypeError || (e as { name?: string })?.name === "TimeoutError") return tr("stellar.err.offline");
  return tr("stellar.err.generic");
}
