import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { VitePWA, type ManifestOptions } from "vite-plugin-pwa";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// PNG icons are optional: scripts/sync-assets.mjs copies them from
// ../brand/png/ when the final logo ships them. The SVG icon always exists.
const iconsDir = fileURLToPath(new URL("./public/icons", import.meta.url));
const pngIcons: ManifestOptions["icons"] = existsSync(iconsDir)
  ? readdirSync(iconsDir)
      .map((f) => /(\d+)x\1\.png$/.exec(f) && { f, s: /(\d+)x\1\.png$/.exec(f)![1] })
      .filter((x): x is { f: string; s: string } => Boolean(x))
      .map(({ f, s }) => ({ src: `icons/${f}`, sizes: `${s}x${s}`, type: "image/png", purpose: "any" }))
  : [];

/**
 * Public path the app is served under: "/" for the dev server, the Android app
 * (dist/) and the Ficha site at https://ficha-stellar.vercel.app/ (npm run
 * build:site, scripts/build-site.mjs). VITE_BASE=/some/path/ builds it for a
 * sub-path instead. Router basepath, PWA scope and service worker follow it.
 */
export function appBase(raw: string | undefined): string {
  const b = (raw ?? "").trim();
  if (!b || b === "/") return "/";
  if (!/^\/[A-Za-z0-9._~\/-]*$/.test(b) || b.includes("//")) throw new Error(`VITE_BASE=${raw}: use a path like /app/`);
  return b.endsWith("/") ? b : `${b}/`;
}

const base = appBase(process.env.VITE_BASE);

/** The service worker's Workbox options (web PWA only; see src/native/service-worker.ts). */
export function workboxOptions(base: string) {
  return {
    globPatterns: ["**/*.{js,css,html,svg,png,woff,woff2}"],
    // The signed registry must never be served stale from the precache, nor from
    // a runtime cache (none is set up): a cached answer reached the app as a
    // normal 200 and it said "verified, online" while offline. The app keeps
    // its own verified offline copy (src/registry, IndexedDB) and labels it so.
    globIgnores: ["registry/**"],
    navigateFallback: `${base}index.html`,
    // The registry URL is published for people to open and check: the signed
    // JSON, not the app; so is the App Link file in .well-known/. (Precached
    // files are served before the fallback.)
    navigateFallbackDenylist: [/\/registry\//, /\/\.well-known\//],
    // What injectRegister "auto" turned on: a new worker takes over at once.
    skipWaiting: true,
    clientsClaim: true,
    maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
  };
}

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0"),
  },
  plugins: [
    // Must come before react(): generates src/routeTree.gen.ts from src/routes/.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      // src/native/service-worker.ts registers it on the web only: in the
      // Android app the files are already local and a worker only serves a
      // stale build after an APK update.
      injectRegister: false,
      includeAssets: ["favicon.svg", "icons/*.svg", "icons/*.png"],
      manifest: {
        name: "Ficha",
        short_name: "Ficha",
        description: "Ficha: pay-per-minute phone charging on Stellar. Prepay in XLM or USDC; your keys stay on your phone.",
        lang: "en",
        id: base,
        start_url: base,
        scope: base,
        display: "standalone",
        orientation: "portrait",
        background_color: "#05080f",
        theme_color: "#05080f",
        icons: [
          { src: "icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
          ...pngIcons,
        ],
      },
      workbox: workboxOptions(base),
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Repo-level brand folder: the final logo drops in with the same file names.
      "@brand": fileURLToPath(new URL("../brand", import.meta.url)),
    },
  },
  server: {
    host: true,
    // The app plus ../brand (the logo lives at the repo root) and nothing else of
    // the repo: with host: true, /@fs/ is reachable from the LAN, and the repo
    // root holds station files such as the session log.
    fs: { allow: [".", "../brand"] },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});
