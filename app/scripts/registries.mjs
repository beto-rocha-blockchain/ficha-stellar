// The signed station registries the app reads, from ../registry:
// stations.json (testnet) always, and stations.public.json once there is one,
// each with its detached .sig. sync-assets.mjs copies only these names;
// build-site.mjs and publish-site.mjs check that every one of them goes out
// signed and byte for byte (the signature covers the exact bytes), and nothing
// else: a draft (stations.draft.json) or a stray file stays in the repo.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** stations.json, stations.public.json and their .sig: the only registry files published. */
export const REGISTRY_FILE = /^stations(\.public)?\.json(\.sig)?$/;

/**
 * The registry files in `dir` (../registry) the site publishes. Throws when
 * one has no signature: an unsigned registry is never published.
 */
export function registryFiles(dir) {
  const out = [];
  for (const name of ["stations.json", "stations.public.json"]) {
    const json = existsSync(join(dir, name));
    const sig = existsSync(join(dir, `${name}.sig`));
    if (name === "stations.public.json" && !json && !sig) continue; // no public registry yet
    if (!json) throw new Error(`../registry/${name} is missing${sig ? ` (its .sig is there)` : ""}`);
    if (!sig) {
      throw new Error(`../registry/${name} is not signed (no ${name}.sig): sign it (python tools/registry.py sign) ` +
        "and build again; an unsigned registry is never published");
    }
    out.push(name, `${name}.sig`);
  }
  return out;
}

/**
 * Checks that `copy` (shown as `label`) holds exactly the registry files of
 * `repo`, each byte for byte, and nothing else. Throws on the first problem.
 */
export function checkRegistries(repo, copy, label) {
  const want = registryFiles(repo);
  const have = existsSync(copy) ? readdirSync(copy) : [];
  for (const f of have) {
    if (!want.includes(f)) throw new Error(`${label}/${f} is not one of the signed registries in ../registry/ (only those are published)`);
  }
  for (const f of want) {
    if (!have.includes(f)) throw new Error(`${label}/${f} is missing`);
    if (!readFileSync(join(copy, f)).equals(readFileSync(join(repo, f)))) throw new Error(`${label}/${f} differs from ../registry/${f}`);
  }
  return want;
}
