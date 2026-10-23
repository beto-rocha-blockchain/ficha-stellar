/**
 * Histórico: the wallet's payments to registry host keys (Horizon, join=transactions
 * for the memo), grouped by session memo and joined with scanned receipts.
 */
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { SessionList, stationFor } from "@/components/SessionList";
import { Skeleton } from "@/components/ui/skeleton";
import { useLang, useT } from "@/i18n";
import { receiptShareFraction } from "@/pay/history";
import { useSessions } from "@/pay/useSessions";
import { describeStellarError } from "@/stellar";

export const Route = createFileRoute("/history")({ component: HistoryScreen });

function HistoryScreen() {
  const t = useT("pay");
  const tc = useT("common");
  const { lang } = useLang();
  const { rows, loading, error, refresh, registry } = useSessions();

  // A session several wallets paid counts by this wallet's share of it.
  const wh = (rows ?? []).reduce((sum, r) => sum + (r.receipt ? r.receipt.receipt.wh * receiptShareFraction(r.receipt) : 0), 0);
  const stations = new Set((rows ?? []).map((r) => stationFor(r, registry)?.id ?? r.stationId ?? r.hostKey)).size;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("h.title")}
        actions={
          <Button variant="outline" size="icon" onClick={() => void refresh()} aria-label={tc("refresh")}>
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        }
      />

      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border">
        <Kpi label={t("h.sessions")} value={rows ? String(rows.length) : "—"} />
        <Kpi label={t("h.energy")} value={rows ? `${wh.toLocaleString(lang === "pt-BR" ? "pt-BR" : "en-US", { maximumFractionDigits: 1 })} Wh` : "—"} />
        <Kpi label={t("h.stations")} value={rows ? String(stations) : "—"} />
      </div>

      {error != null && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-destructive" /> {t("h.loadFail")}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">{describeStellarError(error)}</p>
        </div>
      )}

      {!rows && loading && (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
      {rows && rows.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t("h.empty")}</p>}
      {rows && rows.length > 0 && <SessionList rows={rows} registry={registry} />}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card p-3">
      <div className="label-op">{label}</div>
      <div className="kpi-num mt-1 text-lg">{value}</div>
    </div>
  );
}
