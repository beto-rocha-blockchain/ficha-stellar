/**
 * A pay link opened before this phone had a wallet (/p or /pay, from the
 * scanner of another app, an Android deep link or a shared URL): the root
 * layout sends the user to /welcome to create or import one, and then opens
 * the link instead of Home, so the station's QR does not have to be scanned
 * again. Kept for the tab's session only (sessionStorage, plus memory where
 * there is none).
 */
const KEY = "ficha.pendingLink";
/** The in-app links worth coming back to: a payment request. */
const LINK_RE = /^\/(?:p|pay)\?[^#\s]+$/;

let memory: string | null = null;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Keep `path` + `search` (with or without its "?") when it is a pay link; anything else is ignored. */
export function rememberPendingLink(path: string, search: string): void {
  const q = search.replace(/^\?/, "");
  const href = `${path}?${q}`;
  if (!q || !LINK_RE.test(href)) return;
  memory = href;
  try {
    storage()?.setItem(KEY, href);
  } catch {
    /* memory only */
  }
}

/** The pay link to open once the wallet exists, or null. */
export function pendingLink(): string | null {
  let href = memory;
  try {
    href ??= storage()?.getItem(KEY) ?? null;
  } catch {
    /* memory only */
  }
  return href !== null && LINK_RE.test(href) ? href : null;
}

export function clearPendingLink(): void {
  memory = null;
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* nothing kept */
  }
}
