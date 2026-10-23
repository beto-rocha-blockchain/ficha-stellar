/**
 * localStorage that never throws (private mode, blocked storage, WebView quirks).
 * Only for small preferences. Secrets NEVER go here: the vault lives in IndexedDB,
 * encrypted (src/wallet/vault.ts).
 */
export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the preference just won't persist */
  }
}
