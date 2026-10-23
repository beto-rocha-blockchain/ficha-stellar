import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SITE_URL } from "@/config";
import capacitor from "../capacitor.config";

// site/ holds what only the Ficha site carries (scripts/build-site.mjs copies it into dist-site/).
const siteFile = (p: string) => readFileSync(fileURLToPath(new URL(`../site/${p}`, import.meta.url)), "utf8");

interface VercelJson {
  rewrites: { source: string; destination: string }[];
  headers: { source: string; headers: { key: string; value: string }[] }[];
}
const vercel = JSON.parse(siteFile("vercel.json")) as VercelJson;

// The sources are path-to-regexp patterns made of plain regex groups only (no :params),
// so as a RegExp over the whole path they match the same paths.
const matches = (source: string, path: string) => new RegExp(`^${source}$`, "i").test(path);
const rewrite = (path: string) => vercel.rewrites.find((r) => matches(r.source, path))?.destination ?? null;
const headers = (path: string) =>
  Object.fromEntries(vercel.headers.filter((h) => matches(h.source, path)).flatMap((h) => h.headers.map((x) => [x.key.toLowerCase(), x.value])));

describe("the Ficha site (site/vercel.json)", () => {
  it("is the root of its own host", () => {
    expect(new URL(SITE_URL).pathname).toBe("/");
  });

  it("gives the app for a path that is no file, so a deep link survives a hard reload", () => {
    // Real files are served before rewrites; these paths have none.
    for (const p of ["/", "/r", "/p", "/stations", "/stations/ERZGCG", "/pay", "/estabelecimentos", "/history", "/settings"]) {
      expect(rewrite(p), p).toBe("/index.html");
    }
  });

  it("never answers for the registry, .well-known or a build file with the app: a missing one is a 404", () => {
    for (const p of [
      "/registry/stations.json",
      "/registry/stations.json.sig",
      "/registry/stations.public.json",
      "/registry",
      "/.well-known/assetlinks.json",
      "/assets/index-OLD.js",
    ]) {
      expect(rewrite(p), p).toBeNull();
    }
  });

  it("serves the registry to the Android app's origin, and never from a stale cache", () => {
    for (const f of ["stations.json", "stations.json.sig", "stations.public.json"]) {
      expect(headers(`/registry/${f}`), f).toMatchObject({ "access-control-allow-origin": "*", "cache-control": "no-cache" });
    }
    expect(headers("/r")).toEqual({});
  });
});

describe("the Android App Link (site/.well-known/assetlinks.json)", () => {
  const links = JSON.parse(siteFile(".well-known/assetlinks.json")) as {
    relation: string[];
    target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
  }[];
  const gradle = readFileSync(fileURLToPath(new URL("../android/app/build.gradle", import.meta.url)), "utf8");

  it("lets the Ficha app handle the site's links", () => {
    expect(links).toHaveLength(1);
    expect(links[0].relation).toEqual(["delegate_permission/common.handle_all_urls"]);
    expect(links[0].target.namespace).toBe("android_app");
    expect(links[0].target.package_name).toBe(capacitor.appId);
    expect(gradle).toContain(`applicationId "${links[0].target.package_name}"`);
  });

  it("names signing keys by their SHA-256 fingerprint (keytool's AA:BB:... form)", () => {
    const prints = links[0].target.sha256_cert_fingerprints;
    expect(prints.length).toBeGreaterThan(0);
    for (const f of prints) expect(f).toMatch(/^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/);
  });
});
