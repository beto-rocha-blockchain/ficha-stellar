import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, Horizon } from "@stellar/stellar-sdk";
import { NETWORKS } from "@/config";
import { tr } from "@/i18n";
import { describeStellarError } from "./errors";
import { balanceOf, summarize } from "./horizon";
import { MAX_FEE_STROOPS, SubmitError, buildPaymentTx, feeBid, paymentFunds } from "./tx";

const net = NETWORKS.testnet;
const ME = "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6";
const XLM = { code: "XLM", issuer: null };

/** An account with `xlm` XLM and a USDC trustline holding `usdc` (3 entries of reserve = 1.5 XLM). */
function summary(xlm: string, usdc: string, usdcSelling = "0") {
  const account = {
    subentry_count: 1,
    balances: [
      { asset_type: "native", balance: xlm, selling_liabilities: "0.0000000", buying_liabilities: "0.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: net.usdc.issuer,
        balance: usdc,
        limit: "922337203685.4775807",
        selling_liabilities: usdcSelling,
        buying_liabilities: "0.0000000",
      },
    ],
  } as unknown as Horizon.AccountResponse;
  return summarize(net, ME, account);
}

describe("payment funds", () => {
  it("an issued-asset payment still needs XLM above the reserve for the fee", () => {
    const atReserve = summary("1.5000000", "20.0000000");
    expect(atReserve.spendableXlm).toBe("0");
    expect(paymentFunds(atReserve, net.usdc, "0.5")).toMatchObject({ balance: "20", coversAmount: true, feeShort: true, enough: false });
    expect(paymentFunds(summary("1.5010000", "20.0000000"), net.usdc, "0.5")).toMatchObject({ feeShort: false, enough: true });
  });

  it("an XLM payment needs the amount plus the fee", () => {
    const s = summary("3.5000000", "0.0000000"); // 2 XLM spendable
    expect(paymentFunds(s, XLM, "1.999")).toMatchObject({ coversAmount: true, feeShort: false, enough: true });
    expect(paymentFunds(s, XLM, "2")).toMatchObject({ coversAmount: false, feeShort: false, enough: false });
  });

  it("does not count what open offers hold", () => {
    expect(balanceOf(summary("5", "20.0000000", "15.0000000"), net.usdc)).toBe("5");
    expect(paymentFunds(summary("5", "20.0000000", "15.0000000"), net.usdc, "6").coversAmount).toBe(false);
  });

  it("names the fee when the ledger answers tx_insufficient_balance", () => {
    const e = new SubmitError("rejected", { transaction: "tx_insufficient_balance" });
    expect(describeStellarError(e)).toBe(tr("stellar.err.feeReserve"));
    expect(describeStellarError(e)).not.toBe(tr("stellar.err.underfunded"));
  });
});

describe("fee bid", () => {
  const dist = (v: string) => ({ max: v, min: v, mode: v, p10: v, p20: v, p30: v, p40: v, p50: v, p60: v, p70: v, p80: v, p90: v, p95: v, p99: v });
  const stats = (over: Partial<Horizon.HorizonApi.FeeStatsResponse> = {}): Horizon.HorizonApi.FeeStatsResponse => ({
    last_ledger: "1",
    last_ledger_base_fee: "100",
    ledger_capacity_usage: "0.5",
    fee_charged: dist("100"),
    max_fee: dist("100"),
    ...over,
  });
  // Ledgers full, transactions getting in at 4,000-9,000 stroops, base fee still 100.
  const SURGE = stats({
    ledger_capacity_usage: "1.00",
    fee_charged: { ...dist("5000"), min: "4000", p10: "4000", p70: "6000", p80: "7000", p90: "8000", p95: "8500", p99: "9000", max: "9000" },
    max_fee: { ...dist("5000"), p90: "8000", p99: "10000", max: "10000" },
  });

  afterEach(() => vi.restoreAllMocks());

  it("bids what ledgers charge under surge pricing, not the 100-stroop base fee", () => {
    expect(feeBid(stats())).toBe(100);
    expect(feeBid(SURGE)).toBe(8000);
    // Nearly full ledgers: at least what most senders bid.
    expect(feeBid(stats({ ledger_capacity_usage: "0.95", max_fee: dist("3000") }))).toBe(3000);
    expect(feeBid(stats({ ledger_capacity_usage: "0.5", max_fee: dist("3000") }))).toBe(100);
  });

  it("never bids below the base fee or above MAX_FEE_STROOPS", () => {
    expect(feeBid(stats({ fee_charged: dist("5000000") }))).toBe(MAX_FEE_STROOPS);
    expect(feeBid(stats({ ledger_capacity_usage: "1", max_fee: dist("1e12") }))).toBe(MAX_FEE_STROOPS);
    expect(feeBid(stats({ fee_charged: dist("junk"), last_ledger_base_fee: "" }))).toBe(100);
    expect(feeBid(stats({ last_ledger_base_fee: "200" }))).toBe(200);
  });

  it("puts the surge bid on the payment, and the base fee when fee stats fail", async () => {
    vi.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (id: string) => new Account(id, "1000") as never);
    const fees = vi.spyOn(Horizon.Server.prototype, "feeStats").mockResolvedValue(SURGE);
    const params = { net, source: ME, destination: net.usdc.issuer, asset: XLM, amount: "1", memo: "ERZGCG.F3H9TXAB" };
    expect((await buildPaymentTx(params)).fee).toBe("8000");
    fees.mockRejectedValue(new Error("offline"));
    expect((await buildPaymentTx(params)).fee).toBe("100");
  });
});
