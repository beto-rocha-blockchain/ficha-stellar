/**
 * The SEP-24 deposit the Buy screen is following, kept outside the route.
 *
 * While the user fills the anchor's form in another tab or Custom Tab, the app
 * is hidden and auto-lock can fire; the root lock screen then unmounts the Buy
 * page. Keeping the session here lets the page pick it up again after unlock
 * instead of starting over (and inviting a second deposit).
 *
 * Memory only, never persisted: the JWT is a bearer token for the anchor.
 * Keyed by network and account, so another network or wallet never sees it.
 */
import type { NetworkId } from "@/config";
import type { AnchorCurrency } from "./anchor";

export type BuySession = { jwt: string; id: string; url: string; asset: AnchorCurrency };

let current: (BuySession & { net: NetworkId; account: string }) | null = null;

export function loadBuySession(net: NetworkId, account: string): BuySession | null {
  if (!current || current.net !== net || current.account !== account) return null;
  const { jwt, id, url, asset } = current;
  return { jwt, id, url, asset };
}

/** Remember the deposit being followed, or forget it with null. */
export function saveBuySession(net: NetworkId, account: string, session: BuySession | null): void {
  current = session ? { ...session, net, account } : null;
}
