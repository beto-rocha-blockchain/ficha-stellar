import { describe, expect, it } from "vitest";
import { loadBuySession, saveBuySession, type BuySession } from "./session";

const A = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
const B = "GBC2MDBTM4MX3XJKRX5QM3YXUR2AISCOJGJ74MXLPIZHZDIDHOLFAASA";
const S: BuySession = { jwt: "jwt", id: "tx-1", url: "https://anchor.example/form", asset: { code: "USDC", issuer: B } };

describe("buy session", () => {
  it("outlives the Buy page for the same network and account", () => {
    saveBuySession("testnet", A, S);
    // What a remounted BuyFlow (after the lock screen) reads back.
    expect(loadBuySession("testnet", A)).toEqual(S);
  });

  it("is not shown to another network or account", () => {
    saveBuySession("testnet", A, S);
    expect(loadBuySession("public", A)).toBeNull();
    expect(loadBuySession("testnet", B)).toBeNull();
  });

  it("is forgotten on cancel or a new start", () => {
    saveBuySession("testnet", A, S);
    saveBuySession("testnet", A, null);
    expect(loadBuySession("testnet", A)).toBeNull();
    saveBuySession("testnet", A, S);
    saveBuySession("public", A, { ...S, id: "tx-2" });
    expect(loadBuySession("testnet", A)).toBeNull();
    expect(loadBuySession("public", A)?.id).toBe("tx-2");
  });
});
