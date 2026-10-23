/** A custody failure as a short, translated message (src/i18n/custody.ts); anything else as describeStellarError does. */
import { DICTS, tr } from "@/i18n";
import { describeStellarError } from "@/stellar/errors";
import { EscrowError } from "./errors";

export function describeEscrowError(e: unknown): string {
  if (e instanceof EscrowError) return tr(`custody.err.${e.code}`);
  return describeStellarError(e);
}

/** The same for host mode: its own wording where the payer's would mislead (src/i18n/host.ts err.*). */
export function describeHostError(e: unknown): string {
  if (e instanceof EscrowError && DICTS["pt-BR"][`host.err.${e.code}`] !== undefined) return tr(`host.err.${e.code}`);
  return describeEscrowError(e);
}
