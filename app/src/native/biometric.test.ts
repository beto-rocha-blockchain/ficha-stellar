import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { biometricSupport, BiometricError, createBiometricKey, hasNativeBiometric, openBiometricKey } from "./biometric";

describe("native biometrics on the web", () => {
  it("has no plugin: no support and no prompt", async () => {
    expect(hasNativeBiometric()).toBe(false);
    expect(await biometricSupport()).toBeNull();
    const text = { title: "t", cancel: "c" };
    await expect(createBiometricKey(text)).rejects.toEqual(new BiometricError("unavailable"));
    await expect(openBiometricKey({ ciphertext: "x", iv: "y" }, text)).rejects.toBeInstanceOf(BiometricError);
  });
});

// The protection is only as good as the key the plugin makes, and only works
// if the plugin is registered under the name JS calls.
describe("biometric plugin wiring", () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
  const java = "../../android/app/src/main/java/app/ficha/wallet/";
  const plugin = read(`${java}biometric/FichaBiometricPlugin.kt`);

  it("is registered and depends on androidx.biometric", () => {
    expect(read(`${java}MainActivity.java`)).toMatch(/registerPlugin\(FichaBiometricPlugin\.class\)/);
    expect(plugin).toMatch(/@CapacitorPlugin\(name = "FichaBiometric"\)/);
    expect(read("../../android/app/build.gradle")).toMatch(/androidx\.biometric:biometric:/);
  });

  it("uses a Keystore key that needs a strong biometric for every use and dies with a new enrollment", () => {
    expect(plugin).toMatch(/KEY_ALIAS = "ficha_biometric_v1"/);
    expect(plugin).toMatch(/"AES\/GCM\/NoPadding"/);
    expect(plugin).toMatch(/setKeySize\(256\)/);
    expect(plugin).toMatch(/setUserAuthenticationRequired\(true\)/);
    expect(plugin).toMatch(/setUserAuthenticationParameters\(0, KeyProperties\.AUTH_BIOMETRIC_STRONG\)/);
    expect(plugin).toMatch(/setInvalidatedByBiometricEnrollment\(true\)/);
    expect(plugin).toMatch(/setAllowedAuthenticators\(BIOMETRIC_STRONG\)/);
    expect(plugin).toMatch(/BiometricPrompt\.CryptoObject\(cipher\)/);
  });

  it("makes the unlock key itself and never logs a key or a ciphertext", () => {
    // Capacitor logs call arguments (debug builds), so the plugin takes no secret in.
    expect(plugin).not.toMatch(/getString\("(secret|key|pin)"\)/);
    expect(plugin).toMatch(/SecureRandom\(\)\.nextBytes/);
    for (const line of plugin.split("\n").filter((l) => /Log\.[diwev]\(/.test(l))) {
      expect(line).not.toMatch(/secret|unlockKey|plain|data\b|ciphertext|\biv\b/i);
    }
  });
});
