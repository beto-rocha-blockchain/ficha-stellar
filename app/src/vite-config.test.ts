import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "vite";
import { describe, expect, it } from "vitest";
import config, { appBase, workboxOptions } from "../vite.config";

const app = fileURLToPath(new URL("..", import.meta.url));
const brand = resolve(app, "../brand");

function inside(dir: string, p: string): boolean {
  const r = relative(dir, p);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep) && !/^[a-z]:/i.test(r));
}

describe("vite dev server", () => {
  it("serves only the app and ../brand through /@fs/, not the whole repo", () => {
    const allow = (config as { server?: { fs?: { allow?: string[] } } }).server?.fs?.allow ?? [];
    expect(allow.length).toBeGreaterThan(0);
    for (const p of allow) {
      const abs = resolve(app, p);
      // The repo root holds the station session log, config and tools.
      expect(inside(app, abs) || inside(brand, abs), `${p} -> ${abs}`).toBe(true);
    }
  });
});

describe("vite-plugin-pwa", () => {
  it("injects no service worker registration: the Android app must not run one", async () => {
    const resolved = await resolveConfig(
      { root: app, configFile: resolve(app, "vite.config.ts"), logLevel: "silent" },
      "build",
      "production",
    );
    const pwa = resolved.plugins.find((p) => p.name === "vite-plugin-pwa") as unknown as {
      api: { registerSWData(): unknown };
    };
    // src/native/service-worker.ts registers it, on the web only.
    expect(pwa.api.registerSWData()).toBeUndefined();
  });

  it("never answers for the signed registry from a cache (the app labels its own offline copy)", () => {
    const w = workboxOptions("/");
    expect(w.globIgnores).toContain("registry/**");
    expect("runtimeCaching" in w).toBe(false);
  });

  it("opens the registry and .well-known files themselves, not the app, when the address bar asks for them", () => {
    const w = workboxOptions("/");
    expect(w.navigateFallback).toBe("/index.html");
    const fallsBack = (path: string) => !w.navigateFallbackDenylist.some((re) => re.test(path));
    expect(fallsBack("/registry/stations.json")).toBe(false);
    expect(fallsBack("/registry/stations.json.sig")).toBe(false);
    expect(fallsBack("/.well-known/assetlinks.json")).toBe(false);
    for (const route of ["/", "/r", "/stations", "/stations/ERZGCG", "/pay", "/estabelecimentos"]) {
      expect(fallsBack(route), route).toBe(true);
    }
  });
});

describe("base path (VITE_BASE)", () => {
  it("is / for dev, the Android app and the Ficha site; a /path/ only when VITE_BASE names one", () => {
    expect(appBase(undefined)).toBe("/");
    expect(appBase("")).toBe("/");
    expect(appBase("/")).toBe("/");
    expect(appBase("/app/")).toBe("/app/");
    expect(appBase("/app")).toBe("/app/");
    for (const bad of ["app", "//evil.example/", "https://x.org/", "/a b/"]) expect(() => appBase(bad), bad).toThrow();
  });

  it("puts the PWA manifest under the base: the site's root, or a sub-path", async () => {
    const before = process.env.VITE_BASE;
    try {
      // "/" is what npm run build:site uses (scripts/build-site.mjs).
      for (const base of ["/", "/app/"]) {
        process.env.VITE_BASE = base;
        const resolved = await resolveConfig(
          { root: app, configFile: resolve(app, "vite.config.ts"), logLevel: "silent" },
          "build",
          "production",
        );
        expect(resolved.base).toBe(base);
        const pwa = resolved.plugins.find((p) => p.name === "vite-plugin-pwa") as unknown as {
          api: { generateBundle(bundle: Record<string, unknown>): Record<string, { source?: string }> | undefined };
        };
        const out = pwa.api.generateBundle({}) ?? {};
        const manifest = JSON.parse(String(out["manifest.webmanifest"]?.source));
        expect(manifest).toMatchObject({ id: base, start_url: base, scope: base });
      }
    } finally {
      if (before === undefined) delete process.env.VITE_BASE;
      else process.env.VITE_BASE = before;
    }
  });
});
