/**
 * PIN attempt limit. Every PIN check (unlock, show words, remove from Ajustes)
 * goes through useWallet, which counts wrong PINs here, in IndexedDB next to
 * the vault, so closing or restarting the app does not reset the count.
 * Clearing the app's data does, but that deletes the vault too.
 *
 * After WALLET.pinFreeTries wrong PINs in a row, each further try has to wait
 * (WALLET.pinWaitsMs, the last value repeating). The right PIN resets the count.
 * The wait follows the phone's clock: a clock set back is capped to the wait
 * due, a clock set forward shortens it (the vault is still 600k PBKDF2 per try).
 */
import { del, get, set } from "idb-keyval";
import { WALLET } from "@/config";

export interface PinGuard {
  /** Wrong PINs in a row. A try counts as wrong from the moment it starts until it succeeds. */
  failures: number;
  /** Epoch ms before which no PIN is checked. */
  notBefore: number;
}

export class PinLockedError extends Error {
  /** Epoch ms when the next try is allowed. */
  readonly retryAt: number;
  constructor(retryAt: number) {
    super("too many wrong PINs");
    this.name = "PinLockedError";
    this.retryAt = retryAt;
  }
}

const GUARD_KEY = "ficha.pinguard.v1";
const NONE: PinGuard = { failures: 0, notBefore: 0 };

/** How long the next try waits after `failures` wrong PINs in a row. */
export function pinWaitMs(failures: number): number {
  if (failures < WALLET.pinFreeTries) return 0;
  const waits = WALLET.pinWaitsMs;
  return waits[Math.min(failures - WALLET.pinFreeTries, waits.length - 1)];
}

/** When the next try is allowed (<= now: right away). Never later than the wait due, even if the clock went back. */
export function pinRetryAt(guard: PinGuard, now: number): number {
  return Math.min(guard.notBefore, now + pinWaitMs(guard.failures));
}

export async function loadPinGuard(): Promise<PinGuard> {
  const r = (await get<unknown>(GUARD_KEY)) as Partial<PinGuard> | undefined;
  if (r && Number.isFinite(r.failures) && Number.isFinite(r.notBefore)) return { failures: r.failures!, notBefore: r.notBefore! };
  return NONE;
}

export async function savePinGuard(guard: PinGuard): Promise<void> {
  await set(GUARD_KEY, guard);
}

export async function clearPinGuard(): Promise<void> {
  await del(GUARD_KEY);
}
