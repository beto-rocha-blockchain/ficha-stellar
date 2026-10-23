/**
 * One station from the signed registry: price per ficha, ficha minutes, max
 * session, hours, address, directions, and the user's own sessions there.
 * Public route.
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Clock, ExternalLink, Loader2, MapPin, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/CopyButton";
import { PageHeader } from "@/components/PageHeader";
import { RegistryStatus } from "@/components/RegistryStatus";
import { SessionList, stationFor } from "@/components/SessionList";
import { useLang, useT } from "@/i18n";
import { shortAddress } from "@/lib/format";
import { useSessions } from "@/pay/useSessions";
import { isCustody, maxFichas, stationById, useRegistry, type Station } from "@/registry";
import { formatAmount, multiplyAmount } from "@/stellar";
import { useWallet } from "@/wallet";

export const Route = createFileRoute("/stations/$id")({ component: StationScreen });

function StationScreen() {
  const t = useT("pay");
  const { id } = Route.useParams();
  const { registry, status } = useRegistry();
  const station = stationById(registry, id.toUpperCase());

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/stations">
          <ArrowLeft /> {t("st.back")}
        </Link>
      </Button>
      {status === "loading" && !registry ? (
        <div className="grid place-items-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : station ? (
        <StationDetails s={station} />
      ) : (
        <>
          <RegistryStatus />
          <p className="py-8 text-center text-sm text-muted-foreground">{t("st.notFound", { id })}</p>
        </>
      )}
    </div>
  );
}

function StationDetails({ s }: { s: Station }) {
  const t = useT("pay");
  const tc = useT("common");
  const { lang } = useLang();
  const status = useWallet((w) => w.status);
  const n = maxFichas(s);
  const loc = s.location;
  const directions = loc ? `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=17/${loc.lat}/${loc.lng}` : null;

  return (
    <>
      <PageHeader label={s.id} title={s.name} />
      <RegistryStatus />
      {!s.active && <p className="text-sm text-warning">{t("st.inactive")}</p>}

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
        <div className="bg-card p-3">
          <div className="label-op">{t("pay.fichas")}</div>
          <div className="kpi-num mt-1 text-lg">{t("st.perFicha", { price: formatAmount(s.ficha_price, lang, 7, 0), code: s.asset.code })}</div>
          <div className="text-[11px] text-muted-foreground">{t("st.fichaMinutes", { min: s.ficha_minutes })}</div>
        </div>
        <div className="bg-card p-3">
          <div className="label-op">{t("pay.chargeTime")}</div>
          <div className="mt-1 text-[12px]">
            {t("st.maxSession", { min: s.max_session_minutes, fichas: n === 1 ? tc("ficha") : tc("fichas", { n }), amount: formatAmount(multiplyAmount(s.ficha_price, n), lang, 7, 0), code: s.asset.code })}
          </div>
        </div>
      </div>

      <div className="panel">
        <dl className="divide-y divide-border/60 text-sm">
          {s.hours && (
            <Row label={t("st.hours")}>
              <span className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" /> {s.hours}
              </span>
            </Row>
          )}
          {loc && (
            <Row label={t("st.address")}>
              <span className="flex items-start gap-1.5">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {[loc.address, loc.city, loc.country].filter(Boolean).join(", ")}
              </span>
            </Row>
          )}
          {/* Custody: the deposit goes to the escrow below; this is the venue the contract pays. */}
          <Row label={t(isCustody(s) ? "st.hostKeyCustody" : "st.hostKey")}>
            <span className="flex items-center gap-2 font-mono text-[12px]">
              {shortAddress(s.host_key, 6, 6)} <CopyButton value={s.host_key} />
            </span>
          </Row>
          {/* Payment mode (contract §2, §7): custody refunds unused time with the receipt's proof. */}
          <Row label={t("st.mode")}>
            <span className="text-[12px]">{isCustody(s) ? t("st.modeCustody") : t("st.modeDirect")}</span>
          </Row>
          {isCustody(s) && (
            <Row label={t("st.escrow")}>
              <span className="flex items-center gap-2 font-mono text-[12px]">
                {shortAddress(s.escrow, 6, 6)} <CopyButton value={s.escrow} />
              </span>
            </Row>
          )}
        </dl>
      </div>

      <div className="flex flex-wrap gap-2">
        {s.active && status !== "none" && (
          <Button asChild>
            <Link to="/scan">
              <ScanLine /> {t("pay.scanButton")}
            </Link>
          </Button>
        )}
        {directions && (
          <Button asChild variant="outline">
            <a href={directions} target="_blank" rel="noreferrer">
              <ExternalLink /> {t("st.directions")}
            </a>
          </Button>
        )}
      </div>

      {status !== "none" && <MySessions s={s} />}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <dt className="label-op">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function MySessions({ s }: { s: Station }) {
  const t = useT("pay");
  const { rows, registry, error } = useSessions();
  if (error != null && rows === null) return null;
  const here = (rows ?? []).filter((r) => stationFor(r, registry)?.id === s.id);
  return (
    <div className="space-y-2">
      <div className="label-op">{t("st.mySessions")}</div>
      {rows === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : here.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("st.noSessions")}</p>
      ) : (
        <SessionList rows={here} registry={registry} />
      )}
    </div>
  );
}
