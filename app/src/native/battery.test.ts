import { describe, expect, it, vi } from "vitest";
import { getBatteryReading, hasNativeBattery, watchBattery } from "./battery";

describe("native battery on the web", () => {
  it("has no plugin, returns null and never calls back", async () => {
    expect(hasNativeBattery()).toBe(false);
    expect(await getBatteryReading()).toBeNull();
    const cb = vi.fn();
    const stop = watchBattery(cb);
    stop();
    expect(cb).not.toHaveBeenCalled();
  });
});
