/**
 * Keeps screens that show the recovery words or the S... secret out of
 * screenshots, screen recordings and the Recents thumbnail (Android
 * FLAG_SECURE, native plugin FichaSecureScreen,
 * android/app/src/main/java/app/ficha/wallet/secure/FichaSecureScreenPlugin.kt).
 *
 * Only those screens: the rest of the app (the receive QR, balances) can still
 * be captured. On the web (PWA, browser, tests) there is no such control and
 * this does nothing.
 */
import { useEffect } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";

interface FichaSecureScreenPlugin {
  setSecure(options: { secure: boolean }): Promise<void>;
}

const FichaSecureScreen = registerPlugin<FichaSecureScreenPlugin>("FichaSecureScreen");

/** Screens currently asking for the flag; it is on while this is above 0. */
let holders = 0;

function apply(secure: boolean): void {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("FichaSecureScreen")) return;
  FichaSecureScreen.setSecure({ secure }).catch(() => {});
}

/** Turn the flag on for one screen; call the returned function when it goes away. */
export function holdSecureScreen(): () => void {
  if (holders++ === 0) apply(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders === 0) apply(false);
  };
}

/** FLAG_SECURE while the calling component is mounted and `active` is true. */
export function useSecureScreen(active = true): void {
  useEffect(() => (active ? holdSecureScreen() : undefined), [active]);
}
