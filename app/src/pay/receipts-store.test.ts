import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { parseReceipt } from "./receipt";
import { getReceipt, saveReceipt } from "./receipts-store";
import { parseSep7Pay } from "./sep7";

const HOST = "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6";
const RECEIPT_Q = `v=1&m=ERZGCG.F3H9TXAB&n=t&h=${HOST}&a=3&k=XLM&f=3&p=900&u=842&wh=4.250&x=1830&vd=d&c=1&t=1790000000`;
const PAY_URI =
  `web+stellar:pay?destination=${HOST}&amount=1&memo=ERZGCG.F3H9TXAB&memo_type=MEMO_TEXT` +
  `&network_passphrase=Test%20SDF%20Network%20%3B%20September%202015`;

describe("stored receipts", () => {
  it("finds the receipt of the session an old pay QR is for", async () => {
    const receipt = parseReceipt(`ficha:/r?${RECEIPT_Q}`);
    await saveReceipt({ receipt, check: "confirmed", savedAt: 1 });
    // The pay screen looks it up by network + QR destination + QR memo.
    const req = parseSep7Pay(PAY_URI);
    expect((await getReceipt("testnet", req.destination, req.memo))?.receipt).toEqual(receipt);
    expect(await getReceipt("public", req.destination, req.memo)).toBeUndefined();
    expect(await getReceipt("testnet", req.destination, "ERZGCG.FGH72ZEG")).toBeUndefined();
  });

  it("keeps a confirmation when a later scan of the session does not confirm", async () => {
    const receipt = parseReceipt(`ficha:/r?${RECEIPT_Q}`);
    await saveReceipt({ receipt, check: "confirmed", savedAt: 1 });
    // A later payment with the old QR, or a crafted link with another amount.
    await saveReceipt({ receipt: { ...receipt, amount: "4" }, check: "not_confirmed", reason: "amountDiffers", savedAt: 2 });
    expect(await getReceipt("testnet", HOST, receipt.memo)).toMatchObject({ check: "confirmed", savedAt: 1, receipt: { amount: "3" } });
  });

  it("never replaces a confirmed custody receipt with one that gives back less (made from public data)", async () => {
    const z = "jd7P0m8htvt8yndyQED9mMMwOtc69b8EIoT3Cr3qUZs";
    const v2 = (q: number) => parseReceipt(`v=2&m=ERZGCG.F7777777&n=t&h=${HOST}&a=2&k=XLM&f=2&p=600&u=400&wh=1.234&x=1500&vd=d&c=1&t=1790000000&q=${q}&z=${z}`);
    await saveReceipt({ receipt: v2(7), check: "confirmed", savedAt: 1 });
    await saveReceipt({ receipt: v2(6), check: "confirmed", savedAt: 2 });
    await saveReceipt({ receipt: v2(0), check: "not_confirmed", reason: "zeroProof", savedAt: 3 });
    expect((await getReceipt("testnet", HOST, "ERZGCG.F7777777"))?.receipt.refund?.units).toBe(7);
    // A larger refund (the station's real receipt after a forged smaller one) does replace it.
    await saveReceipt({ receipt: v2(9), check: "confirmed", savedAt: 4 });
    expect((await getReceipt("testnet", HOST, "ERZGCG.F7777777"))?.receipt.refund?.units).toBe(9);
  });
});
