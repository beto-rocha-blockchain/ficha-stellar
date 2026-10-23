import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ native: false }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => platform.native } }));

import { reloadIsSafe, setupServiceWorker, type ReloadGate } from "./service-worker";

let sw: EventTarget & { register: ReturnType<typeof vi.fn>; getRegistrations: ReturnType<typeof vi.fn>; controller: object | null };
let unregister: ReturnType<typeof vi.fn>;
let cacheNames: string[];
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  unregister = vi.fn(async () => true);
  reload = vi.fn();
  sw = Object.assign(new EventTarget(), {
    register: vi.fn(async () => ({})),
    getRegistrations: vi.fn(async () => [{ scope: "https://localhost/", unregister }]),
    controller: null,
  });
  vi.stubGlobal("location", { reload });
  cacheNames = ["workbox-precache-v2-https://localhost/", "ficha-registry", "something-else"];
  vi.stubGlobal("navigator", { serviceWorker: sw });
  vi.stubGlobal("caches", {
    keys: async () => [...cacheNames],
    delete: async (n: string) => {
      cacheNames = cacheNames.filter((c) => c !== n);
      return true;
    },
  });
  vi.stubGlobal("document", { readyState: "complete" });
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("service worker", () => {
  it("is never registered in the Android app, and an old one and its caches are removed", async () => {
    platform.native = true;
    await setupServiceWorker();
    expect(sw.register).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(cacheNames).toEqual(["something-else"]);
  });

  it("is registered on the web, after load", async () => {
    platform.native = false;
    vi.stubEnv("PROD", true);
    vi.stubGlobal("document", { readyState: "loading" });
    await setupServiceWorker();
    expect(sw.register).not.toHaveBeenCalled();
    (window as unknown as EventTarget).dispatchEvent(new Event("load"));
    expect(sw.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(unregister).not.toHaveBeenCalled();
    // The registry cache of older builds goes (nothing reads it); the precache stays.
    expect(cacheNames).toEqual(["workbox-precache-v2-https://localhost/", "something-else"]);
  });

  it("is registered under a sub-path base (VITE_BASE) when the app is built for one", async () => {
    platform.native = false;
    vi.stubEnv("PROD", true);
    vi.stubEnv("BASE_URL", "/app/");
    await setupServiceWorker();
    expect(sw.register).toHaveBeenCalledWith("/app/sw.js", { scope: "/app/" });
  });

  it("is not registered by the dev server, which has no /sw.js", async () => {
    platform.native = false;
    vi.stubEnv("PROD", false);
    await setupServiceWorker();
    (window as unknown as EventTarget).dispatchEvent(new Event("load"));
    expect(sw.register).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
  });

  describe("after a site publish (a new worker takes over the page)", () => {
    let safe: boolean;
    let notify: () => void;
    const gate: ReloadGate = { safe: () => safe, subscribe: (cb) => (notify = cb) };
    const takeOver = () => sw.dispatchEvent(new Event("controllerchange"));

    beforeEach(() => {
      platform.native = false;
      vi.stubEnv("PROD", true);
      safe = true;
      notify = () => {};
    });

    it("reloads once into the new build where that loses nothing", async () => {
      sw.controller = {};
      await setupServiceWorker(gate);
      notify();
      expect(reload).not.toHaveBeenCalled();
      takeOver();
      takeOver();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("waits while a reload would lose something, then reloads", async () => {
      sw.controller = {};
      safe = false;
      await setupServiceWorker(gate);
      takeOver();
      notify();
      expect(reload).not.toHaveBeenCalled();
      safe = true;
      notify();
      notify();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("does not reload on the first install: that page is already the current build", async () => {
      sw.controller = null;
      await setupServiceWorker(gate);
      takeOver();
      notify();
      expect(reload).not.toHaveBeenCalled();
    });

    it("is safe only on pages that need no unlocked wallet and hold no half-done step", () => {
      for (const p of ["/r", "/stations", "/stations/ERZGCG", "/estabelecimentos", "/battery"]) {
        expect(reloadIsSafe(p, "locked"), p).toBe(true);
        expect(reloadIsSafe(p, "none"), p).toBe(true);
        // A reload would lock the wallet again.
        expect(reloadIsSafe(p, "unlocked"), p).toBe(false);
      }
      for (const p of ["/", "/welcome", "/pay", "/buy", "/settings", "/scan", "/history", "/rx"]) {
        expect(reloadIsSafe(p, "locked"), p).toBe(false);
        expect(reloadIsSafe(p, "none"), p).toBe(false);
      }
    });

    it("is safe behind the idle lock screen of a page never unlocked, whatever the path (the start URL / opens there)", () => {
      for (const p of ["/", "/pay", "/history", "/settings", "/scan"]) {
        expect(reloadIsSafe(p, "locked", true), p).toBe(true);
        expect(reloadIsSafe(p, "unlocked", true), p).toBe(false);
        // No wallet: /welcome, where the words may not be saved yet.
        expect(reloadIsSafe(p, "none", true), p).toBe(false);
        expect(reloadIsSafe(p, "loading", true), p).toBe(false);
      }
    });

    describe("the app's gate (main.tsx)", () => {
      type Status = "loading" | "none" | "locked" | "unlocked";
      let status: Status;
      let walletCbs: ((s: { status: string }) => void)[];
      let routeCbs: (() => void)[];
      let sw_: typeof import("./service-worker");
      const setStatus = (s: Status) => {
        status = s;
        for (const cb of walletCbs) cb({ status });
      };

      beforeEach(async () => {
        status = "loading";
        walletCbs = [];
        routeCbs = [];
        // A fresh module: the lock screen state is module-wide.
        vi.resetModules();
        sw_ = await import("./service-worker");
      });

      const gateFor = (path = "/") =>
        sw_.reloadGate({
          path: () => path,
          wallet: { getState: () => ({ status }), subscribe: (cb) => walletCbs.push(cb) },
          onRoute: (cb) => routeCbs.push(cb),
        });

      it("after a publish, reloads on the start URL's lock screen before the PIN is typed", async () => {
        sw.controller = {};
        await sw_.setupServiceWorker(gateFor("/"));
        setStatus("locked");
        takeOver();
        expect(reload).not.toHaveBeenCalled();
        sw_.setLockScreenIdle(true);
        expect(reload).toHaveBeenCalledTimes(1);
      });

      it("waits while a PIN is being typed, and never reloads once the page was unlocked", async () => {
        sw.controller = {};
        const gate = gateFor("/");
        await sw_.setupServiceWorker(gate);
        setStatus("locked");
        sw_.setLockScreenIdle(false); // a digit typed
        takeOver();
        setStatus("unlocked");
        sw_.setLockScreenIdle(false);
        // Auto-lock later: the lock screen may hide the last payment or the Buy deposit (memory only).
        setStatus("locked");
        sw_.setLockScreenIdle(true);
        for (const cb of routeCbs) cb();
        expect(reload).not.toHaveBeenCalled();
        expect(gate.safe()).toBe(false);
      });
    });
  });

  it("does nothing where service workers are not supported", async () => {
    platform.native = true;
    vi.stubGlobal("navigator", {});
    await expect(setupServiceWorker()).resolves.toBeUndefined();
    expect(cacheNames).toHaveLength(3);
  });
});
