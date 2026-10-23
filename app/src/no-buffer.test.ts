/**
 * The app runs with no global Buffer (the browser has none, and the old
 * polyfill is gone). vitest runs in Node, which has one, so these checks
 * stand in for the browser: nothing in src/ uses Buffer without importing
 * it, and the Stellar SDK's browser build does not use it at all.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const SDK_ESM = fileURLToPath(new URL("../node_modules/@stellar/stellar-sdk/lib/esm", import.meta.url));

function files(dir: string, keep: (f: string) => boolean): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map((f) => join(dir, f)).filter(keep);
}

/** `Buffer` as an identifier, not ArrayBuffer / SharedArrayBuffer or a word in a comment's prose. */
const BUFFER = /(?<![A-Za-z])Buffer\s*[.(]/;

describe("no global Buffer", () => {
  it("is installed by the app: the polyfill is gone from main.tsx", () => {
    const main = readFileSync(join(SRC, "main.tsx"), "utf8");
    expect(main).not.toMatch(/polyfills/);
    for (const f of files(SRC, (p) => /\.(ts|tsx)$/.test(p) && !/\.test\.ts$/.test(p))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/globalThis[^;\n]*\bBuffer\s*=/);
    }
  });

  it("is used by the app's code without importing the buffer package", () => {
    for (const f of files(SRC, (p) => /\.(ts|tsx)$/.test(p) && !/\.test\.ts$/.test(p))) {
      const text = readFileSync(f, "utf8");
      if (BUFFER.test(text)) expect(text, f).toMatch(/import \{ Buffer \} from "buffer";/);
    }
  });

  it("is used by the Stellar SDK's browser build (an upgrade that brings it back fails here)", () => {
    const js = files(SDK_ESM, (p) => p.endsWith(".js"));
    expect(js.length).toBeGreaterThan(50);
    expect(js.filter((f) => BUFFER.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
