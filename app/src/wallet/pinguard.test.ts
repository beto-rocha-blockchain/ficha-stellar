import { describe, expect, it } from "vitest";
import { formatWait } from "@/lib/format";
import { pinRetryAt, pinWaitMs } from "./pinguard";

describe("PIN waits", () => {
  it("lets 4 wrong PINs go, then waits 30 s, 1 min, 5 min, 15 min, 1 h and 4 h from then on", () => {
    expect([0, 1, 2, 3, 4].map(pinWaitMs)).toEqual([0, 0, 0, 0, 0]);
    expect([5, 6, 7, 8, 9, 10, 50].map(pinWaitMs)).toEqual([30_000, 60_000, 300_000, 900_000, 3_600_000, 14_400_000, 14_400_000]);
  });

  it("never waits longer than due, even if the clock went back", () => {
    const now = 1_000_000;
    expect(pinRetryAt({ failures: 5, notBefore: now + 10_000 }, now)).toBe(now + 10_000);
    expect(pinRetryAt({ failures: 5, notBefore: now + 86_400_000 }, now)).toBe(now + 30_000);
    expect(pinRetryAt({ failures: 0, notBefore: 0 }, now)).toBeLessThanOrEqual(now);
  });

  it("shows the wait rounded up", () => {
    expect(formatWait(29_001)).toBe("30 s");
    expect(formatWait(0)).toBe("1 s");
    expect(formatWait(60_000)).toBe("1 min");
    expect(formatWait(299_500)).toBe("5 min");
    expect(formatWait(3_600_000)).toBe("1 h");
    expect(formatWait(4_800_000)).toBe("1 h 20 min");
  });
});
