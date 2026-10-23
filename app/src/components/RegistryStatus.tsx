/** One-line state of the signed station registry: which copy is in use (live / bundled / cached) and its issued_at, and why not the live one. */
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { useLang, useT } from "@/i18n";
import { dateLocale, formatDateTime } from "@/lib/format";
import { registryNotice, useRegistry } from "@/registry";

/** issued_at is UTC (contract §2): shown in UTC, so a registry issued at 00:00Z is not "the day before" in Brazil. */
export function formatIssued(iso: string | undefined, lang: "pt-BR" | "en"): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return iso ?? "?";
  const s = new Date(t).toLocaleString(dateLocale(lang), { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
  return `${s} UTC`;
}

export function RegistryStatus() {
  const t = useT("pay");
  const { lang } = useLang();
  const reg = useRegistry();
  const notice = registryNotice(reg);
  const date = reg.savedAt ? formatDateTime(reg.savedAt, lang) : "";
  const issued = formatIssued(reg.issuedAt, lang);
  if (notice === "loading") {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </div>
    );
  }
  if (notice === "none" || notice === "failed") {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px]">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
        {notice === "none" ? t("st.noRegistry") : t("st.failed")}
      </div>
    );
  }
  if (notice === "rejected" || notice === "older") {
    return (
      <div role="alert" className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-[11px]">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
        {notice === "older"
          ? t("st.older", { live: formatIssued(reg.liveIssuedAt, lang), issued })
          : reg.source === "cache"
            ? t("st.rejected", { date, issued })
            : t("st.rejectedBundled", { issued })}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" />
      {notice === "cached" ? t("st.cached", { date, issued }) : notice === "bundled" ? t("st.bundled", { issued }) : t("st.verified", { issued })}
    </div>
  );
}
