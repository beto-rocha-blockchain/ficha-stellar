import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { checkPin, deleteVault, isTrivialPin, loadVault, openVault, saveVault, sealVault, WrongPinError } from "./vault";

const WORDS = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const PUB = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
const FAST = 1_000; // iterations for tests; the app uses WALLET.pbkdf2Iterations (600k)

describe("vault", () => {
  it("round-trips with the right PIN and never stores plaintext", async () => {
    const rec = await sealVault({ kind: "mnemonic", secret: WORDS, publicKey: PUB, account: 0 }, "482913", FAST);
    expect(JSON.stringify(rec)).not.toContain("illness");
    expect(rec.kdf.iterations).toBe(FAST);
    expect(await openVault(rec, "482913")).toBe(WORDS);
  });

  it("uses 600k PBKDF2 iterations by default", async () => {
    const rec = await sealVault({ kind: "secret", secret: "S".padEnd(56, "A"), publicKey: PUB, account: 0 }, "k7m2p9");
    expect(rec.kdf.iterations).toBe(600_000);
  });

  it("rejects a wrong PIN", async () => {
    const rec = await sealVault({ kind: "mnemonic", secret: WORDS, publicKey: PUB, account: 0 }, "482913", FAST);
    await expect(openVault(rec, "913482")).rejects.toBeInstanceOf(WrongPinError);
  });

  it("rejects a record whose public key was swapped (AAD)", async () => {
    const rec = await sealVault({ kind: "mnemonic", secret: WORDS, publicKey: PUB, account: 0 }, "482913", FAST);
    await expect(openVault({ ...rec, publicKey: "GOTHER" }, "482913")).rejects.toBeInstanceOf(WrongPinError);
  });

  it("uses a fresh salt and IV each time", async () => {
    const a = await sealVault({ kind: "mnemonic", secret: WORDS, publicKey: PUB, account: 0 }, "482913", FAST);
    const b = await sealVault({ kind: "mnemonic", secret: WORDS, publicKey: PUB, account: 0 }, "482913", FAST);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.cipher.data).not.toBe(b.cipher.data);
  });

  it("refuses a short PIN", async () => {
    await expect(sealVault({ kind: "mnemonic", secret: WORDS, publicKey: PUB, account: 0 }, "48291", FAST)).rejects.toThrow();
  });

  it("refuses a new PIN that is one repeated character or a straight run", async () => {
    for (const pin of ["000000", "999999", "123456", "654321", "345678", "abcdef", "1234567890"]) {
      expect(isTrivialPin(pin), pin).toBe(true);
      expect(checkPin(pin), pin).toBe(false);
    }
    for (const pin of ["482913", "112233", "123457", "121212", "k7m2p9"]) expect(checkPin(pin), pin).toBe(true);
    await expect(sealVault({ kind: "mnemonic", secret: WORDS, publicKey: PUB, account: 0 }, "123456", FAST)).rejects.toThrow();
  });

  it("persists in IndexedDB and deletes", async () => {
    const rec = await sealVault({ kind: "mnemonic", secret: WORDS, publicKey: PUB, account: 0 }, "482913", FAST);
    await saveVault(rec);
    expect((await loadVault())?.publicKey).toBe(PUB);
    await deleteVault();
    expect(await loadVault()).toBeNull();
  });
});
