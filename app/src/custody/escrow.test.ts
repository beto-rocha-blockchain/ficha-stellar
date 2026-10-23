/**
 * FichaEscrow calls offline: argument encoding, reads, the authorization a
 * simulation asks for, error mapping, sending and events. The RPC answers
 * are real ones from testnet (testnet-fixtures.json: read-only simulations
 * and reads, nothing signed or sent there), replayed through a fake server.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, Address, Keypair, Networks, SorobanDataBuilder, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import { NETWORKS } from "@/config";
import type { CustodyStation } from "@/registry/verify";
import { toB64url } from "./chain";
import { checkChain, checkRegistry, custodyAssetOk, planDeposit, termsMismatches } from "./check";
import { registryState } from "./host";
import { EscrowError, classifyFailure } from "./errors";
import {
  assetContract,
  buildCallTx,
  checkAuth,
  claimArgs,
  claimAuth,
  cursorLedger,
  depositArgs,
  depositAuth,
  depositTerms,
  fetchEscrowEvents,
  parseEscrowEvent,
  prepareCall,
  readEscrow,
  sendAndWait,
  type EscrowSession,
  type Rpc,
  type StationTerms,
} from "./escrow";
import { parsePayLink } from "./link";
import { prepareClaim, prepareDeposit, sendDeposit, type DepositRequest } from "./pay";

const NET = NETWORKS.testnet;
const C = NET.custody!;
const ESCROW = C.escrowContract;
const HOST = "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6";
const UNFUNDED = "GAKINFFB6NVQONE3MA4BZ5X3EEDG6KYNG2WCL2NLJSFP2AAXI5GX6VIP";
const ANCHOR = hexToBytes("4c6f4ecc2381dc2428f35a50614d04919f2fb039310ada7a104316954a002b7b");

interface RawSimError {
  error: string;
  events: string[];
  latestLedger: number;
}
interface Fixtures {
  bad_fichas: RawSimError;
  account_missing: RawSimError;
  no_session: RawSimError;
  terms_changed: RawSimError;
  deposit_ok: { tx: string; sim: rpc.Api.RawSimulateTransactionResponse };
  ledger_entries: rpc.Api.RawGetLedgerEntriesResponse;
  events: rpc.Api.RawGetEventsResponse;
}
const F = JSON.parse(readFileSync(fileURLToPath(new URL("./testnet-fixtures.json", import.meta.url)), "utf8")) as Fixtures;

const simError = (f: RawSimError) => rpc.parseRawSimulation({ id: "1", ...f }) as rpc.Api.SimulateTransactionErrorResponse;
const diag = (f: RawSimError) => f.events.map((e) => xdr.DiagnosticEvent.fromXdr(e, "base64"));

/** ERZGCG as a custody entry of the registry, with the terms it has on the contract. */
const ERZGCG: CustodyStation = {
  id: "ERZGCG",
  name: "Demo bench (testnet)",
  host_key: HOST,
  asset: { code: "XLM", issuer: null },
  ficha_price: "1",
  ficha_minutes: 5,
  max_session_minutes: 60,
  active: true,
  mode: "custody",
  escrow: ESCROW,
  unit_seconds: 30,
  grace_seconds: 1680,
};

const TERMS: StationTerms = { token: C.xlmSac, price: 10_000_000n, fichaSecs: 300, maxFichas: 12, unitSecs: 30, graceSecs: 1680, active: true };
/** ERZGCG's terms as a deposit signs them. */
const DT = depositTerms(TERMS);

function fakeRpc(over: Partial<Record<keyof Rpc, unknown>> = {}): Rpc {
  return {
    getAccount: vi.fn(async (a: string) => new Account(a, "41")),
    getFeeStats: vi.fn(async () => ({ sorobanInclusionFee: { p90: "100" } })),
    getHealth: vi.fn(async () => ({ status: "healthy", latestLedger: 25_000, oldestLedger: 1_000, ledgerRetentionWindow: 120_960 })),
    ...over,
  } as unknown as Rpc;
}

function invocation(tx: Transaction) {
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
  return op.func.invokeContract;
}

describe("call building", () => {
  const dep = { payer: UNFUNDED, host: HOST, station: "ERZGCG", session: "F3H9TXAB", fichas: 3, anchor: ANCHOR, terms: DT };

  it("encodes deposit and claim as the contract's spec says (contract §7.1, Arguments)", () => {
    const tx = buildCallTx(new Account(UNFUNDED, "41"), Networks.TESTNET, ESCROW, "deposit", depositArgs(dep));
    const call = invocation(tx);
    expect(Address.fromScAddress(call.contractAddress).toString()).toBe(ESCROW);
    expect(call.functionName.toString()).toBe("deposit");
    expect(call.args.map((a) => a.type)).toEqual(["scvAddress", "scvAddress", "scvSymbol", "scvSymbol", "scvU32", "scvBytes", "scvMap"]);
    const [payer, host, station, session, fichas, anchor, terms] = call.args.map(scValToNative);
    expect([payer, host, station, session, fichas]).toEqual([UNFUNDED, HOST, "ERZGCG", "F3H9TXAB", 3]);
    expect(new Uint8Array(anchor)).toEqual(ANCHOR);
    // The terms the payer signs: Terms, a map in key order (StationCfg's fields but active).
    const tv = call.args[6];
    if (tv.type !== "scvMap") throw new Error("terms: not a map");
    expect((tv.map ?? []).map((e) => scValToNative(e.key))).toEqual(["ficha_secs", "grace_secs", "max_fichas", "price", "token", "unit_secs"]);
    expect(terms).toEqual({ ficha_secs: 300, grace_secs: 1680n, max_fichas: 12, price: 10_000_000n, token: C.xlmSac, unit_secs: 30 });
    // Signed calls are short-lived: they are signed right after the simulation.
    expect(Number(tx.timeBounds!.maxTime) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);

    const claim = claimArgs({ host: HOST, station: "ERZGCG", session: "F3H9TXAB", anchor: ANCHOR, units: 7, proof: ANCHOR });
    expect(claim.map((a) => a.type)).toEqual(["scvAddress", "scvSymbol", "scvSymbol", "scvBytes", "scvU32", "scvBytes"]);
    expect(() => depositArgs({ ...dep, anchor: new Uint8Array(31) })).toThrow();
  });

  it("checks that a simulation authorizes exactly the deposit and its transfer of fichas x price (contract §7.4 step 6)", () => {
    const sim = rpc.parseRawSimulation(F.deposit_ok.sim) as rpc.Api.SimulateTransactionSuccessResponse;
    const auth = sim.result!.auth;
    // The fixture: the demo host paying 2 fichas into session F2222222 with the vectors' anchor, under ERZGCG's terms.
    const args = { payer: HOST, host: HOST, station: "ERZGCG", session: "F2222222", fichas: 2, anchor: ANCHOR, terms: DT };
    expect(() => checkAuth(auth, depositAuth(ESCROW, C.xlmSac, args, 20_000_000n))).not.toThrow();
    const bad = (want: Parameters<typeof checkAuth>[1]) => {
      try {
        checkAuth(auth, want);
      } catch (e) {
        return (e as EscrowError).code;
      }
      return "ok";
    };
    expect(bad(depositAuth(ESCROW, C.xlmSac, args, 30_000_000n))).toBe("bad_auth"); // another amount
    expect(bad(depositAuth(ESCROW, C.xlmSac, { ...args, fichas: 3 }, 20_000_000n))).toBe("bad_auth");
    // The signature covers the terms too: other terms are another authorization.
    expect(bad(depositAuth(ESCROW, C.xlmSac, { ...args, terms: { ...DT, unitSecs: 15 } }, 20_000_000n))).toBe("bad_auth");
    expect(bad(depositAuth(ESCROW, assetContract({ code: "USDC", issuer: NET.usdc.issuer }, NET), args, 20_000_000n))).toBe("bad_auth");
    expect(bad(null)).toBe("bad_auth");
    expect(() => checkAuth([...auth, ...auth], depositAuth(ESCROW, C.xlmSac, args, 20_000_000n))).toThrow(EscrowError);
    // Signed by an address other than the transaction's source: refused too.
    const addressCred = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({ address: new Address(HOST).toScAddress(), nonce: 1n, signatureExpirationLedger: 1, signature: xdr.ScVal.scvVoid() }),
      ),
      rootInvocation: auth[0].rootInvocation,
    });
    expect(() => checkAuth([addressCred], depositAuth(ESCROW, C.xlmSac, args, 20_000_000n))).toThrow(EscrowError);
    // A claim authorizes the claim alone.
    const c = { host: HOST, station: "ERZGCG", session: "F2222222", anchor: ANCHOR, units: 7, proof: ANCHOR };
    const claimEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({ contractAddress: new Address(ESCROW).toScAddress(), functionName: "claim", args: claimArgs(c) }),
        ),
        subInvocations: [],
      }),
    });
    expect(() => checkAuth([claimEntry], claimAuth(ESCROW, c))).not.toThrow();
    expect(() => checkAuth([claimEntry], claimAuth(ESCROW, { ...c, units: 8 }))).toThrow(EscrowError);
    expect(() => checkAuth([claimEntry], claimAuth(ESCROW, { ...c, anchor: new Uint8Array(32) }))).toThrow(EscrowError);
  });
});

describe("errors (contract §7.1, Errors)", () => {
  it("names the escrow's own errors by number", () => {
    expect(classifyFailure(F.bad_fichas.error, diag(F.bad_fichas), ESCROW).code).toBe("BadFichas");
    expect(classifyFailure(F.no_session.error, diag(F.no_session), ESCROW).code).toBe("NoSession");
    // Terms the payer signed that are no longer the station's (#12).
    expect(F.terms_changed.error).toContain("Error(Contract, #12)");
    expect(classifyFailure(F.terms_changed.error, diag(F.terms_changed), ESCROW).code).toBe("TermsChanged");
  });

  it("names the SAC's #14 (an XLM payment too small to create a missing account) as no account", () => {
    // The fixture's SAC error event (#6, a missing payer), its code rewritten to 14.
    const events = diag(F.account_missing);
    const i = events.findIndex((d) => classifyFailure(undefined, [d], ESCROW).code === "no_account");
    const bytes = Uint8Array.from(Buffer.from(events[i].toXdr("base64"), "base64"));
    const err6 = [0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 6]; // SCV_ERROR, SCE_CONTRACT, code 6
    const at = bytes.findIndex((_, k) => err6.every((b, j) => bytes[k + j] === b));
    expect(at).toBeGreaterThan(0);
    bytes[at + 11] = 14;
    const ev14 = xdr.DiagnosticEvent.fromXdr(Buffer.from(bytes).toString("base64"), "base64");
    expect(classifyFailure(undefined, [ev14], ESCROW)).toMatchObject({ code: "no_account", detail: `${C.xlmSac} #14` });
  });

  it("tells the asset contract's #6 (no account) from the escrow's #6 (OtherPayer)", () => {
    // The RPC's text says Error(Contract, #6) for both; the events say who raised it.
    expect(F.account_missing.error).toContain("Error(Contract, #6)");
    const e = classifyFailure(F.account_missing.error, diag(F.account_missing), ESCROW);
    expect(e.code).toBe("no_account");
    expect(e.detail).toContain(C.xlmSac);
  });

  it("never guesses the contract from a bare number", () => {
    expect(classifyFailure("HostError: Error(Contract, #6)", [], ESCROW)).toMatchObject({ code: "contract", detail: "#6" });
    expect(classifyFailure("HostError: Error(Auth, InvalidAction)", [], ESCROW).code).toBe("auth");
  });
});

describe("reads", () => {
  it("reads the code, ERZGCG's terms and no session in one call, and they match the registry entry", async () => {
    const getLedgerEntries = vi.fn(async (...keys: xdr.LedgerKey[]) => {
      expect(keys).toHaveLength(3);
      return {
        latestLedger: F.ledger_entries.latestLedger,
        entries: (F.ledger_entries.entries ?? []).map((e) => ({
          key: xdr.LedgerKey.fromXdr(e.key, "base64"),
          val: xdr.LedgerEntryData.fromXdr(e.xdr, "base64"),
          liveUntilLedgerSeq: e.liveUntilLedgerSeq,
        })),
      };
    });
    const view = await readEscrow(fakeRpc({ getLedgerEntries }), ESCROW, HOST, "ERZGCG", { session: "F2222222", anchor: ANCHOR });
    expect(view.wasmHash).toBe(C.escrowWasm[0]);
    expect(view.station).toEqual(TERMS);
    expect(view.session).toBeNull();
    expect(view.archived).toBe(false);
    expect(checkChain(ERZGCG, view, NET)).toEqual({ state: "ok", terms: TERMS });
    // Another code, a station not registered, or terms that differ: refused.
    expect(checkChain(ERZGCG, { ...view, wasmHash: "00".repeat(32) }, NET).state).toBe("unknown_code");
    expect(checkChain(ERZGCG, { ...view, station: null }, NET).state).toBe("not_registered");
    expect(checkChain({ ...ERZGCG, ficha_price: "2" }, view, NET)).toEqual({ state: "terms_differ", fields: ["price"] });
    expect(checkChain(ERZGCG, { ...view, station: { ...TERMS, active: false } }, NET).state).toBe("inactive");
  });

  it("compares every term with the registry: token, price, ficha, max, unit and grace", () => {
    expect(termsMismatches(ERZGCG, TERMS, NET)).toEqual([]);
    const other = { ...TERMS, token: assetContract({ code: "USDC", issuer: NET.usdc.issuer }, NET), price: 1n, fichaSecs: 60, maxFichas: 11, unitSecs: 15, graceSecs: 300 };
    expect(termsMismatches(ERZGCG, other, NET)).toEqual(["token", "price", "ficha_secs", "max_fichas", "unit_secs", "grace_secs"]);
  });

  it("checks the link against the registry: network, station, host and custody mode", () => {
    const link = parsePayLink(`ficha:/p?v=1&n=t&h=${HOST}&s=ERZGCG&x=F3H9TXAB&a=TG9OzCOB3CQo81pQYU0EkZ8vsDkxCtp6EEMWlUoAK3s`);
    const reg = { format: "ficha-registry/1" as const, issued_at: "2026-10-01T00:00:00Z", network: "testnet" as const, stations: [ERZGCG] };
    expect(checkRegistry(link, reg, NET)).toEqual({ state: "ok", station: ERZGCG });
    expect(checkRegistry({ ...link, network: "public" }, reg, NET).state).toBe("wrong_network");
    expect(checkRegistry(link, reg, NETWORKS.public).state).toBe("wrong_network");
    expect(checkRegistry({ ...link, network: "public" }, reg, NETWORKS.public).state).toBe("no_custody");
    expect(checkRegistry(link, null, NET).state).toBe("no_registry");
    expect(checkRegistry({ ...link, stationId: "K7M2QX" }, reg, NET).state).toBe("unknown_station");
    expect(checkRegistry({ ...link, hostKey: UNFUNDED }, reg, NET).state).toBe("mismatch");
    const direct = { ...ERZGCG, mode: "direct" } as unknown as CustodyStation;
    expect(checkRegistry(link, { ...reg, stations: [direct] }, NET).state).toBe("not_custody");
    expect(checkRegistry(link, { ...reg, stations: [{ ...ERZGCG, active: false }] }, NET).state).toBe("inactive");
  });

  it("plans a new session, a top-up of this wallet's own, or refuses (contract §7.4 step 4)", () => {
    const link = { anchor: ANCHOR };
    const open: EscrowSession = {
      payer: UNFUNDED, token: C.xlmSac, price: 5_000_000n, fichaSecs: 300, unitSecs: 30, maxFichas: 12, graceSecs: 1680,
      chainLen: 120, anchor: ANCHOR, fichas: 4, amount: 20_000_000n, opened: 1000, deadline: 1000 + 1200 + 1680,
    };
    expect(planDeposit(null, UNFUNDED, link, TERMS, 0)).toEqual({ kind: "new", max: 12, price: 10_000_000n });
    // A top-up keeps the session's frozen price, up to what it may still hold.
    expect(planDeposit(open, UNFUNDED, link, TERMS, 2000)).toMatchObject({ kind: "topup", max: 8, price: 5_000_000n });
    expect(planDeposit(open, HOST, link, TERMS, 2000).kind).toBe("taken");
    expect(planDeposit(open, UNFUNDED, { anchor: new Uint8Array(32) }, TERMS, 2000).kind).toBe("taken");
    // The contract takes a top-up until the deadline, but the station ends the session 900 s before it.
    expect(planDeposit(open, UNFUNDED, link, TERMS, open.deadline - 931).kind).toBe("topup");
    expect(planDeposit(open, UNFUNDED, link, TERMS, open.deadline).kind).toBe("ended");
    expect(planDeposit(open, UNFUNDED, link, TERMS, open.deadline + 1).kind).toBe("expired");
    expect(planDeposit({ ...open, fichas: 12 }, UNFUNDED, link, TERMS, 2000).kind).toBe("full");
  });
});

describe("prepare and send", () => {
  const link = parsePayLink(`ficha:/p?v=1&n=t&h=${HOST}&s=ERZGCG&x=F2222222&a=TG9OzCOB3CQo81pQYU0EkZ8vsDkxCtp6EEMWlUoAK3s`);
  const req = (payer: string): DepositRequest => ({ escrow: ESCROW, token: C.xlmSac, asset: { code: "XLM", issuer: null }, payer, link, fichas: 2, terms: TERMS });

  it("assembles a simulated deposit, ready to sign, with its real fee", async () => {
    const simulateTransaction = vi.fn(async () => rpc.parseRawSimulation(F.deposit_ok.sim));
    const p = await prepareDeposit(fakeRpc({ simulateTransaction }), NET, req(HOST));
    expect(simulateTransaction).toHaveBeenCalledOnce();
    expect(p.amount).toBe(20_000_000n);
    expect(p.fee).toBe(100n + BigInt(F.deposit_ok.sim.minResourceFee!));
    const env = p.tx.toEnvelope();
    if (env.type !== "envelopeTypeTx" || env.v1.tx.ext.type !== "sorobanData") throw new Error("no Soroban data");
    expect(invocation(p.tx).functionName.toString()).toBe("deposit");
    expect(p.tx.signatures).toHaveLength(0);
  });

  it("refuses before signing when the simulation fails, and says why", async () => {
    const sign = vi.fn((tx: Transaction) => tx);
    const failWith = (f: RawSimError) => fakeRpc({ simulateTransaction: vi.fn(async () => simError(f)) });
    const attempt = async (server: Rpc) => {
      try {
        const p = await prepareDeposit(server, NET, req(UNFUNDED));
        await sendDeposit(server, NET, req(UNFUNDED), p, sign);
      } catch (e) {
        return (e as EscrowError).code;
      }
      return "ok";
    };
    expect(await attempt(failWith(F.bad_fichas))).toBe("BadFichas");
    expect(await attempt(failWith(F.account_missing))).toBe("no_account");
    expect(await attempt(fakeRpc({ getAccount: vi.fn(async () => Promise.reject(new Error(`Account not found: ${UNFUNDED}`))) }))).toBe("not_funded");
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses a simulation whose fee is out of bounds", async () => {
    const data = new SorobanDataBuilder(F.deposit_ok.sim.transactionData!).setResourceFee(9_000_000n).build().toXdr("base64");
    const raw = { ...F.deposit_ok.sim, minResourceFee: "9000000", transactionData: data };
    const server = fakeRpc({ simulateTransaction: vi.fn(async () => rpc.parseRawSimulation(raw)) });
    await expect(prepareDeposit(server, NET, req(HOST))).rejects.toMatchObject({ code: "fee_too_high" });
  });

  it("maps a claim the contract refuses (NoSession) before signing", async () => {
    const server = fakeRpc({ simulateTransaction: vi.fn(async () => simError(F.no_session)) });
    const record = {
      network: "testnet" as const, escrow: ESCROW, payer: UNFUNDED, hostKey: HOST, stationId: "ERZGCG", session: "F3H9TXAB", anchor: toB64url(ANCHOR),
      asset: { code: "XLM", issuer: null }, token: C.xlmSac, terms: { price: "10000000", fichaSecs: 300, unitSecs: 30, maxFichas: 12, graceSecs: 1680, chainLen: 120 },
      fichas: 1, amount: "10000000", deadline: 0, txHashes: [], createdAt: 0,
    };
    await expect(prepareClaim(server, NET, record, { units: 1, proof: ANCHOR })).rejects.toMatchObject({ code: "NoSession" });
  });

  function signedTx(): Transaction {
    const kp = Keypair.random();
    const tx = buildCallTx(
      new Account(kp.publicKey(), "1"),
      Networks.TESTNET,
      ESCROW,
      "deposit",
      depositArgs({ payer: kp.publicKey(), host: HOST, station: "ERZGCG", session: "F3H9TXAB", fichas: 1, anchor: ANCHOR, terms: DT }),
    );
    tx.sign(kp);
    return tx;
  }
  const ok = (v: xdr.ScVal) => ({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 77, createdAt: 1_790_000_000, returnValue: v });
  const notFound = { status: rpc.Api.GetTransactionStatus.NOT_FOUND };

  it("follows a sent call to its result, and reads the return value", async () => {
    const tx = signedTx();
    const getTransaction = vi.fn().mockResolvedValueOnce(notFound).mockResolvedValueOnce(ok(nativeToScVal(1_790_002_280n, { type: "u64" })));
    const server = fakeRpc({ sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: "h" })), getTransaction });
    const sent = await sendAndWait(server, tx, ESCROW, { pollMs: 0 });
    expect(sent.ledger).toBe(77);
    expect(scValToNative(sent.returnValue!)).toBe(1_790_002_280n);
    expect(getTransaction).toHaveBeenCalledTimes(2);
  });

  it("never sends twice: no answer to the send, then the poll finds it", async () => {
    const tx = signedTx();
    const sendTransaction = vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")));
    const server = fakeRpc({ sendTransaction, getTransaction: vi.fn().mockResolvedValue(ok(nativeToScVal(5n, { type: "i128" }))) });
    await sendAndWait(server, tx, ESCROW, { pollMs: 0 });
    expect(sendTransaction).toHaveBeenCalledOnce();
  });

  it("says what failed in the ledger, too late, or unknown", async () => {
    const tx = signedTx();
    const maxTime = Number(tx.timeBounds!.maxTime);
    const failed = { status: rpc.Api.GetTransactionStatus.FAILED, diagnosticEventsXdr: diag(F.bad_fichas), resultXdr: { result: { type: "txFailed" } } };
    const pending = vi.fn(async () => ({ status: "PENDING", hash: "h" }));
    await expect(sendAndWait(fakeRpc({ sendTransaction: pending, getTransaction: vi.fn().mockResolvedValue(failed) }), tx, ESCROW, { pollMs: 0 })).rejects.toMatchObject({
      code: "BadFichas",
    });
    // Its time bounds passed and the RPC never saw it: nothing happened.
    let clock = maxTime * 1000;
    const now = () => (clock += 20_000);
    await expect(sendAndWait(fakeRpc({ sendTransaction: pending, getTransaction: vi.fn().mockResolvedValue(notFound) }), tx, ESCROW, { pollMs: 0, now })).rejects.toMatchObject({
      code: "too_late",
    });
    clock = maxTime * 1000;
    const down = vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(sendAndWait(fakeRpc({ sendTransaction: down, getTransaction: down }), tx, ESCROW, { pollMs: 0, now })).rejects.toMatchObject({ code: "unknown_outcome" });
    // Refused at the door: nothing to follow.
    const refused = vi.fn(async () => ({ status: "ERROR", hash: "h", errorResult: { result: { type: "txBadSeq" } } }));
    await expect(sendAndWait(fakeRpc({ sendTransaction: refused }), tx, ESCROW, { pollMs: 0 })).rejects.toMatchObject({ code: "rejected", detail: "txBadSeq" });
  });

  it("builds through prepareCall for any function (the host's calls reuse it)", async () => {
    const simulateTransaction = vi.fn(async () => rpc.parseRawSimulation({ ...F.deposit_ok.sim, results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXdr("base64") }] }));
    const p = await prepareCall(fakeRpc({ simulateTransaction }), Networks.TESTNET, { source: HOST, escrow: ESCROW, fn: "release", args: [], auth: null });
    expect(invocation(p.tx).functionName.toString()).toBe("release");
    expect(p.result?.type).toBe("scvVoid");
  });
});

describe("events (contract §7.2)", () => {
  it("reads the deposit and settle events of a session (the e2e run's TESTE2)", () => {
    const res = rpc.parseRawEvents(F.events);
    const events = res.events.map(parseEscrowEvent);
    expect(events.every((e) => e !== null)).toBe(true);
    const first = events[0]!;
    expect(first).toMatchObject({ kind: "deposit", station: "TESTE2", session: "F2E2E2EA", fichas: 2, amount: 2_000_000n, totalFichas: 2, totalAmount: 2_000_000n, deadline: 1_790_918_542 });
    if (first.kind !== "deposit") throw new Error();
    expect(first.anchor).toHaveLength(32);
    expect(first.payer).toMatch(/^G/);
    // The session's terms, as the contract froze them and the payer signed them.
    expect(first.terms).toEqual({ token: C.xlmSac, price: 1_000_000n, fichaSecs: 60, maxFichas: 4, unitSecs: 15, graceSecs: 300 });
    const settles = events.filter((e) => e?.kind === "settle");
    expect(settles.map((s) => s && s.kind === "settle" && [s.session, s.how, s.toPayer, s.toHost, s.unusedUnits])).toEqual([
      ["F2E2E2EA", "proof", 750_000n, 1_250_000n, 3],
      ["F2E2E2EC", "host", 1_000_000n, 0n, 4],
      // D: another payer's session under the same ID, with its own anchor, then the payer's own.
      ["F2E2E2ED", "proof", 1_000_000n, 0n, 4],
      ["F2E2E2ED", "proof", 500_000n, 500_000n, 2],
      ["F2E2E2EB", "deadline", 0n, 1_000_000n, 0],
    ]);
    // Every settle names its session's anchor: the two under F2E2E2ED are two sessions.
    const anchors = settles.map((s) => s && s.kind === "settle" && toB64url(s.anchor));
    expect(anchors[2]).not.toBe(anchors[3]);
    expect(anchors[3]).toBe(toB64url(first.anchor));
    const d = events.filter((e) => e?.kind === "deposit" && e.session === "F2E2E2ED");
    expect(d.map((e) => e && e.kind === "deposit" && [e.totalFichas, toB64url(e.anchor) === toB64url(first.anchor)])).toEqual([
      [1, false],
      [1, true],
    ]);
  });

  it("pages by cursor from the oldest ledger the RPC keeps to the latest", async () => {
    const raw = F.events;
    const cursorAt = (ledger: number) => `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-4294967295`;
    expect(cursorLedger(cursorAt(4_959_510))).toBe(4_959_510);
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce(rpc.parseRawEvents({ ...raw, events: [], cursor: cursorAt(11_000), latestLedger: 25_000 }))
      .mockResolvedValueOnce(rpc.parseRawEvents({ ...raw, cursor: cursorAt(21_000), latestLedger: 25_000 }))
      .mockResolvedValueOnce(rpc.parseRawEvents({ ...raw, events: [], cursor: cursorAt(25_000), latestLedger: 25_000 }));
    const scan = await fetchEscrowEvents(fakeRpc({ getEvents }), ESCROW, [{ host: "GCNWWWORIDEQALZKQL57SSOGUBGXC6PPAIZDFNEJV4FCDRSGLNDFQYFT", station: "TESTE2" }]);
    expect(scan.complete).toBe(true);
    expect(scan.events).toHaveLength(10);
    expect(getEvents.mock.calls[0][0]).toMatchObject({ startLedger: 1_000, limit: 100 });
    expect(getEvents.mock.calls[1][0]).toMatchObject({ cursor: cursorAt(11_000) });
    expect(getEvents.mock.calls[0][0].filters[0].topics).toHaveLength(2);
  });
});

describe("a simulation for another payer", () => {
  it("is refused before signing: the authorization must name this wallet's transfer", async () => {
    const kp = Keypair.random();
    // The fixture's authorization names the demo host as payer.
    const server = fakeRpc({ simulateTransaction: vi.fn(async () => rpc.parseRawSimulation(F.deposit_ok.sim)) });
    const link = parsePayLink(`ficha:/p?v=1&n=t&h=${HOST}&s=ERZGCG&x=F2222222&a=TG9OzCOB3CQo81pQYU0EkZ8vsDkxCtp6EEMWlUoAK3s`);
    const req: DepositRequest = { escrow: ESCROW, token: C.xlmSac, asset: { code: "XLM", issuer: null }, payer: kp.publicKey(), link, fichas: 2, terms: TERMS };
    await expect(prepareDeposit(server, NET, req)).rejects.toMatchObject({ code: "bad_auth" });
    // The fixture's own transaction is the deposit it simulated.
    expect(invocation(TransactionBuilder.fromXdr(F.deposit_ok.tx, Networks.TESTNET) as Transaction).functionName.toString()).toBe("deposit");
  });
});

describe("time bounds by the ledger's clock, not the phone's (review R2A2)", () => {
  const LEDGER = 1_790_916_077;
  const sim = () => vi.fn(async () => rpc.parseRawSimulation({ ...F.deposit_ok.sim, results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXdr("base64") }] }));

  it("sets maxTime from the ledger's close time, so a phone two minutes slow can still send", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime((LEDGER - 120) * 1000);
      const server = fakeRpc({ simulateTransaction: sim(), getLatestLedger: vi.fn(async () => ({ id: "x", sequence: 1, protocolVersion: "23", closeTime: String(LEDGER) })) });
      const p = await prepareCall(server, Networks.TESTNET, { source: HOST, escrow: ESCROW, fn: "release", args: [], auth: null });
      expect(Number(p.tx.timeBounds!.maxTime)).toBe(LEDGER + 60);
      expect(Number(p.tx.timeBounds!.minTime)).toBe(0);
      // No ledger time from the RPC: the phone's clock, as before.
      const blind = await prepareCall(fakeRpc({ simulateTransaction: sim() }), Networks.TESTNET, { source: HOST, escrow: ESCROW, fn: "release", args: [], auth: null });
      expect(Number(blind.tx.timeBounds!.maxTime)).toBe(LEDGER - 120 + 60);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says too_late (nothing happened) for txTooLate, not a bare 'rejected'", async () => {
    const kp = Keypair.random();
    const tx = buildCallTx(new Account(kp.publicKey(), "1"), Networks.TESTNET, ESCROW, "release", [], undefined, LEDGER);
    tx.sign(kp);
    const late = vi.fn(async () => ({ status: "ERROR", hash: "h", latestLedger: 1, latestLedgerCloseTime: LEDGER + 61, errorResult: { result: { type: "txTooLate" } } }));
    await expect(sendAndWait(fakeRpc({ sendTransaction: late }), tx, ESCROW, { pollMs: 0 })).rejects.toMatchObject({ code: "too_late", detail: "txTooLate" });
  });

  it("follows a sent call on the ledger's clock: a phone five minutes fast still waits for it", async () => {
    const kp = Keypair.random();
    const tx = buildCallTx(new Account(kp.publicKey(), "1"), Networks.TESTNET, ESCROW, "release", [], undefined, LEDGER);
    tx.sign(kp);
    // The phone's clock is 5 min ahead of the ledger, and 2 s pass per poll.
    let phone = (LEDGER + 300) * 1000;
    const now = () => (phone += 2000);
    const missing = { status: rpc.Api.GetTransactionStatus.NOT_FOUND, latestLedger: 1, latestLedgerCloseTime: LEDGER + 5 };
    const done = { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 78, createdAt: LEDGER + 10, returnValue: xdr.ScVal.scvVoid(), latestLedgerCloseTime: LEDGER + 10 };
    const getTransaction = vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce(missing).mockResolvedValueOnce(done);
    const sendTransaction = vi.fn(async () => ({ status: "PENDING", hash: "h", latestLedger: 1, latestLedgerCloseTime: LEDGER }));
    const sent = await sendAndWait(fakeRpc({ sendTransaction, getTransaction }), tx, ESCROW, { pollMs: 0, now });
    expect(sent.ledger).toBe(78);
    // Not found while the ledger is past maxTime + 30: too late, by the ledger's clock (the phone's says nothing).
    const gone = vi.fn().mockResolvedValue({ ...missing, latestLedgerCloseTime: LEDGER + 95 });
    phone = (LEDGER - 600) * 1000;
    await expect(sendAndWait(fakeRpc({ sendTransaction, getTransaction: gone }), tx, ESCROW, { pollMs: 0, now })).rejects.toMatchObject({ code: "too_late" });
    expect(gone).toHaveBeenCalledOnce();
  });
});

describe("custody in XLM only, for now (review R2C2)", () => {
  it("refuses a custody station whose asset has an issuer: the issuer could freeze the payer's refund or claw back the contract's balance", () => {
    const link = parsePayLink(`ficha:/p?v=1&n=t&h=${HOST}&s=ERZGCG&x=F3H9TXAB&a=TG9OzCOB3CQo81pQYU0EkZ8vsDkxCtp6EEMWlUoAK3s`);
    const reg = (s: CustodyStation) => ({ format: "ficha-registry/1" as const, issued_at: "2026-10-01T00:00:00Z", network: "testnet" as const, stations: [s] });
    expect(custodyAssetOk(ERZGCG)).toBe(true);
    // The host's own asset, or the testnet USDC: refused before any contract read.
    for (const issuer of [HOST, NET.usdc.issuer]) {
      const credit: CustodyStation = { ...ERZGCG, asset: { code: "FCH", issuer } };
      expect(custodyAssetOk(credit)).toBe(false);
      expect(checkRegistry(link, reg(credit), NET)).toEqual({ state: "custody_asset", stationId: "ERZGCG" });
    }
    const page = readFileSync(fileURLToPath(new URL("../routes/p.tsx", import.meta.url)), "utf8");
    expect(page).toContain('custody_asset: t("p.notXlm", { id: link.stationId }),');
    // Host mode says so too, and offers USDC only to edit a station already registered in it.
    const form = readFileSync(fileURLToPath(new URL("../routes/host/station.tsx", import.meta.url)), "utf8");
    expect(form).toContain('(draft.asset === "USDC" ? (["XLM", "USDC"] as const) : (["XLM"] as const))');
    expect(registryState({ ...ERZGCG, asset: { code: "USDC", issuer: NET.usdc.issuer } }, ESCROW, TERMS, NET).state).toBe("not_xlm");
    expect(registryState(ERZGCG, ESCROW, TERMS, NET).state).toBe("match");
  });
});
