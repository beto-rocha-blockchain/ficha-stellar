/**
 * Estações: map (Leaflet + OSM tiles, online only) and list from the SIGNED
 * registry (src/registry). Public route: works while locked or without a wallet.
 */
import { Suspense, lazy, useEffect, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ChevronRight, MapPin, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { RegistryStatus } from "@/components/RegistryStatus";
import { useLang, useT } from "@/i18n";
import { useRegistry, type Station } from "@/registry";
import { formatAmount } from "@/stellar";
import { cn } from "@/lib/utils";

const StationsMap = lazy(() => import("@/components/StationsMap"));

export const Route = createFileRoute("/stations/")({ component: StationsScreen });

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

function StationsScreen() {
  const t = useT("pay");
  const tc = useT("common");
  const { registry, status, reload } = useRegistry();
  const online = useOnline();
  const stations = registry?.stations ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        label={t("st.label")}
        title={t("st.title")}
        actions={
          <Button variant="outline" size="icon" onClick={() => void reload()} aria-label={tc("refresh")}>
            <RefreshCw className={status === "loading" ? "animate-spin" : ""} />
          </Button>
        }
      />
      <RegistryStatus />

      {stations.length > 0 &&
        (online ? (
          <Suspense fallback={<Skeleton className="h-64 w-full md:h-80" />}>
            <StationsMap stations={stations} />
          </Suspense>
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[12px] text-muted-foreground">
            <WifiOff className="h-4 w-4" /> {t("st.offlineMap")}
          </div>
        ))}

      {status === "loading" && !registry && <Skeleton className="h-20 w-full" />}
      {registry && stations.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t("st.empty")}</p>}
      {stations.length > 0 && (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border bg-card">
          {stations.map((s) => (
            <StationRow key={s.id} s={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

function StationRow({ s }: { s: Station }) {
  const t = useT("pay");
  const { lang } = useLang();
  return (
    <li>
      <Link to="/stations/$id" params={{ id: s.id }} className="flex items-center gap-3 px-3 py-3 transition-colors hover:bg-muted/40">
        <MapPin className={cn("h-5 w-5 shrink-0", s.active ? "text-primary" : "text-muted-foreground")} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{s.name}</span>
            {!s.active && <span className="rounded-sm border border-border px-1.5 font-mono text-[9px] uppercase text-muted-foreground">{t("st.inactive")}</span>}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {[s.location?.city, s.hours].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[12px]">{t("st.perFicha", { price: formatAmount(s.ficha_price, lang, 7, 0), code: s.asset.code })}</div>
          <div className="text-[10px] text-muted-foreground">{t("st.fichaMinutes", { min: s.ficha_minutes })}</div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}
