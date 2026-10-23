/**
 * OPT-IN end to end on testnet: a RUNNING custody station and the app's own
 * code (docs/station-app-contract.md §7.4 and §7.6). Skipped unless
 * FICHA_STATION_E2E is set. From app/:
 *
 *   FICHA_STATION_E2E=http://127.0.0.1:8033 FICHA_E2E_PAYER=<key file> \
 *     npx vitest run src/custody/station.testnet.test.ts
 *
 * The station runs with MOCK=true (simulated relay and phone) and real
 * deposits (MOCK_PAYMENT=false), e.g. with .env.lisbon.example. The test
 * reads the pay link from the station's screen (/ws), checks it against the
 * signed registry in this repo and the contract, deposits, lets the
 * simulated phone charge, ends the session, reads the v2 receipt off the
 * screen, checks its proof and claims with it. Then the balances on the
 * ledger, what the contract owes the host (a claim never pays the host
 * directly: its share waits for pay_host) and the station's log (credited,
 * finished, settled) must agree.
 * docs/testnet-e2e.md has a run with every transaction.
 *
 *   FICHA_E2E_PAYER     file holding a funded testnet payer's secret (S...), never printed
 *   FICHA_E2E_FICHAS    fichas in the first deposit (1)
 *   FICHA_E2E_TOPUP     fichas in a top-up while charging (0: none)
 *   FICHA_E2E_CHARGE    seconds to charge before the key ends the session (40)
 *   FICHA_E2E_END       esc (default), e (the E key, the demo's way to end a
 *                       session), or wait: the station ends the session itself
 *   FICHA_E2E_REASON    the end reason to expect (emergency_stop with esc,
 *                       stopped with e)
 *   FICHA_E2E_MODE      claim (default); keep: no claim, write the session to
 *                       FICHA_E2E_OUT for a later release; release: read that
 *                       file, wait for the deadline, and release
 *   FICHA_E2E_UNLISTED  1: a throwaway station not in the registry; its
 *                       terms are read from the contract only
 *   FICHA_E2E_LOG       the station's SESSION_LOG, to check its lines
 *   FICHA_E2E_OUT       JSON file for the transactions and amounts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Address, Keypair, StrKey, type Transaction, scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { NETWORKS } from "@/config";
import { isCustodyReceipt, parseReceipt } from "@/pay/receipt";
import { verifyRegistry, type CustodyStation, type Registry } from "@/registry/verify";
import { toStroops } from "@/stellar/amount";
import { fromB64url, payerShare } from "./chain";
import { checkChain, checkRegistry, planDeposit } from "./check";
import type { DepositRecord } from "./deposits-store";
import { EscrowError } from "./errors";
import { addr, getRpc, readEscrow, sym, type Rpc } from "./escrow";
import { prepareRelease, sendHostCall } from "./host";
import { isPayLink, parsePayLink } from "./link";
import { prepareClaim, prepareDeposit, sendClaim, sendDeposit, type DepositRequest } from "./pay";
import { proofMatches, receiptFacts } from "./receipt";

const env = process.env;
const BASE = env.FICHA_STATION_E2E ?? "";
const NET = NETWORKS.testnet;
const C = NET.custody!;
const MODE = env.FICHA_E2E_MODE ?? "claim";
const OUT = env.FICHA_E2E_OUT;
const LOG = env.FICHA_E2E_LOG;
const tx = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

/** What the station's screen gets over /ws (main.py snapshot), the parts used here. */
interface Snap {
  state: string;
  session_id: string;
  uri: string;
  fichas_bought: number;
  charge: { phase: string | null; consumed_seconds: number };
  custody: { session: string; anchor: string; deadline: number | null } | null;
  receipt: { uri: string } | null;
  last: { id: string; end_reason: string; custody?: { unused_units: number } } | null;
  last_receipt: { id: string } | null;
}

function payerKey(): Keypair {
  const file = env.FICHA_E2E_PAYER ?? "";
  const secret = file && existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (!StrKey.isValidEd25519SecretSeed(secret)) throw new Error("FICHA_E2E_PAYER must name a file holding a testnet secret key");
  return Keypair.fromSecret(secret);
}

const signer = (kp: Keypair) => (t: Transaction) => {
  t.sign(kp);
  return t;
};

function repoRegistry(): Registry {
  const file = new URL("../../../registry/stations.json", import.meta.url);
  return verifyRegistry(new Uint8Array(readFileSync(file)), readFileSync(new URL("../../../registry/stations.json.sig", import.meta.url), "utf8"), NET.registryKey, "testnet");
}

/** The station's screen: the latest snapshot, and a wait for one that passes a test. */
function station(base: string) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`);
  let latest: Snap | null = null;
  ws.addEventListener("message", (m) => {
    latest = JSON.parse(String(m.data)) as Snap;
  });
  const opened = new Promise<void>((ok, fail) => {
    ws.addEventListener("open", () => ok());
    ws.addEventListener("error", () => fail(new Error(`cannot reach the station at ${base}/ws`)));
  });
  return {
    opened,
    send: (key: string) => ws.send(JSON.stringify({ key })),
    close: () => ws.close(),
    async until<T>(what: string, pick: (s: Snap) => T | null | undefined | false, ms: number): Promise<T> {
      const end = Date.now() + ms;
      for (;;) {
        const hit = latest && pick(latest);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`station: no ${what} in ${ms / 1000} s (state ${latest?.state})`);
        await new Promise((r) => setTimeout(r, 250));
      }
    },
  };
}

/** Horizon: an account's XLM in stroops, and what a transaction paid in fees. */
async function horizon<T>(path: string, tries = 20): Promise<T> {
  for (let i = 0; ; i++) {
    const res = await fetch(`${NET.horizonUrl}${path}`, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) return (await res.json()) as T;
    if (res.status !== 404 || i >= tries) throw new Error(`Horizon ${path}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}
const xlm = async (account: string) =>
  toStroops((await horizon<{ balances: { asset_type: string; balance: string }[] }>(`/accounts/${account}`)).balances.find((b) => b.asset_type === "native")!.balance);
const feeOf = async (hash: string) => BigInt((await horizon<{ fee_charged: string }>(`/transactions/${hash}`)).fee_charged);

/** What the contract owes `host` in `token` (Key::Owed, contract §7.2): 0 when there is no entry. */
async function owedOf(server: Rpc, escrow: string, host: string, token: string): Promise<bigint> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(escrow).toScAddress(),
      key: xdr.ScVal.scvVec([sym("Owed"), addr(host), addr(token)]),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  const res = await server.getLedgerEntries(key);
  const e = res.entries[0];
  return e && e.val.type === "contractData" ? BigInt(scValToNative(e.val.contractData.val)) : 0n;
}

/** The station's log lines for one session (main.py's SESSION_LOG), waiting for a kind to show up. */
async function logLines(id: string, need: string, ms = 60_000): Promise<Record<string, unknown>[]> {
  const end = Date.now() + ms;
  for (;;) {
    const lines = existsSync(LOG!)
      ? readFileSync(LOG!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
    const mine = lines.filter((l) => l.session === id || l.id === id);
    if (mine.some((l) => l.kind === need) || Date.now() > end) return mine;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function save(data: Record<string, unknown>): void {
  if (OUT) writeFileSync(OUT, JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

describe.skipIf(!BASE)("a custody station on testnet, end to end with the app's code (opt-in)", () => {
  it.skipIf(MODE === "release")("pays the station's pay link, charges, and claims with its receipt", async () => {
    const payer = payerKey();
    const me = payer.publicKey();
    const server = getRpc(C);
    const fichas = Number(env.FICHA_E2E_FICHAS ?? 1);
    const topup = Number(env.FICHA_E2E_TOPUP ?? 0);
    const chargeFor = Number(env.FICHA_E2E_CHARGE ?? 40);
    const endBy = env.FICHA_E2E_END ?? "esc";
    const out: Record<string, unknown> = { station: BASE, payer: me, mode: MODE };

    const st = station(BASE);
    await st.opened;
    try {
      // The pay link on the station's AWAITING_PAYMENT screen, as a phone would scan it.
      const s0 = await st.until("pay link", (s) => s.state === "AWAITING_PAYMENT" && s.custody && isPayLink(s.uri) && s, 30_000);
      const link = parsePayLink(s0.uri);
      expect(link.anchorText).toBe(s0.custody!.anchor);
      const id = `${link.stationId}.${link.session}`;
      out.payLink = s0.uri;
      out.session = id;

      // §7.4 steps 1 to 4: the signed registry, the contract's code and terms, no session yet.
      const reg = repoRegistry();
      const rc = checkRegistry(link, reg, NET);
      let entry: CustodyStation;
      const sid = { session: link.session, anchor: link.anchor };
      let view = await readEscrow(server, C.escrowContract, link.hostKey, link.stationId, sid);
      if (rc.state === "ok") {
        entry = rc.station;
      } else {
        expect(env.FICHA_E2E_UNLISTED, `the registry says ${rc.state}`).toBe("1");
        const t = view.station!;
        const minutes = t.fichaSecs / 60;
        entry = {
          id: link.stationId, name: "e2e", host_key: link.hostKey, asset: { code: "XLM", issuer: null },
          ficha_price: (Number(t.price) / 1e7).toString(), ficha_minutes: minutes, max_session_minutes: t.maxFichas * minutes,
          active: true, mode: "custody", escrow: C.escrowContract, unit_seconds: t.unitSecs, grace_seconds: t.graceSecs,
        };
      }
      const cc = checkChain(entry, view, NET);
      expect(cc.state).toBe("ok");
      if (cc.state !== "ok") return;
      const terms = cc.terms;
      expect(planDeposit(view.session, me, link, terms, Date.now() / 1000)).toMatchObject({ kind: "new" });

      const payerBefore = await xlm(me);
      const hostBefore = await xlm(link.hostKey);
      const owedBefore = await owedOf(server, entry.escrow, link.hostKey, terms.token);

      // The deposit, as /p sends it: simulated, its authorization checked, signed, sent and followed.
      const req: DepositRequest = { escrow: entry.escrow, token: terms.token, asset: entry.asset, payer: me, link, fichas, terms };
      const d1 = await sendDeposit(server, NET, req, await prepareDeposit(server, NET, req), signer(payer));
      let record: DepositRecord = d1.record;
      const hashes = [d1.hash];
      out.deposit = { hash: d1.hash, link: tx(d1.hash), fichas, deadline: d1.deadline };

      // The station credits it from the contract's event and starts charging the simulated phone.
      await st.until("credited deposit", (s) => s.state === "CHARGING" && s.session_id === id && s.fichas_bought === fichas, 90_000);
      await st.until("verified charging", (s) => s.charge.phase === "running", 60_000);

      if (topup > 0) {
        // A top-up while charging: the same link, the session's own anchor and terms.
        view = await readEscrow(server, entry.escrow, link.hostKey, link.stationId, sid);
        expect(planDeposit(view.session, me, link, terms, Date.now() / 1000)).toMatchObject({ kind: "topup" });
        const top: DepositRequest = { ...req, fichas: topup, open: view.session, previous: record };
        const d2 = await sendDeposit(server, NET, top, await prepareDeposit(server, NET, top), signer(payer));
        record = d2.record;
        hashes.push(d2.hash);
        out.topup = { hash: d2.hash, link: tx(d2.hash), fichas: topup, deadline: d2.deadline };
        await st.until("credited top-up", (s) => s.session_id === id && s.fichas_bought === fichas + topup, 90_000);
      }

      if (endBy !== "wait") {
        await st.until(`${chargeFor} s of charging`, (s) => s.state === "CHARGING" && s.charge.consumed_seconds >= chargeFor, (chargeFor + 120) * 1000);
        st.send(endBy === "e" ? "e" : "escape");
      }
      // FINISHED with the v2 receipt; once the cut is confirmed it says so (c=1).
      const fin = await st.until("receipt", (s) => s.state === "FINISHED" && s.last?.id === id && s.receipt && s, endBy === "wait" ? 1_200_000 : 30_000);
      const cut = await st.until("confirmed cut", (s) => s.receipt?.uri.includes("&c=1&") && s, 20_000).catch(() => fin);
      const uri = cut.receipt!.uri;
      expect(fin.last!.end_reason).toBe(env.FICHA_E2E_REASON ?? (endBy === "e" ? "stopped" : "emergency_stop"));
      out.endReason = fin.last!.end_reason;
      out.receipt = uri;

      // §7.6 steps 1 to 3: this wallet's deposit, the proof leads to its anchor, q by the rule.
      const r = parseReceipt(uri);
      expect(isCustodyReceipt(r)).toBe(true);
      const facts = receiptFacts(r, record);
      expect(facts).toMatchObject({ matches: true, unitsOk: true });
      expect(proofMatches(r, record)).toBe(true);
      out.units = facts.units;
      out.paidUnits = facts.paidUnits;
      out.consumedSeconds = r.usedSeconds;
      const amount = BigInt(record.amount);

      if (MODE === "keep") {
        // No claim: the deadline path. A later run with FICHA_E2E_MODE=release ends it.
        save({ ...out, record, deadline: record.deadline, deposits: hashes, payerBefore, hostBefore, amount });
        return;
      }

      // §7.6 step 5: the claim, with the receipt's q and z.
      const refund = { units: r.refund!.units, proof: fromB64url(r.refund!.proof) };
      const done = await sendClaim(server, record, await prepareClaim(server, NET, record, refund), refund, signer(payer));
      expect(done.toPayer).toBe(facts.toPayer);
      expect(done.toPayer).toBe(payerShare(amount, facts.units, facts.paidUnits).toPayer);
      hashes.push(done.hash);
      out.claim = { hash: done.hash, link: tx(done.hash), toPayer: done.toPayer, toHost: done.toHost };

      // The ledger: the payer paid the deposits and the fees and got its share back; the rest is
      // owed to the host (the claim never touches the host's account), until anyone sends pay_host.
      const fees = (await Promise.all(hashes.map(feeOf))).reduce((a, b) => a + b, 0n);
      const payerAfter = await xlm(me);
      expect(payerAfter).toBe(payerBefore - amount - fees + done.toPayer);
      const owedAfter = await owedOf(server, entry.escrow, link.hostKey, terms.token);
      expect(owedAfter - owedBefore).toBe(done.toHost);
      const hostAfter = await xlm(link.hostKey);
      expect(hostAfter).toBe(hostBefore);
      out.balances = { payerBefore, payerAfter, fees, hostBefore, hostAfter, owedBefore, owedAfter };

      // The station: credited (each deposit), finished, then settled by proof.
      if (LOG) {
        const lines = await logLines(id, "settled");
        const kinds = lines.map((l) => l.kind);
        expect(kinds.filter((k) => k === "credited")).toHaveLength(hashes.length - 1);
        expect(kinds).toContain("finished");
        const settled = lines.find((l) => l.kind === "settled")!;
        expect(settled).toMatchObject({ how: "proof", tx_hash: done.hash, unused_units: Math.min(facts.units, facts.paidUnits) });
        expect(toStroops(String(settled.to_payer))).toBe(done.toPayer);
        expect(toStroops(String(settled.to_host))).toBe(done.toHost);
        out.log = kinds;
      }
      save(out);
    } finally {
      st.close();
    }
  }, 1_800_000);

  it.skipIf(MODE !== "release")("after the deadline: no claim, and anyone releases everything to the host", async () => {
    const payer = payerKey();
    const server = getRpc(C);
    const kept = JSON.parse(readFileSync(env.FICHA_E2E_IN ?? OUT!, "utf8")) as { record: DepositRecord; session: string; units: number; receipt: string };
    const record = kept.record;
    const ref = { escrow: record.escrow, host: record.hostKey, station: record.stationId, session: record.session, anchor: fromB64url(record.anchor) };
    const amount = BigInt(record.amount);
    const r = parseReceipt(kept.receipt);
    const refund = { units: r.refund!.units, proof: fromB64url(r.refund!.proof) };

    // Wait for the ledger to pass the deadline: release says TooEarly until then.
    const wait = (record.deadline - Date.now() / 1000 + 30) * 1000;
    if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
    let prepared = null;
    for (let i = 0; i < 40 && !prepared; i++) {
      prepared = await prepareRelease(server, NET, ref, payer.publicKey()).catch((e: unknown) => {
        if ((e as EscrowError).code !== "TooEarly") throw e;
        return null;
      });
      if (!prepared) await new Promise((ok) => setTimeout(ok, 5000));
    }
    expect(prepared).not.toBeNull();
    // The payer's proof no longer works: past the deadline the host gets everything.
    await expect(prepareClaim(server, NET, record, refund)).rejects.toMatchObject({ code: "Expired" });

    const hostBefore = await xlm(record.hostKey);
    // Anyone may send release (here the payer pays its fee); no signature is asked for in the call.
    const done = await sendHostCall(server, record.escrow, prepared!, signer(payer));
    expect(done.amount).toBe(amount);
    let hostAfter = await xlm(record.hostKey);
    for (let i = 0; i < 10 && hostAfter === hostBefore; i++) {
      await new Promise((ok) => setTimeout(ok, 1500));
      hostAfter = await xlm(record.hostKey);
    }
    expect(hostAfter - hostBefore).toBe(amount);
    await expect(prepareRelease(server, NET, ref, payer.publicKey())).rejects.toMatchObject({ code: "NoSession" });

    const out: Record<string, unknown> = { ...kept, release: { hash: done.hash, link: tx(done.hash), toHost: done.amount }, hostBefore, hostAfter };
    if (LOG) {
      const lines = await logLines(kept.session, "settled");
      const settled = lines.find((l) => l.kind === "settled")!;
      expect(settled).toMatchObject({ how: "deadline", tx_hash: done.hash, unused_units: 0 });
      expect(toStroops(String(settled.to_host))).toBe(amount);
      out.log = lines.map((l) => l.kind);
    }
    if (OUT) save(out);
  }, 2_400_000);
});
