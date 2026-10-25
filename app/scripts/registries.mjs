// The signed station registries the app reads, from ../registry:
// stations.json (testnet) always, and stations.public.json once there is one,
// each with its detached .sig. sync-assets.mjs copies only these names;
// build-site.mjs and publish-site.mjs check that every one of them goes out
// signed by the registry key pinned for its network and byte for byte (the
// signature covers the exact bytes), and nothing else: a draft
// (stations.draft.json) or a stray file stays in the repo.
import { createPublicKey, verify } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** stations.json, stations.public.json and their .sig: the only registry files published. */
export const REGISTRY_FILE = /^stations(\.public)?\.json(\.sig)?$/;

const NETWORK = { "stations.json": "testnet", "stations.public.json": "public" };
const SIG_FORMAT = "ficha-registry-sig/1";
const CONTRACT = "docs/station-app-contract.md";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * The registry keys pinned in the contract ("Registry key (testnet): G..."),
 * by network. The smoke test checks that config.py and the app pin the same.
 */
function pinnedKeys(repo) {
  let text;
  try {
    text = readFileSync(join(repo, CONTRACT), "utf8");
  } catch {
    throw new Error(`cannot read ${CONTRACT}, where the registry keys are pinned`);
  }
  const keys = {};
  for (const m of text.matchAll(/Registry key \((testnet|public)\): (G[A-Z2-7]{55})/g)) keys[m[1]] ??= m[2];
  return keys;
}

/** The ed25519 key of a Stellar account ID (G...: version byte, 32 bytes, CRC16), or null. */
function ed25519Key(account) {
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const c of account) {
    value = ((value << 5) | BASE32.indexOf(c)) & 0x1fff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  if (bytes.length !== 35 || bytes[0] !== 6 << 3) return null;
  let crc = 0;
  for (const b of bytes.slice(0, 33)) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  if (crc !== (bytes[33] | (bytes[34] << 8))) return null;
  const x = Buffer.from(bytes.slice(1, 33)).toString("base64url");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

/**
 * Throws unless ../registry/`name`.sig is a signature of the exact bytes of
 * `name` by `pinned`, the key the app and the stations verify it with.
 */
function checkSignature(dir, name, pinned) {
  const network = NETWORK[name];
  if (!pinned) {
    throw new Error(`no ${network} registry key is pinned in ${CONTRACT} ("Registry key (${network}): G..."): ` +
      `the app could not verify ../registry/${name}, so it is never published`);
  }
  const key = ed25519Key(pinned);
  if (!key) throw new Error(`the ${network} registry key pinned in ${CONTRACT} (${pinned}) is not a Stellar public key`);
  let sig;
  try {
    sig = JSON.parse(readFileSync(join(dir, `${name}.sig`), "utf8"));
  } catch {
    sig = null;
  }
  if (sig?.format !== SIG_FORMAT || typeof sig.key !== "string" || typeof sig.sig !== "string") {
    throw new Error(`../registry/${name}.sig is not a ${SIG_FORMAT} signature file: sign it (python tools/registry.py sign) and build again`);
  }
  if (sig.key !== pinned) {
    throw new Error(`../registry/${name} is signed by ${sig.key}, not by the ${network} registry key pinned in ` +
      `${CONTRACT} (${pinned}): the app and the stations refuse it, so it is never published`);
  }
  let ok = false;
  try {
    ok = verify(null, readFileSync(join(dir, name)), key, Buffer.from(sig.sig, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(`../registry/${name}.sig does not match these bytes (edited after signing?): sign it again ` +
      "(python tools/registry.py sign) and build again; a registry whose signature does not verify is never published");
  }
}

/**
 * The registry files in `dir` (../registry) the site publishes. Throws when
 * one is not signed by the key pinned for its network: an unsigned registry,
 * one signed by another key or one edited after signing is never published.
 */
export function registryFiles(dir) {
  const out = [];
  let pinned;
  for (const name of ["stations.json", "stations.public.json"]) {
    const json = existsSync(join(dir, name));
    const sig = existsSync(join(dir, `${name}.sig`));
    if (name === "stations.public.json" && !json && !sig) continue; // no public registry yet
    if (!json) throw new Error(`../registry/${name} is missing${sig ? ` (its .sig is there)` : ""}`);
    if (!sig) {
      throw new Error(`../registry/${name} is not signed (no ${name}.sig): sign it (python tools/registry.py sign) ` +
        "and build again; an unsigned registry is never published");
    }
    pinned ??= pinnedKeys(join(dir, ".."));
    checkSignature(dir, name, pinned[NETWORK[name]]);
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
