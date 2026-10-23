import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatIssued } from "@/components/RegistryStatus";
import { dateLocale, formatDateTime, formatDeadline, formatNumber, formatTimeOfDay } from "./format";

describe("formatNumber", () => {
  it("uses the user's language: an English reader must not see 1.200 mA (1.2 mA)", () => {
    expect(formatNumber(1200, "en")).toBe("1,200");
    expect(formatNumber(4.93, "en", 1)).toBe("4.9");
    expect(formatNumber(1200, "pt-BR")).toBe("1.200");
    expect(formatNumber(4.93, "pt-BR", 1)).toBe("4,9");
    expect(formatNumber(50, "en")).toBe("50");
  });

  it("formats the header charge chip in the app's language, not always pt-BR", () => {
    const chip = readFileSync(fileURLToPath(new URL("../components/ChargeChip.tsx", import.meta.url)), "utf8");
    expect(chip).not.toContain('"pt-BR"');
    expect(chip).toContain("formatNumber(n, lang, digits)");
  });
});

describe("formatDeadline", () => {
  it("adds the time left to a deadline ahead, which reads the same whatever the station's time zone", () => {
    const at = 1_790_002_280;
    const time = (lang: "pt-BR" | "en") => new Date(at * 1000).toLocaleTimeString(lang === "pt-BR" ? "pt-BR" : "en-GB", { hour: "2-digit", minute: "2-digit" });
    expect(formatDeadline(at, "pt-BR", at - 28 * 60)).toBe(`${time("pt-BR")} (em 28 min)`);
    expect(formatDeadline(at, "en", at - 90)).toBe(`${time("en")} (in 2 min)`);
    // Past: the time alone.
    expect(formatDeadline(at, "en", at + 1)).toBe(time("en"));
  });
});

describe("dates and times in English (review R2P13)", () => {
  it("writes them day first and 24-hour, as a European jury reads them, never M/D/YY h:mm AM", () => {
    expect(dateLocale("en")).toBe("en-GB");
    expect(dateLocale("pt-BR")).toBe("pt-BR");
    // The registry's issued_at, in UTC: 2 October 2026, not 10 February.
    expect(formatIssued("2026-10-02T02:18:00Z", "en")).toBe("02/10/2026, 02:18 UTC");
    expect(formatIssued("2026-10-02T02:18:00Z", "pt-BR")).toMatch(/^02\/10\/2026,? 02:18 UTC$/);
    const at = Date.UTC(2026, 9, 2, 14, 5);
    expect(formatDateTime(at, "en")).toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/);
    expect(formatDateTime(at, "en")).not.toMatch(/AM|PM/);
    expect(formatTimeOfDay(at / 1000, "en")).toMatch(/^\d{2}:\d{2}$/);
    // Every screen goes through these helpers: no en-US date or time left.
    for (const f of ["../components/CustodyReceipt.tsx", "../components/RegistryStatus.tsx", "../routes/host/index.tsx", "../routes/pay.tsx", "./format.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
      expect(src, f).not.toMatch(/"en-US", \{ (hour|dateStyle)/);
    }
  });
});
