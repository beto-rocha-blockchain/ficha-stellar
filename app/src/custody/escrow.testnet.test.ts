/**
 * OPT-IN testnet integration: a real deposit, top-up and claim through the
 * app's own custody code (src/custody), against the FichaEscrow named in
 * config.ts. Skipped unless FICHA_TESTNET_E2E=1. From app/:
 *
 *   FICHA_TESTNET_E2E=1 npx vitest run src/custody/escrow.testnet.test.ts
 *
 * Testnet only, nothing kept: Friendbot funds two throwaway accounts, a host
 * and a payer, made here in memory. The host registers a throwaway station
 * (with the same prepareCall/sendAndWait the host screens will use) and the
 * test plays the station: a seed, its chain, then the receipt's proof. The
 * payer then does what the Pay and Receipt screens do. The host also plays a
 * squatter: it pays the session's ID first with a chain of its own, which on
 * this contract is a session of its own that does not stop the payer. About
 * a minute.
 */
import { Keypair, nativeToScVal, xdr, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { NETWORKS } from "@/config";
import type { CustodyStation } from "@/registry/verify";
import { chainLength, hashForward, proofLeadsToAnchor, sameBytes, unusedUnits } from "./chain";
import { checkChain, planDeposit } from "./check";
import { EscrowError } from "./errors";
import { addr, fetchEscrowEvents, getRpc, prepareCall, readEscrow, sendAndWait, sym, type StationTerms } from "./escrow";
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

/** StationCfg as the contract takes it: a map with Symbol keys, sorted. */
function stationCfg(t: StationTerms): xdr.ScVal {
  const entry = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: sym(k), val: v });
  return xdr.ScVal.scvMap([
    entry("active", xdr.ScVal.scvBool(t.active)),
    entry("ficha_secs", nativeToScVal(t.fichaSecs, { type: "u32" })),
    entry("grace_secs", nativeToScVal(BigInt(t.graceSecs), { type: "u64" })),
    entry("max_fichas", nativeToScVal(t.maxFichas, { type: "u32" })),
    entry("price", nativeToScVal(t.price, { type: "i128" })),
    entry("token", addr(t.token)),
    entry("unit_secs", nativeToScVal(t.unitSecs, { type: "u32" })),
  ]);
}

describe.skipIf(!ON)("FichaEscrow on testnet, with the app's code (opt-in)", () => {
  it("deposits, tops up, refuses what it must before signing, claims with the station's proof", async () => {
    const server = getRpc(C);
    const escrow = C.escrowContract;
    const host = Keypair.random();
    const payer = Keypair.random();
    await Promise.all([friendbot(host.publicKey()), friendbot(payer.publicKey())]);

    // The host lists a throwaway station: 0.1 XLM per 1-minute ficha, up to 4, refunds in 15 s units, and the
    // recommended grace (a top-up is offered only until the station's end, 900 s before the deadline).
    const stationId = randomId(6);
    const terms: StationTerms = { token: C.xlmSac, price: 1_000_000n, fichaSecs: 60, maxFichas: 4, unitSecs: 15, graceSecs: 1680, active: true };
    const regArgs = [addr(host.publicKey()), sym(stationId), stationCfg(terms)];
    const reg = await prepareCall(server, NET.passphrase, {
      source: host.publicKey(),
      escrow,
      fn: "register",
      args: regArgs,
      auth: { contract: escrow, fn: "register", args: regArgs, sub: [] },
    });
    await sendAndWait(server, signer(host)(reg.tx), escrow);
    const entry: CustodyStation = {
      id: stationId,
      name: "e2e",
      host_key: host.publicKey(),
      asset: { code: "XLM", issuer: null },
      ficha_price: "0.1",
      ficha_minutes: 1,
      max_session_minutes: 4,
      active: true,
      mode: "custody",
      escrow,
      unit_seconds: 15,
      grace_seconds: 1680,
    };

    // The station: a session, a seed, the anchor in the pay link.
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const n = chainLength(terms);
    expect(n).toBe(16);
    const link: PayLink = { network: "testnet", hostKey: host.publicKey(), stationId, session: `F${randomId(7)}`, anchor: hashForward(seed, n), anchorText: "" };

    const sid = { session: link.session, anchor: link.anchor };

    // Someone who saw the QR pays its session ID first, with a chain of its own (here the host's wallet).
    const squatSeed = crypto.getRandomValues(new Uint8Array(32));
    const squatLink: PayLink = { ...link, anchor: hashForward(squatSeed, n) };
    const squatReq: DepositRequest = { escrow, token: terms.token, asset: { code: "XLM", issuer: null }, payer: host.publicKey(), link: squatLink, fichas: 1, terms };
    const squat = await sendDeposit(server, NET, squatReq, await prepareDeposit(server, NET, squatReq), signer(host));

    // The payer: the contract's code and the station's terms match the registry entry; the
    // station's session (its ID and its anchor) is still not open: the squatter's is another.
    let view = await readEscrow(server, escrow, link.hostKey, stationId, sid);
    const cc = checkChain(entry, view, NET);
    expect(cc).toEqual({ state: "ok", terms });
    expect(view.session).toBeNull();
    expect(planDeposit(view.session, payer.publicKey(), link, terms, Date.now() / 1000)).toMatchObject({ kind: "new", max: 4 });

    const req: DepositRequest = { escrow, token: terms.token, asset: entry.asset, payer: payer.publicKey(), link, fichas: 2, terms };
    const p1 = await prepareDeposit(server, NET, req);
    expect(p1.amount).toBe(2_000_000n);
    expect(p1.fee).toBeLessThan(2_000_000n);
    const d1 = await sendDeposit(server, NET, req, p1, signer(payer));
    expect(d1.record).toMatchObject({ fichas: 2, amount: "2000000", stationId, session: link.session });

    // Top-up of the same session, by the same payer, with the same anchor.
    view = await readEscrow(server, escrow, link.hostKey, stationId, sid);
    const plan = planDeposit(view.session, payer.publicKey(), link, terms, Date.now() / 1000);
    expect(plan).toMatchObject({ kind: "topup", max: 2 });
    const top: DepositRequest = { ...req, fichas: 1, open: view.session, previous: d1.record };
    const d2 = await sendDeposit(server, NET, top, await prepareDeposit(server, NET, top), signer(payer));
    expect(d2.record).toMatchObject({ fichas: 3, amount: "3000000" });
    expect(d2.record.txHashes).toHaveLength(2);
    expect(d2.deadline).toBe(view.session!.opened + 3 * 60 + 1680);

    // Refused at simulation, nothing signed: another wallet on this session (a copied
    // QR), terms other than the ones the payer read, too many fichas.
    const code = async (r: DepositRequest) => prepareDeposit(server, NET, r).then(() => "ok", (e: unknown) => (e as EscrowError).code);
    expect(await code({ ...req, payer: host.publicKey() })).toBe("OtherPayer");
    expect(await code({ ...req, link: { ...link, session: `F${randomId(7)}` }, terms: { ...terms, unitSecs: 30 } })).toBe("TermsChanged");
    expect(await code({ ...top, fichas: 2 })).toBe("BadFichas");

    // The station's receipt: 100 s charged of 180 s paid -> 6 units of 15 s back, proof c[N-6].
    const units = unusedUnits(180, 100, 15);
    expect(units).toBe(6);
    const proof = hashForward(seed, n - units);
    expect(proofLeadsToAnchor(link.anchor, units, proof)).toBe(true);
    await expect(prepareClaim(server, NET, d2.record, { units: units + 1, proof })).rejects.toMatchObject({ code: "BadProof" });

    const c = await prepareClaim(server, NET, d2.record, { units, proof });
    const done = await sendClaim(server, d2.record, c, { units, proof }, signer(payer));
    // ceil(3 000 000 x 6 / 12) back to the payer, the rest to the host.
    expect(done.toPayer).toBe(1_500_000n);
    expect(done.toHost).toBe(1_500_000n);
    expect(done.record.settled).toMatchObject({ how: "proof", unusedUnits: 6 });

    // The squatter's own session refunds it in full with its own chain, and touched nothing else.
    const sq = await sendClaim(server, squat.record, await prepareClaim(server, NET, squat.record, { units: n, proof: squatSeed }), { units: n, proof: squatSeed }, signer(host));
    expect(sq.toPayer).toBe(1_000_000n);

    // The session is gone; the events tell the story.
    view = await readEscrow(server, escrow, link.hostKey, stationId, sid);
    expect(view.session).toBeNull();
    await expect(prepareClaim(server, NET, d2.record, { units, proof })).rejects.toMatchObject({ code: "NoSession" });
    const scan = await fetchEscrowEvents(server, escrow, [{ host: link.hostKey, station: stationId }], { startLedger: squat.record.ledger! - 1 });
    const all = scan.events.filter((e) => e.session === link.session);
    expect(all.map((e) => e.kind)).toEqual(["deposit", "deposit", "deposit", "settle", "settle"]);
    const mine = all.filter((e) => sameBytes(e.anchor, link.anchor));
    expect(mine.map((e) => e.kind)).toEqual(["deposit", "deposit", "settle"]);
    expect(mine[2]).toMatchObject({ kind: "settle", how: "proof", toPayer: 1_500_000n, toHost: 1_500_000n, unusedUnits: 6, payer: payer.publicKey() });
    expect(mine[1]).toMatchObject({ kind: "deposit", totalFichas: 3, totalAmount: 3_000_000n, deadline: d2.deadline });
  }, 240_000);
});
