/**
 * Wallet state. The store holds only PUBLIC data (status, address).
 * The unlocked Keypair lives in a module variable below, never in React state,
 * never persisted, and is dropped on lock(). Use requireKeypair()/signTransaction()
 * from src/wallet/index.ts to sign.
 */
import { create } from "zustand";
import type { Keypair } from "@stellar/stellar-sdk";
import { Keypair as KP } from "@stellar/stellar-sdk";
import { WALLET } from "@/config";
import { keypairFromWords, isValidSecret, isValidWords, normalizeWords } from "./sep5";
import { deleteVault, loadVault, openVault, saveVault, sealVault, WrongPinError, type SecretKind, type VaultRecord } from "./vault";
import { clearPinGuard, loadPinGuard, pinRetryAt, pinWaitMs, PinLockedError, savePinGuard } from "./pinguard";
import { biometricMissed, biometricSucceeded, notePinEntry, readPinWithBiometric, resetBiometric, wrapPin, type BiometricMiss } from "./biometric";
import type { BiometricPromptText } from "@/native/biometric";

export type WalletStatus = "loading" | "none" | "locked" | "unlocked";

export type BiometricUnlockResult = { ok: true } | BiometricMiss;

interface WalletState {
  status: WalletStatus;
  publicKey: string | null;
  kind: SecretKind | null;
  /** Epoch ms before which no PIN is checked after too many wrong ones (null: no wait). Public, for the countdown. */
  pinRetryAt: number | null;
  /** Load the vault from IndexedDB once at start-up. */
  init: () => Promise<void>;
  /** Save a new wallet from recovery words (created or imported) and unlock it. */
  createFromWords: (words: string, pin: string) => Promise<void>;
  /** Import an existing S... secret and unlock it. */
  importSecret: (secret: string, pin: string) => Promise<void>;
  /** Returns false on a wrong PIN. Throws PinLockedError while a wait is due. */
  unlock: (pin: string) => Promise<boolean>;
  /**
   * Unlock with the phone's biometrics when the rules allow it now (./biometric.ts):
   * shows the system prompt, gets the PIN back and opens the vault with it. It
   * neither counts against nor resets the PIN attempt limit, and does not
   * restart the PIN clock.
   */
  unlockWithBiometric: (text: BiometricPromptText) => Promise<BiometricUnlockResult>;
  /** Check the PIN (counted like any other), then wrap it behind the biometric prompt. Throws WrongPinError, PinLockedError, BiometricError. */
  enableBiometric: (pin: string, text: BiometricPromptText) => Promise<void>;
  lock: () => void;
  /** Decrypt and return the recovery words (or S... secret) for display. Throws WrongPinError or PinLockedError. */
  reveal: (pin: string) => Promise<string>;
  /** Delete the vault from this phone. Irreversible without the recovery words. */
  remove: () => Promise<void>;
}

// In-memory only. Cleared on lock(), remove() and page unload.
let unlocked: Keypair | null = null;

export function currentKeypair(): Keypair | null {
  return unlocked;
}

function keypairFor(record: VaultRecord, secret: string): Keypair {
  const kp = record.kind === "mnemonic" ? keypairFromWords(secret, record.account) : KP.fromSecret(secret);
  if (kp.publicKey() !== record.publicKey) throw new Error("vault public key mismatch");
  return kp;
}

// PIN checks run one at a time, so two quick submits cannot both pass on the old count.
let pinQueue: Promise<unknown> = Promise.resolve();

/**
 * The only way a PIN reaches openVault(): refuses while a wait is due, counts
 * the try in IndexedDB BEFORE checking it (killing the app mid-check does not
 * undo it) and resets the count on the right PIN. See ./pinguard.ts.
 */
function openWithPin(rec: VaultRecord, pin: string): Promise<string> {
  const run = pinQueue.then(async () => {
    const now = Date.now();
    const guard = await loadPinGuard();
    const retryAt = pinRetryAt(guard, now);
    if (retryAt > now) {
      useWallet.setState({ pinRetryAt: retryAt });
      throw new PinLockedError(retryAt);
    }
    const failures = guard.failures + 1;
    const notBefore = now + pinWaitMs(failures);
    await savePinGuard({ failures, notBefore });
    try {
      const secret = await openVault(rec, pin);
      await clearPinGuard();
      await notePinEntry(Date.now()); // restarts the biometric unlock's PIN clock
      useWallet.setState({ pinRetryAt: null });
      return secret;
    } catch (e) {
      if (e instanceof WrongPinError) useWallet.setState({ pinRetryAt: notBefore > now ? notBefore : null });
      throw e;
    }
  });
  pinQueue = run.catch(() => undefined);
  return run;
}

export const useWallet = create<WalletState>()((set, get) => ({
  status: "loading",
  publicKey: null,
  kind: null,
  pinRetryAt: null,

  init: async () => {
    try {
      const rec = await loadVault();
      if (rec) {
        const now = Date.now();
        const retryAt = pinRetryAt(await loadPinGuard(), now);
        set({ status: "locked", publicKey: rec.publicKey, kind: rec.kind, pinRetryAt: retryAt > now ? retryAt : null });
      } else set({ status: "none", publicKey: null, kind: null });
    } catch {
      // IndexedDB unavailable (private mode on some browsers): behave as no wallet.
      set({ status: "none", publicKey: null, kind: null });
    }
  },

  createFromWords: async (words, pin) => {
    const clean = normalizeWords(words);
    if (!isValidWords(clean)) throw new Error("invalid recovery words");
    const kp = keypairFromWords(clean, WALLET.accountIndex);
    const rec = await sealVault({ kind: "mnemonic", secret: clean, publicKey: kp.publicKey(), account: WALLET.accountIndex }, pin);
    await saveVault(rec);
    await clearPinGuard(); // a new PIN starts with no wrong tries
    await resetBiometric(Date.now()); // and with biometrics off
    unlocked = kp;
    set({ status: "unlocked", publicKey: kp.publicKey(), kind: "mnemonic", pinRetryAt: null });
  },

  importSecret: async (secret, pin) => {
    const s = secret.trim();
    if (!isValidSecret(s)) throw new Error("invalid secret key");
    const kp = KP.fromSecret(s);
    const rec = await sealVault({ kind: "secret", secret: s, publicKey: kp.publicKey(), account: 0 }, pin);
    await saveVault(rec);
    await clearPinGuard();
    await resetBiometric(Date.now());
    unlocked = kp;
    set({ status: "unlocked", publicKey: kp.publicKey(), kind: "secret", pinRetryAt: null });
  },

  unlock: async (pin) => {
    const rec = await loadVault();
    if (!rec) {
      set({ status: "none", publicKey: null, kind: null });
      return false;
    }
    try {
      unlocked = keypairFor(rec, await openWithPin(rec, pin));
      set({ status: "unlocked", publicKey: rec.publicKey, kind: rec.kind });
      return true;
    } catch (e) {
      if (e instanceof WrongPinError) return false;
      throw e;
    }
  },

  unlockWithBiometric: async (text) => {
    const rec = await loadVault();
    if (!rec) {
      set({ status: "none", publicKey: null, kind: null });
      return { ok: false, reason: "off", disabled: false };
    }
    const got = await readPinWithBiometric(text);
    if (!got.ok) return got;
    let secret: string;
    try {
      secret = await openVault(rec, got.pin);
    } catch (e) {
      // The wrapped PIN does not open this vault: switch biometrics off.
      if (e instanceof WrongPinError) return biometricMissed("stale");
      throw e;
    }
    unlocked = keypairFor(rec, secret);
    await biometricSucceeded();
    set({ status: "unlocked", publicKey: rec.publicKey, kind: rec.kind });
    return { ok: true };
  },

  enableBiometric: async (pin, text) => {
    const rec = await loadVault();
    if (!rec) throw new Error("no wallet");
    await openWithPin(rec, pin); // proves the PIN before it is wrapped
    await wrapPin(pin, text);
  },

  lock: () => {
    unlocked = null;
    if (get().status === "unlocked") set({ status: "locked" });
  },

  reveal: async (pin) => {
    const rec = await loadVault();
    if (!rec) throw new Error("no wallet");
    return openWithPin(rec, pin);
  },

  remove: async () => {
    await deleteVault();
    await clearPinGuard();
    await resetBiometric(null);
    unlocked = null;
    set({ status: "none", publicKey: null, kind: null, pinRetryAt: null });
  },
}));

if (typeof window !== "undefined") {
  // lock(), not just `unlocked = null`: a page restored from the back-forward
  // cache must show the PIN prompt, not an "unlocked" screen that cannot sign.
  window.addEventListener("pagehide", () => {
    useWallet.getState().lock();
  });
}
