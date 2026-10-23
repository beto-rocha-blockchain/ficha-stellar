// Copies the built site (app/dist-site/, from `npm run build:site`) into a
// checkout of the private site repository (the built site only), which the
// Vercel project "ficha" deploys at
// https://ficha-stellar.vercel.app/ on each push. It does not commit or push:
// whoever publishes reviews `git status` there and pushes.
//
//   node scripts/publish-site.mjs <target git directory>
//
// Only files this script wrote before are removed (listed in
// .ficha-site-files in the target), so anything else kept there (a README)
// stays, and files older builds had and this one does not (404.html,
// .nojekyll) go. The previous publish's hashed build files (assets/) stay one
// more publish (listed in .ficha-site-files-kept): a page still running that
// build loads its lazy route chunks from them. registry/ is copied byte for
// byte: its signature covers the exact bytes, so the target should mark it
// -text in .gitattributes; the script writes that file when the target has none.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "..");
const src = join(app, "dist-site");
const LIST = ".ficha-site-files";
const KEPT = ".ficha-site-files-kept";

function fail(msg) {
  console.error(`[publish-site] ${msg}`);
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) fail("usage: node scripts/publish-site.mjs <target git directory>");
const target = resolve(arg);
if (!existsSync(join(src, "index.html")) || !existsSync(join(src, "vercel.json"))) fail("app/dist-site/ is not built: run npm run build:site first");
if (!existsSync(target) || !statSync(target).isDirectory()) fail(`${target} is not a directory`);
// .git is a directory in a clone and a file in a worktree.
if (!existsSync(join(target, ".git"))) fail(`${target} is not the top of a git working tree (no .git)`);
const inside = (dir, p) => {
  const r = relative(dir, p);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep) && !/^[a-z]:/i.test(r));
};
// Never the source tree itself (nor a folder that holds it, nor one inside app/).
if (inside(target, repo) || inside(app, target)) fail(`${target} is the source repo or inside app/: give the site's own checkout`);

/** Every file under `dir`, as forward-slash paths relative to it. */
function files(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p, base));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

const list = (name) => (existsSync(join(target, name)) ? readFileSync(join(target, name), "utf8").split("\n").filter(Boolean) : []);
const next = files(src).sort();
const prev = list(LIST);
// The previous build's hashed files (assets/: the name changes with the
// content) stay one more publish. The first visit after a publish runs that
// build from the old worker's precache until it can reload into the new one
// (src/native/service-worker.ts), and the new worker drops the old files from
// the precache, so that build's lazy route chunks come from the site. Without
// them, opening Pay failed to load, the router reloaded the page and the
// wallet asked for the PIN again. Files kept by the publish before that go now.
const nextSet = new Set(next);
let kept = prev.filter((f) => !nextSet.has(f) && f.startsWith("assets/"));
// No build file changed (the same build again): the one before is still the previous build.
if (kept.length === 0) kept = list(KEPT).filter((f) => !nextSet.has(f));
const keep = new Set([...next, ...kept]);
let removed = 0;
for (const f of new Set([...prev, ...list(KEPT)])) {
  // Paths come from our own lists: never follow one out of the target.
  const p = resolve(target, f);
  if (keep.has(f) || !inside(target, p) || f === ".git" || f.startsWith(".git/")) continue;
  if (existsSync(p)) {
    rmSync(p, { force: true });
    removed++;
  }
}
for (const f of next) {
  const to = join(target, ...f.split("/"));
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(src, ...f.split("/")), to);
}
writeFileSync(join(target, LIST), `${next.join("\n")}\n`);
writeFileSync(join(target, KEPT), kept.map((f) => `${f}\n`).join(""));
if (!existsSync(join(target, ".gitattributes"))) writeFileSync(join(target, ".gitattributes"), "registry/** -text\n");

// Same bytes as the repo's signed registry, or the app rejects the site's copy.
for (const f of ["stations.json", "stations.json.sig"]) {
  if (!readFileSync(join(target, "registry", f)).equals(readFileSync(join(repo, "registry", f)))) fail(`registry/${f} in the target differs from ../registry/${f}`);
}
console.log(`[publish-site] ${next.length} file(s) copied, ${kept.length} of the previous build kept, ${removed} old file(s) removed -> ${target}`);
console.log("[publish-site] next, in the target: git status; git add -A; git commit; git push");
