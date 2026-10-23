/**
 * Live charging panel for the header, next to the network badge.
 *
 * In the Android app it shows the phone's own battery current, power and level
 * every second (native FichaBattery plugin, through the battery session store,
 * so the Wh count on the Battery screen keeps running). In a browser it falls
 * back to the Battery Status API (level and charging only). Where neither
 * exists (e.g. iPhone Safari) it renders nothing. Tapping it opens /battery.
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BatteryFull, BatteryMedium, Zap } from "lucide-react";
import { chargingWatts, isPlugged, useBatterySession } from "@/battery/session";
import { hasNativeBattery } from "@/native/battery";
import { useLang, useT } from "@/i18n";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

type Live =
  | { kind: "native"; charging: boolean; plugged: boolean; full: boolean; ma: number | null; watts: number; level: number | null }
  | { kind: "web"; charging: boolean; level: number };

function useWebBattery(enabled: boolean): { charging: boolean; level: number } | null {
  const [state, setState] = useState<{ charging: boolean; level: number } | null>(null);
  useEffect(() => {
    if (!enabled || typeof navigator.getBattery !== "function") return;
    let bm: BatteryManager | null = null;
    let alive = true;
    const update = () => bm && alive && setState({ charging: bm.charging, level: Math.round(bm.level * 100) });
    navigator
      .getBattery()
      .then((b) => {
        bm = b;
        update();
        b.addEventListener("levelchange", update);
        b.addEventListener("chargingchange", update);
      })
      .catch(() => {});
    return () => {
      alive = false;
      bm?.removeEventListener("levelchange", update);
      bm?.removeEventListener("chargingchange", update);
    };
  }, [enabled]);
  return state;
}

function useLive(): Live | null {
  const native = hasNativeBattery();
  const last = useBatterySession((s) => s.last);
  const start = useBatterySession((s) => s.start);
  useEffect(() => {
    if (native) start();
  }, [native, start]);
  const web = useWebBattery(!native);

  if (native) {
    if (!last) return null;
    const charging = last.status === "charging";
    return {
      kind: "native",
      charging,
      plugged: isPlugged(last),
      full: last.status === "full",
      ma: last.currentSupported && last.currentMa !== null ? Math.round(Math.abs(last.currentMa)) : null,
      watts: chargingWatts(last),
      level: last.levelPct,
    };
  }
  return web ? { kind: "web", ...web } : null;
}

export function ChargeChip({ className }: { className?: string }) {
  const t = useT("charge");
  const { lang } = useLang();
  const live = useLive();
  if (!live) return null;
  // In the app's language: "1.200 mA" in English reads as 1.2 mA.
  const fmt = (n: number, digits = 0) => formatNumber(n, lang, digits);

  const charging = live.charging;
  const level = live.level;
  const title =
    live.kind === "native" && live.full
      ? t("full")
      : charging
        ? t("charging")
        : live.kind === "native" && live.plugged
          ? t("pluggedIdle")
          : t("unplugged");

  return (
    <Link
      to="/battery"
      title={title}
      aria-label={`${title} · ${t("open")}`}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-sm border px-1.5 py-[2px] font-mono text-[10px] tabular-nums tracking-wide transition-colors",
        charging
          ? "border-brand-lime/40 bg-brand-lime/10 text-brand-lime"
          : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {charging ? (
        <Zap className="ep-status-dot h-3 w-3 shrink-0 fill-current" />
      ) : level !== null && level >= 95 ? (
        <BatteryFull className="h-3 w-3 shrink-0" />
      ) : (
        <BatteryMedium className="h-3 w-3 shrink-0" />
      )}
      {live.kind === "native" && charging && live.ma !== null && (
        <>
          <span className="whitespace-nowrap">{fmt(live.ma)} mA</span>
          {live.watts > 0 && <span className="hidden whitespace-nowrap sm:inline">· {fmt(live.watts, 1)} W</span>}
          <span className="opacity-50">·</span>
        </>
      )}
      {level !== null && <span className="whitespace-nowrap">{fmt(level)}%</span>}
    </Link>
  );
}
