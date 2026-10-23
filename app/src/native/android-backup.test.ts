import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The wallet vault lives in the WebView's IndexedDB, inside the app data dir.
// Android backups and device-to-device transfer must not copy it off the phone.
const main = new URL("../../android/app/src/main/", import.meta.url);
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, main)), "utf8");
const manifest = read("AndroidManifest.xml");

function attr(name: string): string | undefined {
  return new RegExp(`android:${name}="([^"]*)"`).exec(manifest)?.[1];
}

function excluded(xml: string): string[] {
  return [...xml.matchAll(/<exclude\s+domain="([^"]+)"\s+path="\."\s*\/>/g)].map((m) => m[1]);
}

const ALL = ["root", "file", "database", "sharedpref", "external", "device_root", "device_file", "device_database", "device_sharedpref"];

describe("android backup", () => {
  it("turns app backup off", () => {
    expect(attr("allowBackup")).toBe("false");
  });

  it("excludes all app data from cloud backup and device transfer (Android 12+)", () => {
    const ref = attr("dataExtractionRules");
    expect(ref).toMatch(/^@xml\//);
    const xml = read(`res/xml/${ref!.slice(5)}.xml`);
    for (const section of ["cloud-backup", "device-transfer"]) {
      const body = new RegExp(`<${section}[^>]*>([\\s\\S]*?)</${section}>`).exec(xml)?.[1] ?? "";
      expect(body, section).not.toMatch(/<include\b/);
      expect(excluded(body).sort(), section).toEqual([...ALL].sort());
    }
  });

  it("excludes all app data from full backup (Android 11 and older)", () => {
    const ref = attr("fullBackupContent");
    expect(ref).toMatch(/^@xml\//);
    const xml = read(`res/xml/${ref!.slice(5)}.xml`);
    expect(xml).not.toMatch(/<include\b/);
    expect(excluded(xml).sort()).toEqual([...ALL].sort());
  });
});
