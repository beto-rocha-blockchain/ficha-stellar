import { describe, expect, it } from "vitest";
import { deriveEd25519, generateWords, isValidWords, keypairFromWords, normalizeWords, seedFromWords } from "./sep5";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// Official vectors: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md
const VECTORS = [
  {
    name: "Test 1 (12 words)",
    words: "illness spike retreat truth genius clock brain pass fit cave bargain toe",
    passphrase: "",
    seed: "e4a5a632e70943ae7f07659df1332160937fad82587216a4c64315a0fb39497ee4a01f76ddab4cba68147977f3a147b6ad584c41808e8238a07f6cc4b582f186",
    key44_148: "e0eec84fe165cd427cb7bc9b6cfdef0555aa1cb6f9043ff1fe986c3c8ddd22e3",
    accounts: {
      0: ["GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6", "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN"],
      1: ["GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX", "SCEPFFWGAG5P2VX5DHIYK3XEMZYLTYWIPWYEKXFHSK25RVMIUNJ7CTIS"],
      9: ["GBTVYYDIYWGUQUTKX6ZMLGSZGMTESJYJKJWAATGZGITA25ZB6T5REF44", "SCJGVMJ66WAUHQHNLMWDFGY2E72QKSI3XGSBYV6BANDFUFE7VY4XNXXR"],
    },
  },
  {
    name: "Test 3 (24 words)",
    words:
      "bench hurt jump file august wise shallow faculty impulse spring exact slush thunder author capable act festival slice deposit sauce coconut afford frown better",
    passphrase: "",
    seed: "937ae91f6ab6f12461d9936dfc1375ea5312d097f3f1eb6fed6a82fbe38c85824da8704389831482db0433e5f6c6c9700ff1946aa75ad8cc2654d6e40f567866",
    key44_148: "df474e0dc2711089b89af6b089aceeb77e73120e9f895bd330a36fa952835ea8",
    accounts: {
      0: ["GC3MMSXBWHL6CPOAVERSJITX7BH76YU252WGLUOM5CJX3E7UCYZBTPJQ", "SAEWIVK3VLNEJ3WEJRZXQGDAS5NVG2BYSYDFRSH4GKVTS5RXNVED5AX7"],
      1: ["GB3MTYFXPBZBUINVG72XR7AQ6P2I32CYSXWNRKJ2PV5H5C7EAM5YYISO", "SBKSABCPDWXDFSZISAVJ5XKVIEWV4M5O3KBRRLSPY3COQI7ZP423FYB4"],
      9: ["GDXOY6HXPIDT2QD352CH7VWX257PHVFR72COWQ74QE3TEV4PK2KCKZX7", "SCPA5OX4EYINOPAUEQCPY6TJMYICUS5M7TVXYKWXR3G5ZRAJXY3C37GF"],
    },
  },
  {
    name: "Test 4 (24 words + passphrase)",
    words:
      "cable spray genius state float twenty onion head street palace net private method loan turn phrase state blanket interest dry amazing dress blast tube",
    passphrase: "p4ssphr4se",
    seed: "d425d39998fb42ce4cf31425f0eaec2f0a68f47655ea030d6d26e70200d8ff8bd4326b4bdf562ea8640a1501ae93ccd0fd7992116da5dfa24900e570a742a489",
    key44_148: "c83c61dc97d37832f0f20e258c3ba4040a258800fd14abaff124a4dee114b17e",
    accounts: {
      0: ["GDAHPZ2NSYIIHZXM56Y36SBVTV5QKFIZGYMMBHOU53ETUSWTP62B63EQ", "SAFWTGXVS7ELMNCXELFWCFZOPMHUZ5LXNBGUVRCY3FHLFPXK4QPXYP2X"],
      1: ["GDY47CJARRHHL66JH3RJURDYXAMIQ5DMXZLP3TDAUJ6IN2GUOFX4OJOC", "SBQPDFUGLMWJYEYXFRM5TQX3AX2BR47WKI4FDS7EJQUSEUUVY72MZPJF"],
      9: ["GBOSMFQYKWFDHJWCMCZSMGUMWCZOM4KFMXXS64INDHVCJ2A2JAABCYRR", "SDXDYPDNRMGOF25AWYYKPHFAD3M54IT7LCLG7RWTGR3TS32A4HTUXNOS"],
    },
  },
  {
    name: "Test 5 (all-zero entropy)",
    words: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    passphrase: "",
    seed: "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4",
    key44_148: "03df7921b4f789040e361d07d5e4eddad277c376350d7b5d585400a0ef18f2f5",
    accounts: {
      0: ["GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX", "SBUV3MRWKNS6AYKZ6E6MOUVF2OYMON3MIUASWL3JLY5E3ISDJFELYBRZ"],
      1: ["GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV", "SCHDCVCWGAKGIMTORV6K5DYYV3BY4WG3RA4M6MCBGJLHUCWU2MC6DL66"],
      9: ["GAKFARYSPI33KUJE7HYLT47DCX2PFWJ77W3LZMRBPSGPGYPMSDBE7W7X", "SALJ5LPBTXCFML2CQ7ORP7WJNJOZSVBVRQAAODMVHMUF4P4XXFZB7MKY"],
    },
  },
] as const;

describe("SEP-5 derivation (official vectors)", () => {
  for (const v of VECTORS) {
    describe(v.name, () => {
      it("BIP-39 seed", () => {
        expect(hex(seedFromWords(v.words, v.passphrase))).toBe(v.seed);
      });
      it("m/44'/148' key", () => {
        expect(hex(deriveEd25519(seedFromWords(v.words, v.passphrase), [44, 148]))).toBe(v.key44_148);
      });
      for (const [index, [pub, sec]] of Object.entries(v.accounts)) {
        it(`m/44'/148'/${index}'`, () => {
          const kp = keypairFromWords(v.words, Number(index), v.passphrase);
          expect(kp.publicKey()).toBe(pub);
          expect(kp.secret()).toBe(sec);
        });
      }
    });
  }
});

describe("mnemonic helpers", () => {
  it("generates valid 24-word phrases", () => {
    const w = generateWords();
    expect(w.split(" ")).toHaveLength(24);
    expect(isValidWords(w)).toBe(true);
  });
  it("normalizes typing noise", () => {
    expect(normalizeWords("  Illness  SPIKE\nretreat ")).toBe("illness spike retreat");
    expect(isValidWords(" " + VECTORS[0].words.toUpperCase() + " ")).toBe(true);
  });
  it("rejects a bad checksum", () => {
    expect(isValidWords("abandon ".repeat(12).trim())).toBe(false);
  });
});
