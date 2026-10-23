import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for the Android plugin: it makes a random unlock key, "wraps" it
// in base64, and plays back whatever outcome the test queues for the next prompt.
const native = vi.hoisted(() => {
  const state = {
    on: true,
    strong: true,
    /** Outcome of the next prompts, in order; empty = the owner passes. */
    outcomes: [] as string[],
  };
  const next = () => {
    const o = state.outcomes.shift();
    if (o) throw Object.assign(new Error(o), { code: o });
  };
  const plugin = {
    isAvailable: async () => ({ available: state.strong, strong: state.strong, reason: state.strong ? "ok" : "none_enrolled" }),
    enable: vi.fn(async (_o: object) => {
      next();
      const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
      return { key, ciphertext: btoa(key), iv: "aXY=" };
    }),
    unlock: vi.fn(async (o: { ciphertext: string }) => {
      next();
      return { key: atob(o.ciphertext) };
    }),
    disable: vi.fn(async () => {}),
  };
  return { state, plugin };
});

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native.state.on, isPluginAvailable: (n: string) => native.state.on && n === "FichaBiometric" },
  registerPlugin: () => native.plugin,
}));

import {
  afterBiometricError,
  afterPinEntry,
  biometricGate,
  currentBiometricGate,
  loadBiometricMeta,
  loadBiometricRecord,
  MAX_BIOMETRIC_FAILURES,
  NO_META,
  pinDue,
  PIN_EVERY_MS,
  shouldOfferBiometric,
  shouldOfferBiometricNow,
  type BiometricState,
} from "./biometric";
import { answerBiometricOffer, offerBiometricAfterPin, useBiometricOffer } from "./biometric-offer";
import { currentKeypair, useWallet } from "./store";
import { saveVault, sealVault, WrongPinError } from "./vault";

const T0 = 1_800_000_000_000;
const REC = { ciphertext: "x", iv: "y", pin: { iv: "a", data: "b" }, enabledAt: T0 };
const on = (meta = afterPinEntry(NO_META, T0)): BiometricState => ({ supported: true, record: REC, meta });

describe("biometric rules", () => {
  it("asks for the PIN a week after it was last typed, or when none is recorded", () => {
    expect(PIN_EVERY_MS).toBe(7 * 24 * 3600_000);
    expect(pinDue(null, T0)).toBe(true);
    expect(pinDue(T0, T0)).toBe(false);
    expect(pinDue(T0, T0 + PIN_EVERY_MS - 1)).toBe(false);
    expect(pinDue(T0, T0 + PIN_EVERY_MS)).toBe(true);
    // A clock set back before the last PIN does not stretch the window.
    expect(pinDue(T0, T0 - 1)).toBe(true);
  });

  it("opens the prompt only when on, supported, not due and not paused", () => {
    expect(biometricGate(on(), T0 + 1000)).toBe("ready");
    expect(biometricGate({ ...on(), supported: false }, T0)).toBe("unsupported"); // web, or nothing enrolled
    expect(biometricGate({ ...on(), record: null }, T0)).toBe("off");
    expect(biometricGate(on(), T0 + PIN_EVERY_MS)).toBe("pin-due");
    expect(biometricGate(on({ ...afterPinEntry(NO_META, T0), failures: MAX_BIOMETRIC_FAILURES }), T0)).toBe("paused");
  });

  it("counts cancels and failures in a row, a lockout at once, and not what the system did", () => {
    let meta = afterPinEntry(NO_META, T0);
    for (let i = 1; i <= MAX_BIOMETRIC_FAILURES; i++) {
      meta = afterBiometricError(meta, i % 2 ? "cancelled" : "failed").meta;
      expect(meta.failures).toBe(i);
    }
    expect(biometricGate(on(meta), T0)).toBe("paused");
    // A PIN typed right clears them.
    expect(afterPinEntry(meta, T0 + 5).failures).toBe(0);

    expect(afterBiometricError(NO_META, "lockout").meta.failures).toBe(MAX_BIOMETRIC_FAILURES);
    for (const code of ["interrupted", "busy", "unavailable"] as const) {
      expect(afterBiometricError(NO_META, code)).toEqual({ meta: NO_META, disable: false });
    }
  });

  it("switches off when the key was invalidated or the PIN it gave back is stale", () => {
    expect(afterBiometricError(NO_META, "invalidated").disable).toBe(true);
    expect(afterBiometricError(NO_META, "stale").disable).toBe(true);
    expect(afterBiometricError(NO_META, "cancelled").disable).toBe(false);
  });

  it("offers once, only where it can work, only while off", () => {
    const off: BiometricState = { supported: true, record: null, meta: NO_META };
    expect(shouldOfferBiometric(off)).toBe(true);
    expect(shouldOfferBiometric({ ...off, meta: { ...NO_META, offered: true } })).toBe(false);
    expect(shouldOfferBiometric({ ...off, record: REC })).toBe(false);
    expect(shouldOfferBiometric({ ...off, supported: false })).toBe(false);
  });
});

describe("biometric unlock in the wallet", () => {
  const WORDS = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
  const PUB = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
  const PIN = "482913";
  const TEXT = { title: "Unlock", cancel: "Use PIN" };
  let clock = T0;

  const unlockBio = () => useWallet.getState().unlockWithBiometric(TEXT);

  /** A locked wallet (few PBKDF2 iterations) with biometrics on, the PIN typed at `clock`. */
  async function walletWithBiometrics() {
    await useWallet.getState().remove();
    await saveVault(await sealVault({ kind: "mnemonic", secret: WORDS, publicKey: PUB, account: 0 }, PIN, 1_000));
    await useWallet.getState().init();
    expect(await useWallet.getState().unlock(PIN)).toBe(true);
    await useWallet.getState().enableBiometric(PIN, TEXT);
    useWallet.getState().lock();
    expect(await currentBiometricGate()).toBe("ready");
  }

  beforeAll(() => {
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });
  afterAll(() => {
    vi.mocked(Date.now).mockRestore();
  });
  beforeEach(() => {
    clock += 30 * 24 * 3600_000;
    native.state.on = true;
    native.state.strong = true;
    native.state.outcomes = [];
    vi.clearAllMocks();
  });

  it("offers once after a PIN unlock, then opens with the PIN behind the biometrics", async () => {
    await useWallet.getState().remove();
    await saveVault(await sealVault({ kind: "mnemonic", secret: WORDS, publicKey: PUB, account: 0 }, PIN, 1_000));
    await useWallet.getState().init();
    expect(await useWallet.getState().unlock(PIN)).toBe(true);
    expect((await loadBiometricMeta()).lastPinAt).toBe(clock);

    await offerBiometricAfterPin(PIN);
    expect(useBiometricOffer.getState().open).toBe(true);
    expect(await answerBiometricOffer(true, TEXT)).toBe("enabled");
    expect(useBiometricOffer.getState().open).toBe(false);
    expect(native.plugin.enable).toHaveBeenCalledOnce();
    expect(await loadBiometricRecord()).toMatchObject({ enabledAt: clock });
    expect(await shouldOfferBiometricNow()).toBe(false);

    useWallet.getState().lock();
    expect(await unlockBio()).toEqual({ ok: true });
    expect(useWallet.getState().status).toBe("unlocked");
    expect(currentKeypair()?.publicKey()).toBe(PUB);

    // Capacitor logs call arguments in debug builds: the PIN is never one.
    const sent = JSON.stringify([native.plugin.enable.mock.calls, native.plugin.unlock.mock.calls]);
    expect(sent).not.toContain(PIN);
    expect(JSON.stringify(await loadBiometricRecord())).not.toContain(PIN);
  });

  it("asks for the PIN again a week after it was typed; a biometric unlock does not restart the clock", async () => {
    await walletWithBiometrics();
    const typedAt = clock;
    clock += PIN_EVERY_MS - 60_000;
    expect(await unlockBio()).toEqual({ ok: true });
    expect((await loadBiometricMeta()).lastPinAt).toBe(typedAt);

    useWallet.getState().lock();
    clock += 60_000;
    native.plugin.unlock.mockClear();
    expect(await unlockBio()).toEqual({ ok: false, reason: "pin-due", disabled: false });
    expect(native.plugin.unlock).not.toHaveBeenCalled();
    expect(useWallet.getState().status).toBe("locked");

    // The PIN restarts the clock.
    expect(await useWallet.getState().unlock(PIN)).toBe(true);
    useWallet.getState().lock();
    expect(await currentBiometricGate()).toBe("ready");
  });

  it("wants the PIN after 3 tries in a row that did not unlock, at once after a lockout", async () => {
    await walletWithBiometrics();
    native.state.outcomes = ["cancelled", "cancelled"];
    expect(await unlockBio()).toMatchObject({ ok: false, reason: "cancelled" });
    expect(await unlockBio()).toMatchObject({ ok: false, reason: "cancelled" });
    // The system closing the prompt (app sent to the background) does not count.
    native.state.outcomes = ["interrupted"];
    expect(await unlockBio()).toMatchObject({ ok: false, reason: "interrupted" });
    expect(await currentBiometricGate()).toBe("ready");
    native.state.outcomes = ["failed"];
    expect(await unlockBio()).toMatchObject({ ok: false, reason: "failed" });
    expect(await currentBiometricGate()).toBe("paused");
    native.plugin.unlock.mockClear();
    expect(await unlockBio()).toMatchObject({ ok: false, reason: "paused" });
    expect(native.plugin.unlock).not.toHaveBeenCalled();

    expect(await useWallet.getState().unlock(PIN)).toBe(true);
    useWallet.getState().lock();
    native.state.outcomes = ["lockout"];
    expect(await unlockBio()).toMatchObject({ ok: false, reason: "lockout" });
    expect(await currentBiometricGate()).toBe("paused");
  });

  it("switches biometrics off when a new fingerprint invalidated the key", async () => {
    await walletWithBiometrics();
    native.state.outcomes = ["invalidated"];
    expect(await unlockBio()).toEqual({ ok: false, reason: "invalidated", disabled: true });
    expect(await loadBiometricRecord()).toBeNull();
    expect(native.plugin.disable).toHaveBeenCalled();
    expect(await currentBiometricGate()).toBe("off");
    // Not offered again: Ajustes has the switch.
    expect(await shouldOfferBiometricNow()).toBe(false);
  });

  it("switches biometrics off when the PIN it gives back no longer opens the vault", async () => {
    await walletWithBiometrics();
    await saveVault(await sealVault({ kind: "mnemonic", secret: WORDS, publicKey: PUB, account: 0 }, "735190", 1_000));
    expect(await unlockBio()).toEqual({ ok: false, reason: "stale", disabled: true });
    expect(useWallet.getState().status).toBe("locked");
    expect(await loadBiometricRecord()).toBeNull();
  });

  it("checks the PIN before turning biometrics on", async () => {
    await walletWithBiometrics();
    await useWallet.getState().remove();
    await saveVault(await sealVault({ kind: "mnemonic", secret: WORDS, publicKey: PUB, account: 0 }, PIN, 1_000));
    await useWallet.getState().init();
    native.plugin.enable.mockClear();
    await expect(useWallet.getState().enableBiometric("111333", TEXT)).rejects.toBeInstanceOf(WrongPinError);
    expect(native.plugin.enable).not.toHaveBeenCalled();
    expect(await loadBiometricRecord()).toBeNull();
  });

  it("forgets biometrics when the wallet is removed or a new one is created", async () => {
    await walletWithBiometrics();
    await useWallet.getState().remove();
    expect(await loadBiometricRecord()).toBeNull();
    expect(await loadBiometricMeta()).toEqual(NO_META);
    expect(native.plugin.disable).toHaveBeenCalled();

    await useWallet.getState().createFromWords(WORDS, PIN);
    expect(await loadBiometricMeta()).toEqual({ lastPinAt: clock, failures: 0, offered: false });
    expect(await loadBiometricRecord()).toBeNull();
    useWallet.getState().lock();
    expect(await unlockBio()).toMatchObject({ ok: false, reason: "off" });
  });

  it("is hidden on the web: no offer, no prompt", async () => {
    await walletWithBiometrics();
    native.state.on = false;
    expect(await currentBiometricGate()).toBe("unsupported");
    expect(await unlockBio()).toMatchObject({ ok: false, reason: "unsupported" });
    expect(await useWallet.getState().unlock(PIN)).toBe(true);
    await useWallet.getState().remove();
    await saveVault(await sealVault({ kind: "mnemonic", secret: WORDS, publicKey: PUB, account: 0 }, PIN, 1_000));
    await useWallet.getState().init();
    expect(await useWallet.getState().unlock(PIN)).toBe(true);
    await offerBiometricAfterPin(PIN);
    expect(useBiometricOffer.getState().open).toBe(false);
  });
});
