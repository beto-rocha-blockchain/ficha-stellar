/** Scanned receipts, kept on this phone only (IndexedDB `ficha.receipts.v1`). */
import { createStore, entries, get, set } from "idb-keyval";
import type { Receipt } from "./receipt";

export type ReceiptCheck = "confirmed" | "not_confirmed";

export interface StoredReceipt {
  receipt: Receipt;
  check: ReceiptCheck;
  /** Why it was not confirmed (i18n key suffix), when check = not_confirmed. */
  reason?: string;
  /**
   * When confirmed: the user's own payments the station credited. Less than
   * the receipt amount when several wallets paid the session; absent in
   * receipts saved before that was checked (= the whole amount).
   */
  share?: string;
  savedAt: number;
}

let idbStore: ReturnType<typeof createStore> | null = null;
function store() {
  idbStore ??= createStore("ficha.receipts.v1", "receipts");
  return idbStore;
}

const key = (network: Receipt["network"], hostKey: string, memo: string) => `${network}|${hostKey}|${memo}`;

export async function saveReceipt(r: StoredReceipt): Promise<void> {
  try {
    const prev = await get<StoredReceipt>(key(r.receipt.network, r.receipt.hostKey, r.receipt.memo), store());
    // Keep a confirmation once earned: a later offline scan, or a crafted
    // link with another amount, must not downgrade it. History compares it
    // with the wallet's current payments instead (receiptStanding).
    if (prev?.check === "confirmed" && r.check !== "confirmed") return;
    // A custody receipt with fewer unused units than the one kept can be made
    // from public data (its proof hashed forward): it never replaces it.
    if (prev?.check === "confirmed" && (prev.receipt.refund?.units ?? 0) > (r.receipt.refund?.units ?? 0)) return;
    await set(key(r.receipt.network, r.receipt.hostKey, r.receipt.memo), r, store());
  } catch {
    /* no IndexedDB: the receipt is still shown, just not kept */
  }
}

/**
 * The receipt kept for a session, if any. The station shows the receipt QR
 * only on its FINISHED screen (contract §3), so one here means the session is
 * over: a payment with its memo would be logged as orphan, not credited.
 */
export async function getReceipt(network: Receipt["network"], hostKey: string, memo: string): Promise<StoredReceipt | undefined> {
  try {
    return await get<StoredReceipt>(key(network, hostKey, memo), store());
  } catch {
    return undefined;
  }
}

export async function listReceipts(network: Receipt["network"]): Promise<StoredReceipt[]> {
  try {
    const all = await entries<string, StoredReceipt>(store());
    return all.map(([, v]) => v).filter((v) => v.receipt.network === network);
  } catch {
    return [];
  }
}
