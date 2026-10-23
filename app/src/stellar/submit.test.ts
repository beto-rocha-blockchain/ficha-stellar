import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, Asset, Horizon, Operation, TransactionBuilder, TransactionFailedError } from "@stellar/stellar-sdk";
import { NETWORKS } from "@/config";
import { SubmitError, submitTx } from "./tx";

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
