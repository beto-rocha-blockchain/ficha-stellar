import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ native: true }));
const app = vi.hoisted(() => ({
  launchUrl: undefined as string | undefined,
  listeners: [] as ((e: { url: string }) => void)[],
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => platform.native } }));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: async (_name: string, fn: (e: { url: string }) => void) => {
      app.listeners.push(fn);
      return { remove: async () => {} };
    },
    getLaunchUrl: async () => (app.launchUrl ? { url: app.launchUrl } : undefined),
  },
}));

import { SITE_URL } from "@/config";
import { setupDeepLinks } from "./deep-links";

const HOST = "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6";
const PAY =
  `web+stellar:pay?destination=${HOST}&amount=1&memo=ERZGCG.F3H9TXAB&memo_type=MEMO_TEXT` +
  `&network_passphrase=Test%20SDF%20Network%20%3B%20September%202015&msg=Ficha%20Demo%20bench%20%C2%B7%20session%20ERZGCG.F3H9TXAB`;
const Q = `v=1&m=ERZGCG.F3H9TXAB&n=t&h=${HOST}&a=3&k=XLM&f=3&p=900&u=842&wh=4.250&x=1830&vd=d&c=1&t=1790000000`;
// A custody pay link (contract §7.3, the pay_link test vector).
const P = `v=1&n=t&h=${HOST}&s=ERZGCG&x=F3H9TXAB&a=TG9OzCOB3CQo81pQYU0EkZ8vsDkxCtp6EEMWlUoAK3s`;

let store: Record<string, string>;
beforeEach(() => {
  platform.native = true;
  app.launchUrl = undefined;
  app.listeners = [];
  store = {};
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => void (store[k] = v),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Android deep links", () => {
  it("opens a pay link on Pay and a receipt on Receipt, while the app runs", async () => {
    const go = vi.fn();
    await setupDeepLinks(go);
    expect(go).not.toHaveBeenCalled();
    for (const fn of app.listeners) fn({ url: PAY });
    expect(go).toHaveBeenLastCalledWith(`/pay?uri=${encodeURIComponent(PAY)}`);
    for (const url of [`ficha:/r?${Q}`, `ficha://r?${Q}`, `${SITE_URL}r?${Q}`]) {
      for (const fn of app.listeners) fn({ url });
      expect(go, url).toHaveBeenLastCalledWith(`/r?${Q}`);
    }
    for (const url of [`ficha:/p?${P}`, `ficha://p?${P}`, `${SITE_URL}p?${P}`]) {
      for (const fn of app.listeners) fn({ url });
      expect(go, url).toHaveBeenLastCalledWith(`/p?${P}`);
    }
    go.mockClear();
    for (const fn of app.listeners) fn({ url: `${SITE_URL}registry/stations.json` });
    for (const fn of app.listeners) fn({ url: "ficha:/other?x=1" });
    expect(go).not.toHaveBeenCalled();
  });

  it("opens the link the app was started with, once per WebView session", async () => {
    app.launchUrl = `${SITE_URL}r?${Q}`;
    const go = vi.fn();
    await setupDeepLinks(go);
    expect(go).toHaveBeenCalledExactlyOnceWith(`/r?${Q}`);
    // A reload of the page reads the same launch URL: it is not opened again.
    const again = vi.fn();
    await setupDeepLinks(again);
    expect(again).not.toHaveBeenCalled();
  });

  it("does nothing on the web", async () => {
    platform.native = false;
    app.launchUrl = PAY;
    const go = vi.fn();
    await setupDeepLinks(go);
    expect(go).not.toHaveBeenCalled();
    expect(app.listeners).toHaveLength(0);
  });
});

describe("AndroidManifest intent filters", () => {
  const manifest = readFileSync(fileURLToPath(new URL("../../android/app/src/main/AndroidManifest.xml", import.meta.url)), "utf8");
  const all = [...manifest.matchAll(/<intent-filter([^>]*)>([\s\S]*?)<\/intent-filter>/g)].map((m) => ({ attrs: m[1], body: m[2] }));
  const views = all.filter((f) => f.body.includes("android.intent.action.VIEW"));
  const view = views.map((f) => f.body);
  const data = (f: string) => Object.fromEntries([...f.matchAll(/android:(scheme|host|path|pathPrefix|pathPattern)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

  it("takes web+stellar, ficha and the site's /r receipt and /p custody pay links, from the browser too", () => {
    expect(view.map(data)).toEqual([
      { scheme: "web+stellar" },
      { scheme: "ficha" },
      { scheme: "https", host: new URL(SITE_URL).host, path: `${new URL(SITE_URL).pathname}r` },
      { scheme: "https", host: new URL(SITE_URL).host, path: `${new URL(SITE_URL).pathname}p` },
    ]);
    for (const f of view) {
      expect(f).toContain("android.intent.category.DEFAULT");
      expect(f).toContain("android.intent.category.BROWSABLE");
    }
  });

  it("verifies the site's receipt and pay links as App Links (the site's assetlinks.json), and only those", () => {
    const verified = views.filter((f) => /android:autoVerify="true"/.test(f.attrs)).map((f) => data(f.body));
    expect(verified).toEqual([
      { scheme: "https", host: new URL(SITE_URL).host, path: "/r" },
      { scheme: "https", host: new URL(SITE_URL).host, path: "/p" },
    ]);
  });
});
