import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, Asset, Horizon, NotFoundError, Operation, TransactionBuilder, TransactionFailedError } from "@stellar/stellar-sdk";
import { NETWORKS } from "@/config";
import { SubmitError, awaitTxOutcome, submitTx } from "./tx";

const net = NETWORKS.testnet;
const ME = "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6";

describe("submitTx", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads Horizon's result codes and names the transaction by its hex hash", async () => {
    // The error the SDK raises when Horizon answers 400 with result codes.
    const rejected = new TransactionFailedError("Transaction submission failed", {
      status: 400,
      statusText: "Bad Request",
      data: { extras: { result_codes: { transaction: "tx_failed", operations: ["op_underfunded"] } } },
    });
    vi.spyOn(Horizon.Server.prototype, "submitTransaction").mockRejectedValue(rejected);
    const tx = new TransactionBuilder(new Account(ME, "1000"), { fee: "100", networkPassphrase: net.passphrase })
      .addOperation(Operation.payment({ destination: net.usdc.issuer, asset: Asset.native(), amount: "1" }))
      .setTimeout(180)
      .build();

    const err = await submitTx(net, tx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmitError);
    expect(err).toMatchObject({ kind: "rejected", resultCodes: { transaction: "tx_failed", operations: ["op_underfunded"] } });
    // The hash is what the app polls Horizon with and shows: hex, never "1,2,3,...".
    expect((err as SubmitError).hash).toBe(Buffer.from(tx.hash()).toString("hex"));
    expect((err as SubmitError).hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("awaitTxOutcome", () => {
  afterEach(() => vi.restoreAllMocks());

  const HASH = "ab".repeat(32);
  const now = () => Math.floor(Date.now() / 1000);
  /** Horizon: the newest ledger closes at each of `closes` (unix s) in turn, the last one after that; the transaction answers `tx` in turn. */
  function horizon(closes: number[], tx: (() => unknown)[]) {
    const ledgerCall = vi.fn(async () => ({ records: [{ closed_at: new Date(1000 * (closes.length > 1 ? closes.shift()! : closes[0])).toISOString() }] }));
    const txCall = vi.fn(async () => (tx.length > 1 ? tx.shift()! : tx[0])());
    vi.spyOn(Horizon.Server.prototype, "ledgers").mockReturnValue({ order: () => ({ limit: () => ({ call: ledgerCall }) }) } as never);
    vi.spyOn(Horizon.Server.prototype, "transactions").mockReturnValue({ transaction: () => ({ call: txCall }) } as never);
    return { ledgerCall, txCall };
  }
  const missing = () => {
    throw new NotFoundError("Not Found", { status: 404 });
  };
  const offline = () => {
    throw new TypeError("Failed to fetch");
  };

  it("keeps polling while a ledger can still apply it, and returns it once it lands", async () => {
    const maxTime = now() + 180;
    const h = horizon([maxTime - 100, maxTime - 50, maxTime], [missing, missing, missing, () => ({ successful: true, ledger_attr: 61 })]);
    expect(await awaitTxOutcome(net, HASH, maxTime, 0)).toEqual({ hash: HASH, ledger: 61 });
    expect(h.txCall).toHaveBeenCalledTimes(4);
  });

  it("says it expired only once a ledger closed after its time bound without it", async () => {
    const maxTime = now() + 180;
    // A ledger closing AT maxTime may still apply it (closeTime <= maxTime).
    const h = horizon([maxTime - 10, maxTime, maxTime + 5], [missing]);
    const err = await awaitTxOutcome(net, HASH, maxTime, 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmitError);
    expect(err).toMatchObject({ kind: "rejected", resultCodes: { transaction: "tx_too_late" }, hash: HASH });
    expect(h.txCall).toHaveBeenCalledTimes(3);
  });

  it("never calls it expired on an answer that is not a 404, or with no ledger read", async () => {
    const maxTime = now() + 180;
    // Past maxTime, but the transaction read fails: no answer is not "not found".
    const h = horizon([maxTime + 5], [offline, offline, missing]);
    await expect(awaitTxOutcome(net, HASH, maxTime, 0)).rejects.toMatchObject({ kind: "rejected", resultCodes: { transaction: "tx_too_late" } });
    expect(h.txCall).toHaveBeenCalledTimes(3);
    // The ledger read fails: a 404 proves nothing yet.
    vi.restoreAllMocks();
    const txCall = vi.fn(async () => missing());
    let ledgers = 0;
    vi.spyOn(Horizon.Server.prototype, "ledgers").mockReturnValue({
      order: () => ({ limit: () => ({ call: async () => (++ledgers < 3 ? offline() : { records: [{ closed_at: new Date(1000 * (maxTime + 5)).toISOString() }] }) }) }),
    } as never);
    vi.spyOn(Horizon.Server.prototype, "transactions").mockReturnValue({ transaction: () => ({ call: txCall }) } as never);
    await expect(awaitTxOutcome(net, HASH, maxTime, 0)).rejects.toMatchObject({ resultCodes: { transaction: "tx_too_late" } });
    expect(txCall).toHaveBeenCalledTimes(3);
  });

  it("reports a failed transaction as rejected, and gives up as unknown only long past its time bound", async () => {
    horizon([now()], [() => ({ successful: false, ledger_attr: 61 })]);
    await expect(awaitTxOutcome(net, HASH, now() + 180, 0)).rejects.toMatchObject({ kind: "rejected", resultCodes: undefined });
    // Horizon silent until 300 s after maxTime: still unknown, never "expired".
    const h = horizon([now()], [offline]);
    await expect(awaitTxOutcome(net, HASH, now() - 301, 0)).rejects.toMatchObject({ kind: "unknown", hash: HASH });
    expect(h.txCall).not.toHaveBeenCalled();
    // No time bound: it could land any time.
    await expect(awaitTxOutcome(net, HASH, 0, 0)).rejects.toMatchObject({ kind: "unknown" });
  });
});
