// npm run build:site: the web app for the Ficha site https://ficha-stellar.vercel.app/
// (the Vercel project "ficha") -> app/dist-site/ (gitignored).
//
// - Built at the root "/" (VITE_BASE; vite.config.ts appBase), like the Android app.
// - site/ adds what only the site carries:
//   - vercel.json. A path that is not a file gets index.html, so a hard
//     reload of a deep link such as /r?v=1&..., /stations/ERZGCG or
//     /estabelecimentos still loads the app, and the router takes the path
//     from the address bar. /registry/ gets CORS (the Android app reads it
//     from another origin) and no-cache (a new signature shows at once).
//   - .well-known/assetlinks.json: makes https://ficha-stellar.vercel.app/r a
//     verified App Link of app.ficha.wallet (AndroidManifest.xml).
// - registry/ (every signed registry, byte for byte: scripts/registries.mjs),
//   the icons and the manifest come from public/.
//
// scripts/publish-site.mjs copies the result into a checkout of the private
// site repository the Vercel project deploys.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRegistries, registryFiles } from "./registries.mjs";

export const SITE_BASE = "/";
const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(app, "dist-site");
const registry = join(app, "..", "registry");

/** Runs a node script of the app (no shell). */
function node(script, args = [], env = {}) {
  const r = spawnSync(process.execPath, [join(app, script), ...args], { cwd: app, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** Runs one of the registry checks; a problem fails the build. */
function registries(check) {
  try {
    return check();
  } catch (e) {
    console.error(`[build-site] ${e.message}`);
    process.exit(1);
  }
}

// Before building: a registry without its .sig fails here, not on the site.
registries(() => registryFiles(registry));
node("scripts/sync-assets.mjs");
node("node_modules/vite/bin/vite.js", ["build", "--outDir", "dist-site", "--emptyOutDir"], { VITE_BASE: SITE_BASE });

cpSync(join(app, "site"), out, { recursive: true });

// What the site must carry; a missing piece fails the build instead of the site.
const must = [
  "index.html",
  "vercel.json",
  ".well-known/assetlinks.json",
  "sw.js",
  "manifest.webmanifest",
  "favicon.svg",
  "icons/icon.svg",
  "registry/stations.json",
  "registry/stations.json.sig",
];
const missing = must.filter((f) => !existsSync(join(out, f)));
if (missing.length) {
  console.error(`[build-site] missing in dist-site/: ${missing.join(", ")}`);
  process.exit(1);
}
// The registry signature covers the exact bytes: every signed registry
// (stations.public.json too, once there is one) must be identical, and
// nothing else may sit next to them.
const published = registries(() => checkRegistries(registry, join(out, "registry"), "dist-site/registry"));
const html = readFileSync(join(out, "index.html"), "utf8");
if (!html.includes(`src="${SITE_BASE}assets/`)) {
  console.error(`[build-site] index.html does not load its scripts from ${SITE_BASE}assets/`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(out, "manifest.webmanifest"), "utf8"));
if (manifest.scope !== SITE_BASE || manifest.start_url !== SITE_BASE) {
  console.error(`[build-site] manifest scope/start_url is not ${SITE_BASE}`);
  process.exit(1);
}
console.log(`[build-site] registry: ${published.filter((f) => !f.endsWith(".sig")).join(", ")}, signed`);
console.log("[build-site] dist-site/ ready (site root /): node scripts/publish-site.mjs <site checkout>");
