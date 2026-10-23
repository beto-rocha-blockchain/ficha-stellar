/**
 * The phone's battery as the Android app reads it (native plugin FichaBattery,
 * android/app/src/main/java/app/ficha/wallet/battery/FichaBatteryPlugin.kt).
 *
 * On the web (PWA, browser, tests) there is no plugin: getBatteryReading()
 * resolves to null and watchBattery() never calls back. Use the Battery Status
 * API (navigator.getBattery) there if a level is enough.
 */
import { useEffect, useState } from "react";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type ChargeStatus = "charging" | "discharging" | "full" | "not_charging" | "unknown";
export type PlugType = "ac" | "usb" | "wireless" | "dock" | "none" | "unknown";

export interface BatteryReading {
  /** False when the phone does not report its current (CURRENT_NOW unsupported). */
  currentSupported: boolean;
  /** Battery current in mA, positive = flowing into the battery (charging). */
  currentMa: number | null;
  /**
   * "uA" once a value >= 10 000 was seen; "unknown" = values so far read as mA
   * (they may still be uA: see currentUncertain in src/battery/session.ts).
   */
  currentUnit: "uA" | "unknown";
  /** True once the sign has been confirmed by the charge status (see meter.py). */
  signKnown: boolean;
  /** Battery voltage in mV (not the USB voltage). */
  voltageMv: number | null;
  /** currentMa x voltageMv, in mW; negative while discharging. */
  powerMw: number | null;
  /** 0..100 */
  levelPct: number | null;
  status: ChargeStatus;
  plugged: PlugType;
  temperatureC: number | null;
  /** CURRENT_NOW as the phone reported it, for diagnostics. */
  rawCurrent: number | null;
  /** Epoch ms of the reading. */
  at: number;
}

interface FichaBatteryPlugin {
  getStatus(): Promise<BatteryReading>;
  addListener(event: "battery", cb: (r: BatteryReading) => void): Promise<PluginListenerHandle>;
}

const FichaBattery = registerPlugin<FichaBatteryPlugin>("FichaBattery");

/** True inside the Android app, where the native plugin is registered. */
export function hasNativeBattery(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("FichaBattery");
}

/** One reading, or null on the web or if the plugin fails. */
export async function getBatteryReading(): Promise<BatteryReading | null> {
  if (!hasNativeBattery()) return null;
  try {
    return await FichaBattery.getStatus();
  } catch {
    return null;
  }
}

/**
 * Calls `cb` once a second while the app is visible (the plugin pauses in the
 * background). Returns the unsubscribe function; on the web it is a no-op.
 */
export function watchBattery(cb: (r: BatteryReading) => void): () => void {
  if (!hasNativeBattery()) return () => {};
  let stopped = false;
  let handle: PluginListenerHandle | null = null;
  FichaBattery.addListener("battery", cb).then(
    (h) => (stopped ? void h.remove() : (handle = h)),
    () => {},
  );
  return () => {
    stopped = true;
    void handle?.remove();
  };
}

/** Latest reading (first one immediately, then every second); null on the web. */
export function useBatteryReading(): BatteryReading | null {
  const [reading, setReading] = useState<BatteryReading | null>(null);
  useEffect(() => {
    let alive = true;
    void getBatteryReading().then((r) => alive && r && setReading(r));
    const stop = watchBattery((r) => alive && setReading(r));
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return reading;
}
