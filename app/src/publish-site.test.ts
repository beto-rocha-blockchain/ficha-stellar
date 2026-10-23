import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// scripts/publish-site.mjs in a throwaway tree: <tmp>/app/scripts, <tmp>/app/dist-site,
// <tmp>/registry and the site checkout <tmp>/site.
const script = fileURLToPath(new URL("../scripts/publish-site.mjs", import.meta.url));
let root: string;
let site: string;

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Builds dist-site with these files (plus the fixed ones) and publishes it. */
function publish(build: string, files: string[]) {
  const dist = join(root, "app", "dist-site");
  rmSync(dist, { recursive: true, force: true });
  for (const f of ["index.html", "vercel.json", "sw.js"]) write(join(dist, f), `${f} ${build}`);
  for (const f of ["stations.json", "stations.json.sig"]) write(join(dist, "registry", f), readFileSync(join(root, "registry", f), "utf8"));
  for (const f of files) write(join(dist, f), `${f} ${build}`);
  const r = spawnSync(process.execPath, [join(root, "app", "scripts", "publish-site.mjs"), site], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
}

const has = (f: string) => existsSync(join(site, f));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ficha-publish-"));
  site = join(root, "site");
  mkdirSync(join(root, "app", "scripts"), { recursive: true });
  copyFileSync(script, join(root, "app", "scripts", "publish-site.mjs"));
  write(join(root, "registry", "stations.json"), "{}");
  write(join(root, "registry", "stations.json.sig"), "sig");
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
});
