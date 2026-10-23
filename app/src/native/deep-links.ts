/**
 * Links that open the Android app (AndroidManifest.xml intent filters):
 *   - a station's pay link   web+stellar:pay?destination=...&memo=...   -> /pay?uri=...
 *   - a custody pay link     ficha:/p?v=1&...  or  https://ficha-stellar.vercel.app/p?v=1&...  -> /p?...
 *   - a receipt              ficha:/r?v=1&...  or  https://ficha-stellar.vercel.app/r?v=1&...  -> /r?...
 * The same inputs the scanner takes (src/pay/qr.ts linkRoute), on a cold start
 * (App.getLaunchUrl) and while the app runs (appUrlOpen). Anything else is
 * ignored. The web app gets these as ordinary URLs and needs none of this.
 */
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { forgetLastPayment } from "@/pay/last-payment";
import { linkRoute } from "@/pay/qr";

/**
 * The launch URL already routed in this WebView session: a reload must not open it again.
 * A new process (Android killed the app in the background) starts with empty sessionStorage;
 * there MainActivity drops the old link before the bridge sees it (LaunchLinks.kt).
 */
const HANDLED_KEY = "ficha.launchUrl";

function launchHandled(url: string): boolean {
  try {
    if (sessionStorage.getItem(HANDLED_KEY) === url) return true;
    sessionStorage.setItem(HANDLED_KEY, url);
  } catch {
    /* no sessionStorage: route it */
  }
  return false;
}

/** Wires the Android deep links to `navigate` (an in-app href such as "/r?v=1&..."). No-op on the web. */
export async function setupDeepLinks(navigate: (href: string) => void): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const open = (url: string | undefined): void => {
    const to = url ? linkRoute(url) : null;
    if (!to) {
      if (url) console.warn("deep link ignored", url.slice(0, 80));
      return;
    }
    // A station link opened again is a new request (more fichas): show its Pay form (as the scanner does).
    if (to.startsWith("/pay?") || to.startsWith("/p?")) forgetLastPayment();
    navigate(to);
  };
  await App.addListener("appUrlOpen", (e) => open(e.url));
  try {
    const launch = await App.getLaunchUrl();
    if (launch?.url && !launchHandled(launch.url)) open(launch.url);
  } catch (e) {
    console.warn("launch url", e);
  }
}
