import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// scripts/publish-site.mjs and build-site.mjs in a throwaway tree: <tmp>/app/scripts,
// <tmp>/app/dist-site, <tmp>/registry and the site checkout <tmp>/site. dist-site/registry/
// comes from scripts/sync-assets.mjs, as in npm run build:site; build-site.mjs runs a
// stand-in for vite (it copies public/, as vite does, and writes the build's own files).
const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
let root: string;
let site: string;

function write(path: string, data: string | Uint8Array) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/**
 * Builds dist-site with these files (plus the fixed ones, and the registries
 * sync-assets copies, then `registry` written over them) and publishes it.
 */
function run(build: string, files: string[], registry: Record<string, string> = {}) {
  const dist = join(root, "app", "dist-site");
  rmSync(dist, { recursive: true, force: true });
  const sync = spawnSync(process.execPath, [join(root, "app", "scripts", "sync-assets.mjs")], { encoding: "utf8" });
  expect(sync.status, sync.stderr).toBe(0);
  cpSync(join(root, "app", "public", "registry"), join(dist, "registry"), { recursive: true });
  for (const [f, text] of Object.entries(registry)) write(join(dist, "registry", f), text);
  for (const f of ["index.html", "vercel.json", "sw.js"]) write(join(dist, f), `${f} ${build}`);
  for (const f of files) write(join(dist, f), `${f} ${build}`);
  return spawnSync(process.execPath, [join(root, "app", "scripts", "publish-site.mjs"), site], { encoding: "utf8" });
}

function publish(build: string, files: string[]) {
  const r = run(build, files);
  expect(r.status, r.stderr).toBe(0);
}

const has = (f: string) => existsSync(join(site, f));
const reg = (f: string) => join(root, "registry", f);
const bytes = (path: string) => readFileSync(path);

// CRLF and a non-ASCII byte: a copy that rewrote either would no longer match its signature.
const PUBLIC = Buffer.from('{\r\n  "network": "public",\r\n  "name": "Lisboa é"\r\n}\r\n', "utf8");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ficha-publish-"));
  site = join(root, "site");
  mkdirSync(join(root, "app", "scripts"), { recursive: true });
  for (const f of ["publish-site.mjs", "build-site.mjs", "sync-assets.mjs", "registries.mjs"]) copyFileSync(join(scripts, f), join(root, "app", "scripts", f));
  write(join(root, "brand", "ficha-mark.svg"), '<svg viewBox="0 0 64 64"></svg>');
  write(join(root, "app", "site", "vercel.json"), "{}");
  write(join(root, "app", "site", ".well-known", "assetlinks.json"), "[]");
  write(
    join(root, "app", "node_modules", "vite", "bin", "vite.js"),
    [
      'import { cpSync, rmSync, writeFileSync } from "node:fs";',
      'rmSync("dist-site", { recursive: true, force: true });',
      'cpSync("public", "dist-site", { recursive: true });',
      `writeFileSync("dist-site/index.html", '<script type="module" src="/assets/index.js"></script>');`,
      'writeFileSync("dist-site/sw.js", "");',
      'writeFileSync("dist-site/manifest.webmanifest", JSON.stringify({ scope: "/", start_url: "/" }));',
    ].join("\n"),
  );
  write(reg("stations.json"), "{}");
  write(reg("stations.json.sig"), "sig");
  mkdirSync(join(site, ".git"), { recursive: true });
  write(join(site, "README.md"), "not ours");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("publish-site", () => {
  it("keeps the previous build's hashed assets one more publish, for a page still running it", () => {
    publish("A", ["assets/index-A.js", "assets/pay-A.js", "assets/font.woff2", "icons/old.svg"]);
    publish("B", ["assets/index-B.js", "assets/pay-B.js", "assets/font.woff2"]);
    // Build A's lazy route chunks still load after B is published...
    for (const f of ["assets/index-A.js", "assets/pay-A.js", "assets/index-B.js", "assets/pay-B.js", "assets/font.woff2"]) expect(has(f), f).toBe(true);
    // ...but nothing else of it stays, and files the script did not write are never touched.
    expect(has("icons/old.svg")).toBe(false);
    expect(readFileSync(join(site, "index.html"), "utf8")).toBe("index.html B");
    expect(has("README.md")).toBe(true);

    publish("C", ["assets/index-C.js", "assets/pay-C.js", "assets/font.woff2"]);
    for (const f of ["assets/index-A.js", "assets/pay-A.js"]) expect(has(f), f).toBe(false);
    for (const f of ["assets/index-B.js", "assets/pay-B.js", "assets/index-C.js", "assets/pay-C.js", "assets/font.woff2"]) expect(has(f), f).toBe(true);

    // The same build again: B is still the build before it.
    publish("C", ["assets/index-C.js", "assets/pay-C.js", "assets/font.woff2"]);
    for (const f of ["assets/index-B.js", "assets/pay-B.js", "assets/index-C.js"]) expect(has(f), f).toBe(true);

    publish("D", ["assets/index-D.js", "assets/font.woff2"]);
    for (const f of ["assets/index-B.js", "assets/pay-B.js"]) expect(has(f), f).toBe(false);
    for (const f of ["assets/index-C.js", "assets/pay-C.js", "assets/index-D.js", ".git", "README.md"]) expect(has(f), f).toBe(true);
  });

  it("publishes the public registry next to the testnet one, byte for byte, and refuses a copy that differs", () => {
    write(reg("stations.public.json"), PUBLIC);
    write(reg("stations.public.json.sig"), "public sig");
    try {
      publish("P", []);
      for (const f of ["stations.json", "stations.json.sig", "stations.public.json", "stations.public.json.sig"]) {
        expect(bytes(join(site, "registry", f)).equals(bytes(reg(f))), f).toBe(true);
      }
      // A copy whose line endings were rewritten (git's autocrlf) no longer matches its signature: nothing is copied.
      const r = run("Q", [], { "stations.public.json": PUBLIC.toString("utf8").replace(/\r\n/g, "\n") });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("app/dist-site/registry/stations.public.json differs from ../registry/stations.public.json");
      expect(readFileSync(join(site, "index.html"), "utf8")).toBe("index.html P");
      expect(bytes(join(site, "registry", "stations.public.json")).equals(PUBLIC)).toBe(true);
    } finally {
      rmSync(reg("stations.public.json"), { force: true });
      rmSync(reg("stations.public.json.sig"), { force: true });
    }
    // Taken out of the repo: it goes from the site too.
    publish("R", []);
    expect(has("registry/stations.public.json")).toBe(false);
    expect(has("registry/stations.json")).toBe(true);
  });

  it("never publishes an unsigned registry: a stations.public.json without its .sig stops the publish", () => {
    write(reg("stations.public.json"), PUBLIC);
    try {
      const r = run("U", []);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("../registry/stations.public.json is not signed (no stations.public.json.sig)");
      expect(r.stderr).toContain("an unsigned registry is never published");
      expect(has("registry/stations.public.json")).toBe(false);
      expect(readFileSync(join(site, "index.html"), "utf8")).toBe("index.html R");
      // Nor a signature without its registry.
      rmSync(reg("stations.public.json"));
      write(reg("stations.public.json.sig"), "public sig");
      const s = run("U", []);
      expect(s.status).not.toBe(0);
      expect(s.stderr).toContain("../registry/stations.public.json is missing (its .sig is there)");
      expect(has("registry/stations.public.json.sig")).toBe(false);
    } finally {
      rmSync(reg("stations.public.json"), { force: true });
      rmSync(reg("stations.public.json.sig"), { force: true });
    }
  });

  it("publishes no stray file: a draft in registry/ stays in the repo, and a build that carries one is refused", () => {
    write(reg("stations.draft.json"), "{}");
    write(reg("notes.txt"), "draft");
    try {
      publish("S", []);
      expect(readdirSync(join(root, "app", "public", "registry")).sort()).toEqual(["stations.json", "stations.json.sig"]);
      expect(readdirSync(join(site, "registry")).sort()).toEqual(["stations.json", "stations.json.sig"]);
      const r = run("T", [], { "stations.draft.json": "{}" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("app/dist-site/registry/stations.draft.json is not one of the signed registries");
      expect(has("registry/stations.draft.json")).toBe(false);
      expect(readFileSync(join(site, "index.html"), "utf8")).toBe("index.html S");
    } finally {
      rmSync(reg("stations.draft.json"), { force: true });
      rmSync(reg("notes.txt"), { force: true });
    }
  });
});

describe("build-site", () => {
  const dist = () => join(root, "app", "dist-site");
  const build = () => {
    rmSync(dist(), { recursive: true, force: true });
    return spawnSync(process.execPath, [join(root, "app", "scripts", "build-site.mjs")], { encoding: "utf8" });
  };

  it("carries every signed registry, the public one too, byte for byte, and no draft", () => {
    write(reg("stations.public.json"), PUBLIC);
    write(reg("stations.public.json.sig"), "public sig");
    write(reg("stations.draft.json"), "{}");
    try {
      const r = build();
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("[build-site] registry: stations.json, stations.public.json, signed");
      expect(readdirSync(join(dist(), "registry")).sort()).toEqual(["stations.json", "stations.json.sig", "stations.public.json", "stations.public.json.sig"]);
      for (const f of ["stations.json", "stations.json.sig", "stations.public.json", "stations.public.json.sig"]) {
        expect(bytes(join(dist(), "registry", f)).equals(bytes(reg(f))), f).toBe(true);
      }
    } finally {
      for (const f of ["stations.public.json", "stations.public.json.sig", "stations.draft.json"]) rmSync(reg(f), { force: true });
    }
    const t = build();
    expect(t.status, t.stderr).toBe(0);
    expect(t.stdout).toContain("[build-site] registry: stations.json, signed");
  });

  it("fails, before building anything, on a stations.public.json without its .sig", () => {
    write(reg("stations.public.json"), PUBLIC);
    try {
      const r = build();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("[build-site] ../registry/stations.public.json is not signed (no stations.public.json.sig)");
      expect(r.stderr).toContain("an unsigned registry is never published");
      expect(existsSync(dist())).toBe(false);
    } finally {
      rmSync(reg("stations.public.json"), { force: true });
    }
  });
});
