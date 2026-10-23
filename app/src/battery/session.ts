/**
 * Energy of the current plug-in session, summed from the phone's own battery
 * readings (src/native/battery.ts, native FichaBattery plugin, Android only).
 *
 * This is what the PHONE says about itself, not the station's meter. The
 * accumulator lives here (not in the screen) so it keeps counting while the
 * user looks at other screens; it pauses with the app (no readings in the
 * background, and gaps longer than MAX_GAP_MS are not integrated).
 */
import { create } from "zustand";
import { getBatteryReading, hasNativeBattery, watchBattery, type BatteryReading } from "@/native/battery";

/** Longest gap between two readings that still counts as continuous. */
export const MAX_GAP_MS = 5_000;

export function isPlugged(r: BatteryReading): boolean {
  return r.plugged !== "none" && r.plugged !== "unknown";
}

/**
 * True when the current (and so the power) of this reading cannot be shown:
 * no CURRENT_NOW value >= 10 000 has been seen yet, so the plugin still reads
 * small values as mA (meter.py parity), and the phone is full or holding its
 * charge. There a uA driver reports a few hundred uA (the moto g54 gives 0 to
 * 1 700 at its 80% hold), which would show as up to 1 700 mA and several W,
 * 1000x too high. A charging or discharging phone soon reports a value that
 * settles the unit.
 */
export function currentUncertain(r: BatteryReading): boolean {
  return r.currentUnit === "unknown" && (r.status === "full" || r.status === "not_charging");
}

/** Power flowing INTO the battery, in W (0 unless charging). */
export function chargingWatts(r: BatteryReading): number {
  if (r.status !== "charging" || r.powerMw === null) return 0;
  // Before the sign is confirmed a charging phone may still report a negative value.
  return Math.abs(r.powerMw) / 1000;
}

export interface SessionState {
  last: BatteryReading | null;
  /** When the current plug-in session started (ms), null when unplugged. */
  since: number | null;
  wh: number;
}

/** Pure step of the accumulator (tested in session.test.ts). */
export function step(st: SessionState, r: BatteryReading): SessionState {
  const plugged = isPlugged(r);
  const prev = st.last;
  if (!plugged) return { last: r, since: null, wh: st.wh };
  if (!prev || !isPlugged(prev) || st.since === null) return { last: r, since: r.at, wh: 0 };
  const dt = r.at - prev.at;
  let wh = st.wh;
  // Trapezoid between the two readings; skip gaps (app paused, missed events).
  if (dt > 0 && dt <= MAX_GAP_MS) wh += (((chargingWatts(r) + chargingWatts(prev)) / 2) * dt) / 3_600_000;
  return { last: r, since: st.since, wh };
}

interface Store extends SessionState {
  started: boolean;
  start: () => void;
  reset: () => void;
}

export const useBatterySession = create<Store>((set, get) => {
  const onReading = (r: BatteryReading) => set((st) => step(st, r));
  return {
    last: null,
    since: null,
    wh: 0,
    started: false,
    start: () => {
      if (get().started || !hasNativeBattery()) return;
      set({ started: true });
      void getBatteryReading().then((r) => r && onReading(r));
      watchBattery(onReading);
    },
    reset: () => set((st) => ({ wh: 0, since: st.last && isPlugged(st.last) ? Date.now() : null })),
  };
});
