/**
 * Bateria: the phone's own battery reading. Android app: live mA, V, W and
 * the Wh of the current plug-in session from the native FichaBattery plugin.
 * Browser: level, charging and time to full from the Battery Status API
 * (Chrome on Android/desktop; Safari and Firefox do not expose it).
 * Never presented as the station's meter.
 */
import { useEffect, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { BatteryCharging, BatteryMedium, Info, RotateCcw, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { useLang, useT } from "@/i18n";
import { formatDateTime } from "@/lib/format";
import { currentUncertain, isPlugged, useBatterySession } from "@/battery/session";
import { hasNativeBattery } from "@/native/battery";

export const Route = createFileRoute("/battery")({ component: BatteryScreen });

function BatteryScreen() {
  const t = useT("battery");
  const native = hasNativeBattery();
  return (
    <div className="space-y-4">
      <PageHeader label={t("label")} title={t("title")} />
      <div className="flex items-start gap-2 rounded-md border border-border bg-card px-2.5 py-1.5">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <p className="text-[11px] text-muted-foreground">{t("notMeter")}</p>
      </div>
      {native ? <NativeReading /> : <WebReading />}
    </div>
  );
}

function Kpi({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: ReactNode }) {
  return (
    <div className="bg-card p-3">
      <div className="label-op">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="kpi-num text-2xl">{value}</span>
        {unit && <span className="font-mono text-[11px] text-muted-foreground">{unit}</span>}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function num(v: number, lang: "pt-BR" | "en", digits: number): string {
  return v.toLocaleString(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function NativeReading() {
  const t = useT("battery");
  const { lang } = useLang();
  const { last, wh, since, start, reset } = useBatterySession();

  useEffect(() => {
    start();
  }, [start]);

  if (!last) return <div className="h-40 animate-pulse rounded-xl bg-primary/10" />;

  const dash = "—";
  // Small readings of unknown unit while full or holding may be uA, not mA.
  const uncertain = currentUncertain(last);
  const ma = uncertain ? null : last.currentMa;
  const mw = uncertain ? null : last.powerMw;
  const direction = last.signKnown && ma !== null && ma !== 0 ? (ma > 0 ? t("into") : t("outOf")) : undefined;
  return (
    <div className="space-y-3">
      <StateLine charging={last.status === "charging"} plugged={isPlugged(last)} level={last.levelPct ?? 0} />
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border">
        <Kpi label={t("current")} value={ma === null ? dash : num(Math.abs(ma), lang, 0)} unit="mA" sub={direction} />
        <Kpi label={t("voltage")} value={last.voltageMv === null ? dash : num(last.voltageMv / 1000, lang, 2)} unit="V" />
        <Kpi label={t("power")} value={mw === null ? dash : num(Math.abs(mw) / 1000, lang, 2)} unit="W" />
      </div>
      {!last.currentSupported && <p className="text-[12px] text-muted-foreground">{t("noCurrent")}</p>}
      <div className="panel">
        <div className="panel-header">
          <span className="label-op">{t("session")}</span>
        </div>
        <div className="space-y-2 p-3">
          {since !== null ? (
            <>
              <div className="flex items-baseline gap-1">
                <span className="kpi-num text-3xl">{num(wh, lang, 3)}</span>
                <span className="font-mono text-[11px] text-muted-foreground">Wh</span>
              </div>
              <p className="text-[11px] text-muted-foreground">{t("sessionSince", { time: formatDateTime(since, lang) })}</p>
              <Button variant="outline" size="sm" onClick={reset}>
                <RotateCcw /> {t("reset")}
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t("plugToStart")}</p>
          )}
        </div>
      </div>
      {last.temperatureC !== null && <p className="text-[11px] text-muted-foreground">{t("temperature", { c: num(last.temperatureC, lang, 1) })}</p>}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("nativeNote")}</p>
    </div>
  );
}

function StateLine({ charging, plugged, level }: { charging: boolean; plugged: boolean; level: number }) {
  const t = useT("battery");
  const Icon = charging ? BatteryCharging : BatteryMedium;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
      <Icon className={charging ? "h-8 w-8 text-primary" : "h-8 w-8 text-muted-foreground"} />
      <div>
        <div className="kpi-num text-3xl">{Math.round(level)}%</div>
        <div className="text-[12px] text-muted-foreground">
          {charging ? t("charging") : plugged ? t("pluggedNotCharging") : t("notCharging")}
        </div>
      </div>
      {charging && <Zap className="ml-auto h-5 w-5 animate-pulse text-primary" />}
    </div>
  );
}

type WebState = { kind: "loading" } | { kind: "none" } | { kind: "ok"; level: number; charging: boolean; chargingTime: number };

function WebReading() {
  const t = useT("battery");
  const [st, setSt] = useState<WebState>({ kind: "loading" });

  useEffect(() => {
    if (typeof navigator.getBattery !== "function") {
      setSt({ kind: "none" });
      return;
    }
    let bm: BatteryManager | null = null;
    let alive = true;
    const update = () => bm && alive && setSt({ kind: "ok", level: bm.level, charging: bm.charging, chargingTime: bm.chargingTime });
    navigator
      .getBattery()
      .then((b) => {
        bm = b;
        update();
        b.addEventListener("levelchange", update);
        b.addEventListener("chargingchange", update);
        b.addEventListener("chargingtimechange", update);
      })
      .catch(() => alive && setSt({ kind: "none" }));
    return () => {
      alive = false;
      bm?.removeEventListener("levelchange", update);
      bm?.removeEventListener("chargingchange", update);
      bm?.removeEventListener("chargingtimechange", update);
    };
  }, []);

  if (st.kind === "loading") return <div className="h-24 animate-pulse rounded-xl bg-primary/10" />;
  if (st.kind === "none") {
    return <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">{t("unsupported")}</p>;
  }
  const full = !st.charging
    ? null
    : st.level >= 0.995
      ? t("isFull")
      : Number.isFinite(st.chargingTime) && st.chargingTime > 0
        ? t("toFull", { min: Math.max(1, Math.round(st.chargingTime / 60)) })
        : t("toFullUnknown");
  return (
    <div className="space-y-3">
      <StateLine charging={st.charging} plugged={st.charging} level={st.level * 100} />
      {full && <p className="text-sm">{full}</p>}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("webNote")}</p>
    </div>
  );
}
