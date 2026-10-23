/**
 * Public wallet API for the rest of the app.
 *
 *   const pk = useWallet((s) => s.publicKey);      // address, available while locked
 *   const status = useWallet((s) => s.status);     // "none" | "locked" | "unlocked" | "loading"
 *   signTransaction(tx);                           // throws WalletLockedError when locked
 *
 * To make sure the wallet is unlocked before a sensitive step, wrap the UI in
 * <RequireUnlocked> (src/components/RequireUnlocked.tsx): it shows the PIN
 * prompt inline and renders children once unlocked.
 *
 * Keys never leave this module: there is no export that returns a secret
 * except useWallet.reveal(pin), used only by Ajustes → "Ver palavras".
 */
import type { FeeBumpTransaction, Keypair, Transaction } from "@stellar/stellar-sdk";
import { currentKeypair } from "./store";

export { useWallet, type WalletStatus } from "./store";
export { useAutoLock } from "./autolock";
export { usePinWait } from "./pinwait";
export { WrongPinError, checkPin } from "./vault";
export { PinLockedError } from "./pinguard";
export { generateWords, isValidWords, isValidSecret, isBip39Word, normalizeWords } from "./sep5";

export class WalletLockedError extends Error {
  constructor() {
    super("wallet is locked");
    this.name = "WalletLockedError";
  }
}

/** The unlocked keypair. Prefer signTransaction(); never store or send the result. */
export function requireKeypair(): Keypair {
  const kp = currentKeypair();
  if (!kp) throw new WalletLockedError();
  return kp;
}

/** Sign in place with the unlocked key and return the same transaction. */
export function signTransaction<T extends Transaction | FeeBumpTransaction>(tx: T): T {
  tx.sign(requireKeypair());
  return tx;
}
