import { describe, expect, it } from "vitest";
import { forgetLastPayment, loadLastPayment, saveLastPayment, type LastPayment } from "./last-payment";

const A = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
const B = "GBC2MDBTM4MX3XJKRX5QM3YXUR2AISCOJGJ74MXLPIZHZDIDHOLFAASA";
const HOST = "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6";
const MEMO = "ERZGCG.FZWQDX93";
const P: LastPayment = { hash: "0c0283ac", n: 1, amount: "1", minutes: 5, at: 1_790_000_000_000, extended: false };

describe("last payment", () => {
  it("outlives the Pay page for the same network, account, host and session", () => {
    saveLastPayment("testnet", A, HOST, MEMO, P);
    // What a remounted PayForm (after the lock screen, or Back from History) reads back.
    expect(loadLastPayment("testnet", A, HOST, MEMO)).toEqual(P);
  });

  it("is not shown for another network, account, host or session", () => {
    saveLastPayment("testnet", A, HOST, MEMO, P);
    expect(loadLastPayment("public", A, HOST, MEMO)).toBeNull();
    expect(loadLastPayment("testnet", B, HOST, MEMO)).toBeNull();
    expect(loadLastPayment("testnet", A, B, MEMO)).toBeNull();
    expect(loadLastPayment("testnet", A, HOST, "ERZGCG.FVZN92QW")).toBeNull();
  });

  it("is forgotten when a station QR is scanned, and replaced by the next payment", () => {
    saveLastPayment("testnet", A, HOST, MEMO, P);
    forgetLastPayment();
    expect(loadLastPayment("testnet", A, HOST, MEMO)).toBeNull();
    saveLastPayment("testnet", A, HOST, MEMO, P);
    saveLastPayment("testnet", A, HOST, "ERZGCG.FVZN92QW", { ...P, hash: "next" });
    expect(loadLastPayment("testnet", A, HOST, MEMO)).toBeNull();
    expect(loadLastPayment("testnet", A, HOST, "ERZGCG.FVZN92QW")?.hash).toBe("next");
  });
});
