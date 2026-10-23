/**
 * The service worker (vite.config.ts, vite-plugin-pwa) is for the web PWA only.
 *
 * The Android app already carries every file inside the APK, served by
 * Capacitor at https://localhost. A service worker there only adds a stale
 * copy: after an APK update its precache answered the first launch with the
 * previous build, and once the new worker took over, that build's lazy route
 * chunks were gone ("Failed to fetch dynamically imported module"). So the
 * app never registers it, and removes the one an older build left behind.
 */
import { Capacitor } from "@capacitor/core";

/** Cache Storage names service workers created: Workbox precache, and the registry cache of older builds. */
const SW_CACHE = /^workbox-|^ficha-registry$/;
const REGISTRY_CACHE = "ficha-registry";

/** Pages that need no unlocked wallet and hold no half-done step: a reload there loses nothing. */
const RELOAD_SAFE_PATHS = ["/r", "/stations", "/estabelecimentos", "/battery"];

/**
 * Whether the page may reload into a new build now. Never with the wallet
 * unlocked (a reload locks it), nor on /welcome (the words not saved yet),
 * /pay, /buy, /settings or /scan, except behind an idle lock screen.
 * `idleLockScreen`: the root lock screen shows with nothing typed and the
 * page was never unlocked (see reloadGate). A reload there comes back to the
 * same lock screen and loses nothing. That is where the start URL opens, so
 * the first visit after a publish reloads before the PIN, not after it.
 */
export function reloadIsSafe(path: string, walletStatus: string, idleLockScreen = false): boolean {
  if (walletStatus === "unlocked") return false;
  if (walletStatus === "locked" && idleLockScreen) return true;
  return RELOAD_SAFE_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/** When the page may reload into a new build (main.tsx: the router path and the wallet state). */
export interface ReloadGate {
  safe: () => boolean;
  /** Calls back whenever safe() may have changed. */
  subscribe: (cb: () => void) => void;
}

let lockScreenIdle = false;
const lockScreenListeners = new Set<() => void>();

/**
 * LockScreen: it shows with an empty PIN field, no check running, no error
 * to read and no dialog open (false when it goes away).
 */
export function setLockScreenIdle(idle: boolean): void {
  if (idle === lockScreenIdle) return;
  lockScreenIdle = idle;
  for (const cb of lockScreenListeners) cb();
}

/**
 * The gate main.tsx gives setupServiceWorker: the route and the wallet state,
 * plus the idle lock screen until the page is first unlocked. After that the
 * lock screen may hide state kept only in memory that a reload would lose (the
 * Pay screen's last payment, the Buy screen's deposit): it waits, as before.
 */
export function reloadGate(opts: {
  path: () => string;
  wallet: { getState: () => { status: string }; subscribe: (cb: (s: { status: string }) => void) => unknown };
  onRoute: (cb: () => void) => unknown;
}): ReloadGate {
  let everUnlocked = opts.wallet.getState().status === "unlocked";
  opts.wallet.subscribe((s) => {
    if (s.status === "unlocked") everUnlocked = true;
  });
  return {
    safe: () => reloadIsSafe(opts.path(), opts.wallet.getState().status, lockScreenIdle && !everUnlocked),
    subscribe: (cb) => {
      opts.onRoute(cb);
      opts.wallet.subscribe(cb);
      lockScreenListeners.add(cb);
    },
  };
}

export async function setupServiceWorker(gate?: ReloadGate): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (Capacitor.isNativePlatform()) {
    await removeServiceWorker();
    return;
  }
  // The dev server has no /sw.js (vite-plugin-pwa builds it only for
  // production): it answers with index.html, which the browser refuses.
  if (!import.meta.env.PROD) return;
  // After a site publish the first visit runs the previous build from the
  // precache; the new worker then takes over (skipWaiting, clientsClaim) but
  // the page stays on the old build. Reload once into the new one, as soon as
  // that loses nothing. Not on the first install: that page is already current.
  if (gate && navigator.serviceWorker.controller) {
    let updated = false;
    let reloading = false;
    const reloadIfSafe = () => {
      if (!updated || reloading || !gate.safe()) return;
      reloading = true;
      location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      updated = true;
      reloadIfSafe();
    });
    gate.subscribe(reloadIfSafe);
  }
  // Older builds' workers kept the registry in a runtime cache: nothing reads it now.
  try {
    if (typeof caches !== "undefined") await caches.delete(REGISTRY_CACHE);
  } catch {
    /* no Cache Storage: nothing to remove */
  }
  // Same as the registerSW.js vite-plugin-pwa used to inject: register after load.
  // At the root on the Ficha site; under a sub-path base (VITE_BASE) the worker and its scope are too.
  const base = import.meta.env.BASE_URL;
  const register = () => {
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch((e) => console.warn("service worker", e));
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

async function removeServiceWorker(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    if (typeof caches !== "undefined") {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => SW_CACHE.test(n)).map((n) => caches.delete(n)));
    }
  } catch (e) {
    console.warn("service worker cleanup", e);
  }
}
