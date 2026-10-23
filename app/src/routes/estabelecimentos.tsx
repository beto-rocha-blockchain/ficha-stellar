/**
 * Estabelecimentos: static page for venue owners (bars, cafés, waiting rooms)
 * who could host a Ficha station. Honest pitch only: no invented numbers.
 * Public route (works without a wallet).
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { BadgeDollarSign, BatteryCharging, Clock, FileBarChart, MapPin, Receipt, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { useT } from "@/i18n";

export const Route = createFileRoute("/estabelecimentos")({ component: Venues });

/** Where the contact button points. null until the contact channel exists (the button stays disabled). */
const CONTACT_URL: string | null = null;

const POINTS: { key: string; icon: LucideIcon }[] = [
  { key: "stay", icon: Clock },
  { key: "money", icon: BadgeDollarSign },
  { key: "noRental", icon: BatteryCharging },
  { key: "noData", icon: ShieldCheck },
  { key: "staff", icon: Users },
  { key: "pilot", icon: FileBarChart },
  { key: "places", icon: MapPin },
  { key: "price", icon: Receipt },
];

function Venues() {
  const t = useT("venues");
  return (
    <div className="space-y-4">
      <PageHeader label={t("label")} title={t("title")} />
      <p className="text-sm leading-relaxed text-muted-foreground">{t("lead")}</p>

      <ul className="space-y-2">
        {POINTS.map(({ key, icon: Icon }) => (
          <li key={key} className="flex gap-3 rounded-xl border border-border bg-card p-3.5">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <div className="font-display text-[15px] font-semibold">{t(`${key}.title`)}</div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{t(`${key}.body`)}</p>
            </div>
          </li>
        ))}
      </ul>

      <section className="panel">
        <div className="panel-header">
          <span className="label-op">{t("how.title")}</span>
        </div>
        <ol className="list-decimal space-y-1.5 py-3 pl-8 pr-3 text-[13px] leading-relaxed text-muted-foreground">
          <li>{t("how.1")}</li>
          <li>{t("how.2")}</li>
          <li>{t("how.3")}</li>
        </ol>
      </section>

      <div className="rounded-xl border border-primary/40 bg-primary/5 p-4">
        <div className="font-display font-semibold">{t("cta.title")}</div>
        <p className="mt-1 text-[13px] text-muted-foreground">{t("cta.body")}</p>
        {CONTACT_URL ? (
          <Button asChild className="mt-3 w-full">
            <a href={CONTACT_URL} target="_blank" rel="noopener noreferrer">
              {t("cta.button")}
            </a>
          </Button>
        ) : (
          <>
            <Button className="mt-3 w-full" disabled>
              {t("cta.button")}
            </Button>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">{t("cta.soon")}</p>
          </>
        )}
      </div>

      <Button asChild variant="outline" className="w-full">
        <Link to="/stations">{t("seeMap")}</Link>
      </Button>
    </div>
  );
}
