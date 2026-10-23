/**
 * The phone's biometrics as the Android app offers them (native plugin
 * FichaBiometric, android/app/src/main/java/app/ficha/wallet/biometric/FichaBiometricPlugin.kt).
 *
 * The plugin makes a random unlock key and keeps it wrapped by an Android
 * Keystore key that only a strong biometric check can use, one operation per
 * check; src/wallet/biometric.ts seals the PIN with the unlock key and decides
 * when biometrics may be used.
 *
 * Secrets only travel native -> JS: Capacitor logs the arguments of every call
 * to native (verbose, debug builds), so never pass a PIN or key as an argument.
 *
 * On the web (PWA, browser, tests) there is no plugin: biometricSupport()
 * resolves to null and the feature is hidden.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

export interface BiometricSupport {
  /** Some biometric (weak or strong) is enrolled and usable. */
  available: boolean;
  /** A strong (class 3) biometric is enrolled and usable: the only kind the app accepts. */
  strong: boolean;
  /** Why strong biometrics are not usable ("ok" when they are): none_enrolled, no_hardware, hw_unavailable, ... */
  reason: string;
}

/** Text on the system prompt. `cancel` is its only button. */
export interface BiometricPromptText {
  title: string;
  subtitle?: string;
  cancel: string;
}

/** The unlock key wrapped by the Keystore key, base64. Useless without it and the owner's biometrics. */
export interface WrappedKey {
  ciphertext: string;
  iv: string;
}

export type BiometricErrorCode = "cancelled" | "interrupted" | "lockout" | "invalidated" | "unavailable" | "busy" | "failed";

const CODES: readonly BiometricErrorCode[] = ["cancelled", "interrupted", "lockout", "invalidated", "unavailable", "busy", "failed"];

export class BiometricError extends Error {
  readonly code: BiometricErrorCode;
  constructor(code: BiometricErrorCode) {
    super(`biometric: ${code}`);
    this.name = "BiometricError";
    this.code = code;
  }
}

interface FichaBiometricPlugin {
  isAvailable(): Promise<BiometricSupport>;
  enable(options: BiometricPromptText): Promise<WrappedKey & { key: string }>;
  unlock(options: WrappedKey & BiometricPromptText): Promise<{ key: string }>;
  disable(): Promise<void>;
}

const FichaBiometric = registerPlugin<FichaBiometricPlugin>("FichaBiometric");

/** True inside the Android app, where the native plugin is registered. */
export function hasNativeBiometric(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("FichaBiometric");
}

/** The plugin's rejection as a BiometricError. */
function toBiometricError(e: unknown): BiometricError {
  const code = (e as { code?: unknown } | null)?.code;
  return new BiometricError(CODES.includes(code as BiometricErrorCode) ? (code as BiometricErrorCode) : "failed");
}

/** What the phone offers, or null on the web or if the plugin fails. */
export async function biometricSupport(): Promise<BiometricSupport | null> {
  if (!hasNativeBiometric()) return null;
  try {
    return await FichaBiometric.isAvailable();
  } catch {
    return null;
  }
}

/**
 * Show the prompt, replace the Keystore key and return a new random unlock key
 * (base64, 32 bytes) with its wrapped form to store. Throws BiometricError.
 */
export async function createBiometricKey(text: BiometricPromptText): Promise<{ key: string; wrapped: WrappedKey }> {
  if (!hasNativeBiometric()) throw new BiometricError("unavailable");
  try {
    const r = await FichaBiometric.enable({ ...text });
    return { key: r.key, wrapped: { ciphertext: r.ciphertext, iv: r.iv } };
  } catch (e) {
    throw toBiometricError(e);
  }
}

/** Show the prompt and return the unlock key (base64). Throws BiometricError. */
export async function openBiometricKey(wrapped: WrappedKey, text: BiometricPromptText): Promise<string> {
  if (!hasNativeBiometric()) throw new BiometricError("unavailable");
  try {
    return (await FichaBiometric.unlock({ ciphertext: wrapped.ciphertext, iv: wrapped.iv, ...text })).key;
  } catch (e) {
    throw toBiometricError(e);
  }
}

/** Delete the Keystore key (no prompt). Does nothing on the web. */
export async function deleteBiometricKey(): Promise<void> {
  if (!hasNativeBiometric()) return;
  try {
    await FichaBiometric.disable();
  } catch {
    // Nothing to undo: without the key the stored ciphertext is useless anyway.
  }
}
