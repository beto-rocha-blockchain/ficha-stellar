/** What a station's receipt says (energy, amount, paid and charging time...): the same panel for v1 and v2 receipts. */
import { AlertTriangle, CheckCircle2, ReceiptText, Zap } from "lucide-react";
import { useLang, useT } from "@/i18n";
import { formatDateTime } from "@/lib/format";
import { formatMmss as mmss, formatWh } from "@/pay/format";
import type { Receipt } from "@/pay/receipt";
import { formatAmount } from "@/stellar";
import { cn } from "@/lib/utils";

export function ReceiptFacts({ receipt: r, title }: { receipt: Receipt; title: string }) {
  const t = useT("pay");
  const tc = useT("common");
  const { lang } = useLang();
  const verdictTone = r.verdict === "delivered" ? "text-success" : r.verdict === "no_current" ? "text-destructive" : "text-warning";
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="label-op flex items-center gap-1.5">
          <ReceiptText className="h-3.5 w-3.5" /> {title}
        </span>
        <span className={cn("flex items-center gap-1 font-mono text-[11px]", verdictTone)}>
          <Zap className="h-3.5 w-3.5" /> {t(`r.verdict.${r.verdict}`)}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-border">
        <Cell label={t("r.energy")} value={`${formatWh(r.wh, lang)} Wh`} big />
        <Cell label={t("r.amount")} value={`${formatAmount(r.amount, lang, 7, 0)} ${r.assetCode}`} big />
        <Cell label={t("r.paid")} value={`${mmss(r.paidSeconds)} · ${r.fichas === 1 ? tc("ficha") : tc("fichas", { n: r.fichas })}`} />
        <Cell label={t("r.used")} value={mmss(r.usedSeconds)} />
        <Cell label={t("r.maxCurrent")} value={`${r.maxMa} mA`} />
        <Cell label={t("r.finished")} value={formatDateTime(r.finishedAt * 1000, lang)} />
      </dl>
      <div className="space-y-1 p-3 text-[12px]">
        <div className="flex items-center gap-1.5">
          {r.cutConfirmed ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <AlertTriangle className="h-3.5 w-3.5 text-warning" />}
          {r.cutConfirmed ? t("r.cut") : t("r.cutNo")}
        </div>
        <div className="font-mono text-muted-foreground">
          {t("r.memo")}: <span className="text-foreground">{r.memo}</span>
        </div>
      </div>
    </div>
  );
}

function Cell({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="bg-card p-3">
      <dt className="label-op">{label}</dt>
      <dd className={cn("mt-1 font-mono tabular", big ? "text-lg font-semibold" : "text-sm")}>{value}</dd>
    </div>
  );
}
