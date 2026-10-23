import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// Loaded before `window` is stubbed, so only store.ts sees the fake window.
import "@stellar/stellar-sdk";
import "./sep5";
import "./vault";

const WORDS = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const PUB = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";

let store: typeof import("./store");
const win = new EventTarget();

beforeAll(async () => {
  // store.ts registers its pagehide listener at import time, only when a window exists.
  vi.stubGlobal("window", win);
  store = await import("./store");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("wallet store", () => {
  it("locks the UI, not only the key, on pagehide (back-forward cache)", async () => {
    const { useWallet, currentKeypair } = store;
    await useWallet.getState().createFromWords(WORDS, "482913");
    expect(useWallet.getState().status).toBe("unlocked");
    expect(currentKeypair()?.publicKey()).toBe(PUB);

    win.dispatchEvent(new Event("pagehide"));

    expect(currentKeypair()).toBeNull();
    // Status must follow the key, or the restored page looks unlocked but cannot sign.
    expect(useWallet.getState().status).toBe("locked");
    expect(useWallet.getState().publicKey).toBe(PUB);
    expect(await useWallet.getState().unlock("482913")).toBe(true);
    expect(currentKeypair()?.publicKey()).toBe(PUB);
  });

  it("removes a locked wallet without the PIN (lock screen: forgot the PIN)", async () => {
    const { useWallet, currentKeypair } = store;
    const { loadVault } = await import("./vault");
    await useWallet.getState().createFromWords(WORDS, "482913");
    useWallet.getState().lock();
    expect(useWallet.getState().status).toBe("locked");

    await useWallet.getState().remove();

    expect(useWallet.getState()).toMatchObject({ status: "none", publicKey: null, kind: null });
    expect(currentKeypair()).toBeNull();
    expect(await loadVault()).toBeNull();
    // The words bring it back.
    await useWallet.getState().createFromWords(WORDS, "735190");
    expect(useWallet.getState().publicKey).toBe(PUB);
  });
});

describe("PIN attempt limit", () => {
  const PIN = "482913";
  let clock = 1_800_000_000_000;

  // A vault sealed with few PBKDF2 iterations, so each wrong try is fast.
  async function lockedWallet() {
    const { useWallet } = store;
    const { saveVault, sealVault } = await import("./vault");
    await useWallet.getState().remove(); // also clears any count left by an earlier test
    await saveVault(await sealVault({ kind: "mnemonic", secret: WORDS, publicKey: PUB, account: 0 }, PIN, 1_000));
    await useWallet.getState().init();
    expect(useWallet.getState()).toMatchObject({ status: "locked", pinRetryAt: null });
  }

  beforeAll(() => {
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    clock += 24 * 3600_000;
  });
  afterAll(() => {
    vi.mocked(Date.now).mockRestore();
  });

  it("makes each try wait after 5 wrong PINs, and a restart does not reset it", async () => {
    const { useWallet, currentKeypair } = store;
    const { PinLockedError, loadPinGuard } = await import("./pinguard");
    await lockedWallet();

    for (let i = 0; i < 4; i++) {
      expect(await useWallet.getState().unlock(`10000${i}`)).toBe(false);
      expect(useWallet.getState().pinRetryAt).toBeNull();
    }
    expect(await useWallet.getState().unlock("100004")).toBe(false);
    expect(useWallet.getState().pinRetryAt).toBe(clock + 30_000);

    // Even the right PIN is refused, without running PBKDF2, until the wait is over.
    await expect(useWallet.getState().unlock(PIN)).rejects.toBeInstanceOf(PinLockedError);
    expect(currentKeypair()).toBeNull();

    // The count lives in IndexedDB: a restarted app still waits.
    expect(await loadPinGuard()).toEqual({ failures: 5, notBefore: clock + 30_000 });
    useWallet.setState({ status: "loading", pinRetryAt: null });
    await useWallet.getState().init();
    expect(useWallet.getState()).toMatchObject({ status: "locked", pinRetryAt: clock + 30_000 });
    clock += 29_000;
    await expect(useWallet.getState().unlock(PIN)).rejects.toBeInstanceOf(PinLockedError);

    // After the wait, one more wrong PIN doubles it; then the right PIN unlocks and resets the count.
    clock += 1_000;
    expect(await useWallet.getState().unlock("100005")).toBe(false);
    expect(useWallet.getState().pinRetryAt).toBe(clock + 60_000);
    clock += 60_000;
    expect(await useWallet.getState().unlock(PIN)).toBe(true);
    expect(currentKeypair()?.publicKey()).toBe(PUB);
    expect(useWallet.getState().pinRetryAt).toBeNull();
    expect(await loadPinGuard()).toEqual({ failures: 0, notBefore: 0 });
  });

  it("counts Show words (reveal) against the same limit", async () => {
    const { useWallet } = store;
    const { WrongPinError } = await import("./vault");
    const { PinLockedError } = await import("./pinguard");
    await lockedWallet();
    expect(await useWallet.getState().unlock(PIN)).toBe(true);

    for (let i = 0; i < 5; i++) await expect(useWallet.getState().reveal(`20000${i}`)).rejects.toBeInstanceOf(WrongPinError);
    await expect(useWallet.getState().reveal(PIN)).rejects.toBeInstanceOf(PinLockedError);
    clock += 30_000;
    expect(await useWallet.getState().reveal(PIN)).toBe(WORDS);
  });

  it("checks PINs one at a time, so a burst of submits cannot skip the count", async () => {
    const { useWallet } = store;
    const { PinLockedError } = await import("./pinguard");
    await lockedWallet();

    const results = await Promise.allSettled(Array.from({ length: 7 }, (_, i) => useWallet.getState().unlock(`30000${i}`)));
    expect(results.slice(0, 5)).toEqual(Array(5).fill({ status: "fulfilled", value: false }));
    for (const r of results.slice(5)) expect(r.status === "rejected" && r.reason instanceof PinLockedError).toBe(true);
  });

  it("caps the wait if the clock went back, and forgets the count when the wallet is removed", async () => {
    const { useWallet } = store;
    const { loadPinGuard, savePinGuard } = await import("./pinguard");
    await lockedWallet();
    // 5 wrong PINs, then the phone's clock goes back a day: still 30 s, not a day and 30 s.
    await savePinGuard({ failures: 5, notBefore: clock + 30_000 });
    clock -= 24 * 3600_000;
    await useWallet.getState().init();
    expect(useWallet.getState().pinRetryAt).toBe(clock + 30_000);

    await useWallet.getState().remove();
    expect(await loadPinGuard()).toEqual({ failures: 0, notBefore: 0 });
    expect(useWallet.getState().pinRetryAt).toBeNull();
  });
});
