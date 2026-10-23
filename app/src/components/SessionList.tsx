/** List of the wallet's charging sessions (History and a station's page). */
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Clock, ShieldQuestion, Undo2, Vault, Zap } from "lucide-react";
import type { DepositRecord } from "@/custody/deposits-store";
import { claimHref, refundWindow } from "@/custody/receipt";
import { maybeOpen } from "@/custody/sessions";
import { useLang, useT } from "@/i18n";
import { formatDateTime, formatDeadline } from "@/lib/format";
import { formatMmss, formatWh } from "@/pay/format";
import { receiptShareFraction, receiptStanding } from "@/pay/history";
import { unusedSeconds } from "@/pay/receipt";
import type { StoredReceipt } from "@/pay/receipts-store";
import type { SessionRow } from "@/pay/useSessions";
import { stationForMemo, type Registry } from "@/registry";
import { compareAmounts, formatAmount, fromStroops } from "@/stellar";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function stationFor(row: SessionRow, registry: Registry | null) {
  return stationForMemo(registry, row.stationId, row.hostKey);
}

export function SessionList({ rows, registry }: { rows: SessionRow[]; registry: Registry | null }) {
  const t = useT("pay");
  const { lang } = useLang();
  return (
    <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border bg-card">
      {rows.map((s) => {
        const st = stationFor(s, registry);
        const rc = s.receipt;
        // A custody receipt is confirmed against the deposit (the receipt screen), one payer per session.
        const standing = rc ? (s.custody ? { state: rc.check } : receiptStanding(s, rc)) : null;
        // Several wallets paid the session: this wallet's part of it (History counts only its own payments).
        const part = rc && !s.custody ? receiptShareFraction(rc) : 1;
        // Paid time the station did not deliver (not_plugged, paused_too_long, ESC): logged for a manual
        // refund. In custody mode it comes back with the receipt's proof instead (the custody line below).
        const unused = rc && !s.custody ? Math.round(unusedSeconds(rc.receipt) * part) : 0;
        // Several wallets paid the session: the row's amount is this wallet's part of the receipt.
        const share =
          rc?.check === "confirmed" && rc.share && compareAmounts(rc.share, rc.receipt.amount) < 0
            ? t("r.share", { share: formatAmount(rc.share, lang, 7, 0), total: formatAmount(rc.receipt.amount, lang, 7, 0), code: rc.receipt.assetCode })
            : null;
        return (
          <li key={`${s.hostKey}|${s.memo}|${s.custody?.anchor ?? ""}`} className="space-y-1 px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              {st ? (
                <Link to="/stations/$id" params={{ id: st.id }} className="truncate font-medium hover:text-primary">
                  {st.name}
                </Link>
              ) : (
                <span className="truncate font-medium text-muted-foreground">{s.stationId ? t("h.unknownStation") : t("h.legacy")}</span>
              )}
              <span className="shrink-0 font-mono text-sm tabular">
                {formatAmount(s.amount, lang, 7, 0)} {s.assetCode}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>{formatDateTime(s.startedAt, lang)}</span>
              <span className="font-mono">{s.memo}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              {rc ? (
                <>
                  <span className={cn("flex items-center gap-1", rc.receipt.verdict === "delivered" ? "text-success" : rc.receipt.verdict === "no_current" ? "text-destructive" : "text-warning")}>
                    <Zap className="h-3 w-3" /> {t(`r.verdict.${rc.receipt.verdict}`)}
                  </span>
                  <span className="font-mono">{formatWh(rc.receipt.wh, lang)} Wh</span>
                  <span className="font-mono">{rc.receipt.maxMa} mA</span>
                  {standing?.state === "confirmed" ? (
                    <span className="flex items-center gap-1 text-success">
                      <CheckCircle2 className="h-3 w-3" /> {t("r.confirmed")}
                    </span>
                  ) : standing?.state === "uncredited" ? (
                    <span className="flex items-center gap-1 text-destructive">
                      <AlertTriangle className="h-3 w-3" /> {t("h.uncredited", { amount: formatAmount(standing.extra, lang, 7, 0), code: s.assetCode })}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-warning">
                      <ShieldQuestion className="h-3 w-3" /> {t("r.notConfirmed")}
                    </span>
                  )}
                  {share && standing?.state !== "not_confirmed" && <span className="font-mono text-muted-foreground">{share}</span>}
                  {unused > 0 && (
                    <span className="flex items-center gap-1 text-warning">
                      <Clock className="h-3 w-3" /> {t(part < 1 ? "h.unusedShare" : "h.unused", { min: formatMmss(unused) })}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground/70">{t("h.noReceipt")}</span>
              )}
              {s.custody && <CustodyLine d={s.custody} stored={rc} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Where a custody session's money is: in the contract until when, or how it
 * settled (contract §7). While the session may be open and a receipt with a
 * refund is kept, it leads back to the claim (/r): the station shows one
 * receipt at a time, so the phone's copy may be the only one left.
 */
function CustodyLine({ d, stored }: { d: DepositRecord; stored?: StoredReceipt }) {
  const t = useT("custody");
  const { lang } = useLang();
  const navigate = useNavigate();
  const money = (stroops: string | undefined) => `${formatAmount(fromStroops(BigInt(stroops ?? 0)), lang, 7, 0)}`;
  const s = d.settled;
  const phase = refundWindow(d, Date.now() / 1000);
  const href = maybeOpen(d) ? claimHref(d, stored) : null;
  const claim = href && (
    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => void navigate({ href })}>
      <Undo2 className="h-3 w-3" /> {t(phase === "open" ? "h.claim" : "h.seeReceipt")}
    </Button>
  );
  if (!s) {
    // By the phone's clock, for display only: the receipt screen asks the ledger.
    return (
      <>
        <span className={cn("flex items-center gap-1", phase === "open" ? "text-primary" : "text-muted-foreground")}>
          <Vault className="h-3 w-3" />{" "}
          {phase === "open" ? t("h.open", { time: formatDeadline(d.deadline, lang) }) : t("h.past", { time: formatDeadline(d.deadline, lang) })}
        </span>
        {claim}
      </>
    );
  }
  if (s.how === "proof" || s.how === "host") {
    return (
      <span className="flex items-center gap-1 text-success">
        <Undo2 className="h-3 w-3" /> {t(s.how === "proof" ? "h.refunded" : "h.hostRefund", { amount: money(s.toPayer), code: d.asset.code })}
      </span>
    );
  }
  return (
    <>
      <span className="flex items-center gap-1 text-muted-foreground">
        <Vault className="h-3 w-3" /> {t(s.how === "deadline" ? "h.toHostAll" : s.how === "reset" ? "h.reset" : "h.settled")}
      </span>
      {claim}
    </>
  );
}
