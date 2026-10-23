/**
 * OPT-IN testnet integration of host mode (src/custody/host.ts) against the
 * FichaEscrow named in config.ts. Skipped unless FICHA_TESTNET_E2E=1. From
 * app/:
 *
 *   FICHA_TESTNET_E2E=1 npx vitest run src/custody/host.testnet.test.ts
 *
 * Testnet only, nothing kept: Friendbot funds a throwaway host and payer,
 * made here in memory. The host registers a throwaway station (1-minute
 * fichas, 15 s units, the least grace the contract takes, 300 s), the payer
 * opens three sessions, and the host then does what the host screens do:
 * the view, a full refund before the deadline (a partial one and a release
 * are refused at simulation, before signing), and, once the deadline has
 * passed on the ledger, release all and a partial refund. About 7 minutes,
 * most of it waiting for the deadline.
 *
 * A second, shorter case (about a minute): the payer claims with a proof, the
 * host's share stays in the contract as owed, the host's view shows it, and
 * pay_host (collectOwed, what the host screen's Collect button sends) pays it
 * to the host and leaves nothing owed.
 */
import { Keypair, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { NETWORKS } from "@/config";
import type { CustodyStation, Registry } from "@/registry/verify";
import { hashForward } from "./chain";
import { EscrowError } from "./errors";
import { getRpc, readEscrow, type StationTerms } from "./escrow";
import {
  collectOwed,
  loadHostView,
  prepareHostRefund,
  preparePayHost,
  prepareRegister,
  prepareRelease,
  refundSplit,
  releaseMany,
  releaseSession,
  sendHostCall,
  type HostSession,
} from "./host";
import type { PayLink } from "./link";
import { prepareClaim, prepareDeposit, sendClaim, sendDeposit, type DepositRequest } from "./pay";

const ON = process.env.FICHA_TESTNET_E2E === "1";
const NET = NETWORKS.testnet;
const C = NET.custody!;
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const randomId = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ALPHABET[b % ALPHABET.length]).join("");

const signer = (kp: Keypair) => (tx: Transaction) => {
  tx.sign(kp);
  return tx;
};

async function friendbot(account: string): Promise<void> {
  const res = await fetch(`${NET.friendbotUrl}?addr=${account}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Friendbot HTTP ${res.status}: ${await res.text()}`);
}

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof EscrowError ? e.code : String(e)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!ON)("host mode on testnet, with the app's code (opt-in)", () => {
  it("registers, lists, refunds in full before the deadline, releases and refunds in part after it", async () => {
    const server = getRpc(C);
    const escrow = C.escrowContract;
    const host = Keypair.random();
    const payer = Keypair.random();
    await Promise.all([friendbot(host.publicKey()), friendbot(payer.publicKey())]);
    const H = host.publicKey();

    // Register: 0.1 XLM per 1-minute ficha, up to 2, refunds in 15 s units, 300 s of grace.
    const stationId = randomId(6);
    const terms: StationTerms = { token: C.xlmSac, price: 1_000_000n, fichaSecs: 60, maxFichas: 2, unitSecs: 15, graceSecs: 300, active: true };
    expect(await code(prepareRegister(server, NET, { escrow, host: H, station: stationId, terms: { ...terms, graceSecs: 299 } }))).toBe("BadConfig");
    await sendHostCall(server, escrow, await prepareRegister(server, NET, { escrow, host: H, station: stationId, terms }), signer(host));
    expect((await readEscrow(server, escrow, H, stationId)).station).toEqual(terms);

    // The payer opens three sessions of one ficha each.
    const sessions = [`F${randomId(7)}`, `F${randomId(7)}`, `F${randomId(7)}`];
    for (const session of sessions) {
      const link: PayLink = { network: "testnet", hostKey: H, stationId, session, anchor: hashForward(crypto.getRandomValues(new Uint8Array(32)), 8), anchorText: "" };
      const req: DepositRequest = { escrow, token: terms.token, asset: { code: "XLM", issuer: null }, payer: payer.publicKey(), link, fichas: 1, terms };
      await sendDeposit(server, NET, req, await prepareDeposit(server, NET, req), signer(payer));
    }

    // The host's view: the station (listed in a registry copy, as custody on this escrow) and the three sessions.
    const entry: CustodyStation = {
      id: stationId, name: "host e2e", host_key: H, asset: { code: "XLM", issuer: null }, ficha_price: "0.1", ficha_minutes: 1,
      max_session_minutes: 2, active: true, mode: "custody", escrow, unit_seconds: 15, grace_seconds: 300,
    };
    const reg: Registry = { format: "ficha-registry/1", issued_at: "2026-10-01T00:00:00Z", network: "testnet", stations: [entry] };
    let view = await loadHostView(server, NET, H, reg);
    expect(view.escrows).toEqual([{ id: escrow, wasmHash: C.escrowWasm[0], pinned: true }]);
    expect(view.stations).toEqual([expect.objectContaining({ id: stationId, registryState: "match", terms })]);
    expect(view.sessions.map((s) => s.session).sort()).toEqual([...sessions].sort());
    const byId = (id: string) => view.sessions.find((s) => s.session === id) as HostSession;
    const [s1, s2, s3] = sessions.map(byId);
    expect(s1).toMatchObject({ payer: payer.publicKey(), fichas: 1, amount: 1_000_000n, unitSecs: 15 });

    // Before the deadline: a partial refund and a release are refused at simulation; a full refund settles.
    expect(await code(prepareHostRefund(server, NET, s1, 3))).toBe("TooEarly");
    expect(await code(prepareRelease(server, NET, s2))).toBe("TooEarly");
    const full = await sendHostCall(server, escrow, await prepareHostRefund(server, NET, s1, 4), signer(host));
    expect(full.amount).toBe(1_000_000n);

    // After the deadline (on the ledger's clock): release all, and a partial refund.
    const deadline = Math.max(s2.deadline, s3.deadline);
    while ((await ledgerTime(server)) <= deadline) await sleep(10_000);
    const batch = await releaseMany([s2], (s) => releaseSession(server, NET, s, signer(host)));
    expect(batch).toMatchObject({ total: 1, done: 1, stopped: null });
    expect(batch.released[0].result.amount).toBe(1_000_000n);
    // Released again (by anyone): NoSession, which a batch skips.
    const again = await releaseMany([s2], (s) => releaseSession(server, NET, s, signer(host)));
    expect(again.skipped.map((x) => (x.error as EscrowError).code)).toEqual(["NoSession"]);
    const part = await sendHostCall(server, escrow, await prepareHostRefund(server, NET, s3, 1), signer(host));
    expect(part.amount).toBe(refundSplit(s3, 1).toPayer); // ceil(1 000 000 x 1 / 4)

    // The view: nothing open, three settlements, newest first.
    view = await loadHostView(server, NET, H, reg);
    expect(view.sessions).toEqual([]);
    expect(view.settled.map((e) => [e.session, e.how, e.toPayer, e.toHost])).toEqual([
      [s3.session, "host", 250_000n, 750_000n],
      [s2.session, "deadline", 0n, 1_000_000n],
      [s1.session, "host", 1_000_000n, 0n],
    ]);

    // Paused: the contract refuses new deposits.
    await sendHostCall(server, escrow, await prepareRegister(server, NET, { escrow, host: H, station: stationId, terms: { ...terms, active: false } }), signer(host));
    const link: PayLink = { network: "testnet", hostKey: H, stationId, session: `F${randomId(7)}`, anchor: new Uint8Array(32).fill(1), anchorText: "" };
    expect(await code(prepareDeposit(server, NET, { escrow, token: terms.token, asset: { code: "XLM", issuer: null }, payer: payer.publicKey(), link, fichas: 1, terms }))).toBe("Inactive");
  }, 900_000);
});

describe.skipIf(!ON)("what a claim leaves owed to the host, collected with pay_host (opt-in)", () => {
  it("shows the host's share of a claim as owed, and pays it to the host", async () => {
    const server = getRpc(C);
    const escrow = C.escrowContract;
    const host = Keypair.random();
    const payer = Keypair.random();
    await Promise.all([friendbot(host.publicKey()), friendbot(payer.publicKey())]);
    const H = host.publicKey();
    const stationId = randomId(6);
    // 0.1 XLM per 1-minute ficha, up to 2: N = 2 x 60 / 15 = 8 links.
    const terms: StationTerms = { token: C.xlmSac, price: 1_000_000n, fichaSecs: 60, maxFichas: 2, unitSecs: 15, graceSecs: 300, active: true };
    await sendHostCall(server, escrow, await prepareRegister(server, NET, { escrow, host: H, station: stationId, terms }), signer(host));

    // The station's chain: c[0] a random seed, the anchor c[8].
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const link: PayLink = { network: "testnet", hostKey: H, stationId, session: `F${randomId(7)}`, anchor: hashForward(seed, 8), anchorText: "" };
    const req: DepositRequest = { escrow, token: terms.token, asset: { code: "XLM", issuer: null }, payer: payer.publicKey(), link, fichas: 2, terms };
    const dep = await sendDeposit(server, NET, req, await prepareDeposit(server, NET, req), signer(payer));

    // The receipt proves 3 of 8 units unused: c[5]. The payer gets ceil(0.2 XLM x 3 / 8); the rest is owed to the host.
    const refund = { units: 3, proof: hashForward(seed, 5) };
    const claimed = await sendClaim(server, dep.record, await prepareClaim(server, NET, dep.record, refund), refund, signer(payer));
    expect(claimed.toPayer).toBe(750_000n);
    const share = 2_000_000n - 750_000n;

    const view = await loadHostView(server, NET, H, null);
    expect(view.owed).toEqual([{ escrow, token: C.xlmSac, amount: share, archived: false }]);
    const done = await collectOwed(server, NET, { escrow, token: C.xlmSac, host: H }, signer(host));
    expect(done.amount).toBe(share);
    expect((await loadHostView(server, NET, H, null)).owed).toEqual([]);
    // Collected: a second pay_host is refused at simulation, before signing.
    expect(await code(preparePayHost(server, NET, { escrow, host: H, token: C.xlmSac }))).toBe("NothingOwed");
  }, 300_000);
});

/** The latest ledger's close time (unix seconds), from the RPC. */
async function ledgerTime(server: ReturnType<typeof getRpc>): Promise<number> {
  return Number((await server.getLatestLedger()).closeTime);
}
