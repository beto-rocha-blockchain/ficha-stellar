/**
 * The one-time "use biometrics to unlock?" question, asked right after a PIN
 * unlock (src/components/UnlockForm.tsx) and shown by <BiometricOffer> in the
 * root layout, since the lock screen is gone by then.
 *
 * The PIN just typed waits here, in memory only, until the question is
 * answered; locking the wallet drops it.
 */
import { create } from "zustand";
import { BiometricError, type BiometricErrorCode, type BiometricPromptText } from "@/native/biometric";
import { markBiometricOffered, shouldOfferBiometricNow } from "./biometric";
import { useWallet } from "./store";

let pendingPin: string | null = null;

export const useBiometricOffer = create<{ open: boolean }>(() => ({ open: false }));

function drop(): void {
  pendingPin = null;
  useBiometricOffer.setState({ open: false });
}

/** After a PIN unlock: open the question if it was never answered and this phone can do it. */
export async function offerBiometricAfterPin(pin: string): Promise<void> {
  if (!(await shouldOfferBiometricNow())) return;
  if (useWallet.getState().status !== "unlocked") return;
  pendingPin = pin;
  useBiometricOffer.setState({ open: true });
}

/**
 * Answer the question; the dialog stays open until the PIN is wrapped (or not).
 * Either way it is not asked again (Ajustes has the switch).
 */
export async function answerBiometricOffer(accept: boolean, text: BiometricPromptText): Promise<"enabled" | "declined" | BiometricErrorCode> {
  const pin = pendingPin;
  pendingPin = null;
  try {
    if (!accept || !pin) {
      await markBiometricOffered();
      return "declined";
    }
    try {
      await useWallet.getState().enableBiometric(pin, text);
      return "enabled";
    } catch (e) {
      await markBiometricOffered();
      if (e instanceof BiometricError) return e.code;
      throw e;
    }
  } finally {
    useBiometricOffer.setState({ open: false });
  }
}

useWallet.subscribe((s) => {
  if (s.status !== "unlocked" && (pendingPin !== null || useBiometricOffer.getState().open)) drop();
});
