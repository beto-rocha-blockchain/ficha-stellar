/**
 * The SDK's Soroban side (rpc, contract) in this toolchain: it loads, and it
 * builds, signs and round-trips a contract call offline. Nothing is simulated
 * or sent. The call has the shape of the custody design's deposit(); it is
 * not the contract's binding.
 */
import { describe, expect, it } from "vitest";
import {
  Account,
  BASE_FEE,
  Address,
  Contract,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  contract,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

const RPC_URL = "https://soroban-testnet.stellar.org";
const CONTRACT = StrKey.encodeContract(new Uint8Array(32).fill(7));
const payer = Keypair.random();
const HOST = Keypair.random().publicKey();
const anchor = crypto.getRandomValues(new Uint8Array(32));
const args = { payer: payer.publicKey(), host: HOST, station: "ERZGCG", session: "F3H9TXAB", fichas: 3, anchor };

function depositOp(): xdr.Operation {
  return new Contract(CONTRACT).call(
    "deposit",
    nativeToScVal(args.payer, { type: "address" }),
    nativeToScVal(args.host, { type: "address" }),
    nativeToScVal(args.station, { type: "symbol" }),
    nativeToScVal(args.session, { type: "symbol" }),
    nativeToScVal(args.fichas, { type: "u32" }),
    nativeToScVal(args.anchor),
  );
}

function unsigned(): Transaction {
  return new TransactionBuilder(new Account(payer.publicKey(), "41"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(depositOp())
    .setTimeout(180)
    .build();
}

function invocation(tx: Transaction): xdr.InvokeContractArgs {
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
  return op.func.invokeContract;
}

function expectDeposit(tx: Transaction): void {
  const call = invocation(tx);
  expect(Address.fromScAddress(call.contractAddress).toString()).toBe(CONTRACT);
  expect(call.functionName.toString()).toBe("deposit");
  const [payerArg, host, station, session, fichas, anchorArg] = call.args.map(scValToNative);
  expect([payerArg, host, station, session, fichas]).toEqual([args.payer, args.host, args.station, args.session, args.fichas]);
  expect(new Uint8Array(anchorArg)).toEqual(anchor);
}

/** The deposit() entry of a contract spec (what `stellar contract bindings` reads from the Wasm). */
function depositSpec(): contract.Spec {
  const input = (name: string, type: xdr.ScSpecTypeDef) => new xdr.ScSpecFunctionInputV0({ doc: "", name, type });
  const fn = new xdr.ScSpecFunctionV0({
    doc: "",
    name: "deposit",
    inputs: [
      input("payer", xdr.ScSpecTypeDef.scSpecTypeAddress()),
      input("host", xdr.ScSpecTypeDef.scSpecTypeAddress()),
      input("station", xdr.ScSpecTypeDef.scSpecTypeSymbol()),
      input("session", xdr.ScSpecTypeDef.scSpecTypeSymbol()),
      input("fichas", xdr.ScSpecTypeDef.scSpecTypeU32()),
      input("anchor", xdr.ScSpecTypeDef.scSpecTypeBytesN(new xdr.ScSpecTypeBytesN({ n: 32 }))),
    ],
    outputs: [xdr.ScSpecTypeDef.scSpecTypeU64()],
  });
  return new contract.Spec([xdr.ScSpecEntry.scSpecEntryFunctionV0(fn)]);
}

describe("SDK Soroban side, offline", () => {
  it("builds, signs and round-trips a contract call", () => {
    const tx = unsigned();
    tx.sign(payer);
    const back = TransactionBuilder.fromXdr(tx.toXdr(), Networks.TESTNET) as Transaction;
    expectDeposit(back);
    expect(back.signatures).toHaveLength(1);
    expect(payer.verify(back.hash(), back.signatures[0].signature)).toBe(true);
  });

  it("assembles a simulation answer into the transaction (what rpc.Server.prepareTransaction does)", () => {
    const server = new rpc.Server(RPC_URL);
    expect(server.serverURL.hostname).toBe("soroban-testnet.stellar.org");
    const sim: rpc.Api.RawSimulateTransactionResponse = {
      id: "1",
      latestLedger: 1000,
      minResourceFee: "12345",
      transactionData: new SorobanDataBuilder().setResourceFee(12345n).build().toXdr("base64"),
      results: [{ auth: [], xdr: nativeToScVal(1_700_000_000n, { type: "u64" }).toXdr("base64") }],
    };
    const prepared = rpc.assembleTransaction(unsigned(), sim).build();
    expectDeposit(prepared);
    expect(Number(prepared.fee)).toBe(Number(BASE_FEE) + 12345);
    const env = prepared.toEnvelope();
    if (env.type !== "envelopeTypeTx" || env.v1.tx.ext.type !== "sorobanData") throw new Error("no Soroban data on the transaction");
    expect(env.v1.tx.ext.sorobanData.resourceFee).toBe(12345n);
  });

  it("contract.Client builds the same call from a spec, without simulating", async () => {
    const client = new contract.Client(depositSpec(), { contractId: CONTRACT, networkPassphrase: Networks.TESTNET, rpcUrl: RPC_URL }) as contract.Client & {
      deposit: (a: typeof args, o: { simulate: false }) => Promise<contract.AssembledTransaction<bigint>>;
    };
    const at = await client.deposit(args, { simulate: false });
    // Unsimulated, the call is still a builder (raw); simulate() would fill `built`.
    expect(at.built).toBeUndefined();
    expectDeposit(at.raw!.build());
  });
});
