// Runs before `npm run dev` and `npm run build` (predev/prebuild).
// 1. Copies the signed station registry ../registry/stations*.json and their
//    .sig -> public/registry/ byte for byte (the signature covers the exact
//    bytes). Nothing else in registry/ is published: a draft or a stray file
//    there would otherwise go to the public site.
// 2. Builds the PWA/app icons from ../brand:
//    - brand/ficha-app-icon.svg if it exists, else the mark on the dark background;
//    - brand/png/*.png copied as-is when present (e.g. icon-192x192.png).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(app, "..");
const pub = join(app, "public");

// 1. registry
const regSrc = join(repo, "registry");
const regDst = join(pub, "registry");
rmSync(regDst, { recursive: true, force: true });
mkdirSync(regDst, { recursive: true });
let n = 0;
if (existsSync(regSrc)) {
  for (const f of readdirSync(regSrc)) {
    if (/^stations(\.[a-z]+)?\.json(\.sig)?$/.test(f)) {
      copyFileSync(join(regSrc, f), join(regDst, f));
      n++;
    }
  }
}
console.log(`[sync-assets] registry: ${n} file(s) -> public/registry/`);

// 2. icons
const brand = join(repo, "brand");
const iconsDst = join(pub, "icons");
rmSync(iconsDst, { recursive: true, force: true });
mkdirSync(iconsDst, { recursive: true });

const BG = "#05080f"; // --background, dark
const FG = "#56c8e8"; // --primary, dark (approx. oklch(0.78 0.13 215))
let iconSvg;
const appIcon = join(brand, "ficha-app-icon.svg");
if (existsSync(appIcon)) {
  iconSvg = readFileSync(appIcon, "utf8");
} else {
  const mark = readFileSync(join(brand, "ficha-mark.svg"), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/currentColor/g, FG);
  const inner = mark.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const vb = /viewBox="([^"]+)"/.exec(mark)?.[1] ?? "0 0 64 64";
  // Mark scaled into the maskable safe zone (inner 60%) of a 512 square.
  iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${BG}"/><svg x="102" y="102" width="308" height="308" viewBox="${vb}">${inner}</svg></svg>\n`;
}
writeFileSync(join(iconsDst, "icon.svg"), iconSvg);
writeFileSync(join(pub, "favicon.svg"), iconSvg);

const pngDir = join(brand, "png");
let p = 0;
if (existsSync(pngDir)) {
  for (const f of readdirSync(pngDir)) {
    if (f.endsWith(".png")) {
      copyFileSync(join(pngDir, f), join(iconsDst, f));
      p++;
    }
  }
}
console.log(`[sync-assets] icons: icon.svg${existsSync(appIcon) ? " (ficha-app-icon.svg)" : " (from ficha-mark.svg)"} + ${p} png`);
