import { describe, expect, it } from "vitest";
import { compareAmounts, formatAmount, fromStroops, multiplyAmount, subtractAmounts, toStroops } from "./amount";

describe("amount", () => {
  it("parses and prints exactly", () => {
    expect(toStroops("1")).toBe(10_000_000n);
    expect(toStroops("0.0000001")).toBe(1n);
    expect(fromStroops(15_000_000n)).toBe("1.5");
    expect(fromStroops(0n)).toBe("0");
    expect(fromStroops(-5n)).toBe("-0.0000005");
  });

  it("rejects floats in disguise", () => {
    for (const bad of ["", "-1", "1e3", "0.00000001", "1.", ".5", "abc", "1,5"]) {
      expect(() => toStroops(bad)).toThrow();
    }
  });

  it("multiplies price by fichas with no float error", () => {
    expect(multiplyAmount("0.1", 3)).toBe("0.3");
    expect(multiplyAmount("1", 12)).toBe("12");
    expect(multiplyAmount("0.0000001", 7)).toBe("0.0000007");
    expect(() => multiplyAmount("1", 1.5)).toThrow();
  });

  it("compares and subtracts", () => {
    expect(compareAmounts("10", "9.9999999")).toBe(1);
    expect(compareAmounts("1.0", "1")).toBe(0);
    expect(subtractAmounts("10", "2.5")).toBe("7.5");
  });

  it("formats for display without rounding up", () => {
    expect(formatAmount("1234.5678", "pt-BR")).toBe("1.234,56");
    expect(formatAmount("1234.5678", "en")).toBe("1,234.56");
    expect(formatAmount("10", "pt-BR")).toBe("10,00");
    expect(formatAmount("0.1234567", "en", 7, 0)).toBe("0.1234567");
  });
});
