import { describe, expect, it } from "vitest";
import type { BatteryReading } from "@/native/battery";
import { currentUncertain, step, type SessionState } from "./session";

const r = (at: number, over: Partial<BatteryReading> = {}): BatteryReading => ({
  currentSupported: true,
  currentMa: 1000,
  currentUnit: "uA",
  signKnown: true,
  voltageMv: 4000,
  powerMw: 4000,
  levelPct: 50,
  status: "charging",
  plugged: "usb",
  temperatureC: 30,
  rawCurrent: 1_000_000,
  at,
  ...over,
});

const run = (readings: BatteryReading[]): SessionState => readings.reduce(step, { last: null, since: null, wh: 0 });

describe("battery session accumulator", () => {
  it("integrates 4 W for one hour of 1 s readings to 4 Wh", () => {
    const rs = Array.from({ length: 3601 }, (_, i) => r(i * 1000));
    const st = run(rs);
    expect(st.since).toBe(0);
    expect(st.wh).toBeCloseTo(4, 6);
  });

  it("skips gaps longer than 5 s and counts only while charging", () => {
    const st = run([r(0), r(1000), r(60_000), r(61_000, { status: "full", powerMw: 50 }), r(62_000, { status: "full", powerMw: 50 })]);
    // 0..1 s at 4 W, gap skipped, 60..61 s half-trapezoid (4 W -> 0 W), then nothing
    expect(st.wh).toBeCloseTo((4 * 1 + 2 * 1) / 3600, 9);
  });

  it("uses the magnitude before the sign is confirmed", () => {
    const st = run([r(0, { powerMw: -4000, signKnown: false }), r(1000, { powerMw: -4000, signKnown: false })]);
    expect(st.wh).toBeCloseTo(4 / 3600, 9);
  });

  it("starts a new session on a new plug-in", () => {
    const st = run([r(0), r(1000), r(2000, { plugged: "none", status: "discharging", powerMw: -1000 }), r(3000), r(4000)]);
    expect(st.since).toBe(3000);
    expect(st.wh).toBeCloseTo(4 / 3600, 9);
  });
});

describe("currentUncertain", () => {
  // Moto g54 after a fresh start at its 80% hold: CURRENT_NOW is in uA, but no
  // value >= 10 000 was seen yet, so the plugin still reads 1 100 as 1 100 mA.
  const hold = (over: Partial<BatteryReading> = {}) =>
    r(0, { currentUnit: "unknown", signKnown: false, status: "not_charging", plugged: "ac", rawCurrent: 1100, currentMa: 1100, powerMw: 4604, ...over });

  it("hides small unknown-unit readings while holding or full", () => {
    expect(currentUncertain(hold())).toBe(true);
    expect(currentUncertain(hold({ status: "full" }))).toBe(true);
    expect(currentUncertain(hold({ rawCurrent: 0, currentMa: 0, powerMw: 0 }))).toBe(true);
  });

  it("shows them once the unit is known", () => {
    expect(currentUncertain(hold({ currentUnit: "uA", currentMa: 1, powerMw: 5 }))).toBe(false);
    expect(currentUncertain(hold({ currentUnit: "uA", status: "full", currentMa: 1, powerMw: 5 }))).toBe(false);
  });

  it("still shows unknown-unit readings while charging or discharging (phones that report mA)", () => {
    expect(currentUncertain(hold({ status: "charging", rawCurrent: 1500, currentMa: 1500 }))).toBe(false);
    expect(currentUncertain(hold({ status: "discharging", plugged: "none", rawCurrent: -400, currentMa: -400 }))).toBe(false);
  });
});
