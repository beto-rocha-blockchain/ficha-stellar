/**
 * A receipt link opened by someone who did not pay it (review R2P3): the
 * judge's no-hardware evidence. With no wallet, the receipt is checked in
 * public: its proof's anchor names the session on the contract, open or
 * settled, with the transactions. Read with no key.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import { NETWORKS } from "@/config";
import { parseReceipt } from "@/pay/receipt";
import type { Registry } from "@/registry/verify";
import { addr, bytes32, i128, instanceKey, sessionKey, sym, termsVal, u32, type EscrowSession, type Rpc } from "./escrow";
import { publicReceipt } from "./receipt";

const NET = NETWORKS.testnet;
const C = NET.custody!;
const ESCROW = C.escrowContract;
const HOST = "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6";
const PAYER = "GAKINFFB6NVQONE3MA4BZ5X3EEDG6KYNG2WCL2NLJSFP2AAXI5GX6VIP";
const V = JSON.parse(readFileSync(fileURLToPath(new URL("../../../contracts/escrow/test-vectors.json", import.meta.url)), "utf8")) as {
  chains: { anchor_hex: string }[];
  receipt_v2: { link: string };
};
const ANCHOR = hexToBytes(V.chains[0].anchor_hex);
const r = parseReceipt(V.receipt_v2.link);

const REG: Registry = {
  format: "ficha-registry/1",
  issued_at: "2026-10-01T00:00:00Z",
  network: "testnet",
  stations: [
    {
      id: "ERZGCG", name: "Demo bench (testnet)", host_key: HOST, asset: { code: "XLM", issuer: null }, ficha_price: "1", ficha_minutes: 5,
      max_session_minutes: 60, active: true, mode: "custody", escrow: ESCROW, unit_seconds: 30, grace_seconds: 1680,
    },
  ],
};
const TERMS = { token: C.xlmSac, price: 10_000_000n, fichaSecs: 300, maxFichas: 12, unitSecs: 30, graceSecs: 1680 };
const SESSION: EscrowSession = { payer: PAYER, ...TERMS, chainLen: 120, anchor: ANCHOR, fichas: 2, amount: 20_000_000n, opened: 1_790_000_000, deadline: 1_790_002_280 };

const map = (o: [string, xdr.ScVal][]) => xdr.ScVal.scvMap(o.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })));
const u64 = (n: number) => xdr.ScVal.scvU64(BigInt(n));

function sessionVal(s: EscrowSession): xdr.ScVal {
  return map([
    ["amount", i128(s.amount)],
    ["anchor", bytes32(s.anchor)],
    ["chain_len", u32(s.chainLen)],
    ["deadline", u64(s.deadline)],
    ["ficha_secs", u32(s.fichaSecs)],
    ["fichas", u32(s.fichas)],
    ["grace_secs", u64(s.graceSecs)],
    ["max_fichas", u32(s.maxFichas)],
    ["opened", u64(s.opened)],
    ["payer", new Address(s.payer).toScVal()],
    ["price", i128(s.price)],
    ["token", addr(s.token)],
    ["unit_secs", u32(s.unitSecs)],
  ]);
}

let seq = 0;
function event(name: "deposit" | "settle", value: xdr.ScVal): rpc.Api.EventResponse {
  seq += 1;
  return {
    topic: [sym(name), addr(HOST), sym("ERZGCG"), sym("F3H9TXAB")], value, ledger: 4_000 + seq, ledgerClosedAt: "2026-10-02T00:00:00Z",
    txHash: `${name}${seq}`, id: `e${seq}`, type: "contract",
  } as unknown as rpc.Api.EventResponse;
}
const depositEv = (anchor = ANCHOR) =>
  event(
    "deposit",
    map([
      ["amount", i128(20_000_000n)], ["anchor", bytes32(anchor)], ["deadline", u64(SESSION.deadline)], ["fichas", u32(2)], ["payer", addr(PAYER)],
      ["terms", termsVal(TERMS)], ["total_amount", i128(20_000_000n)], ["total_fichas", u32(2)],
    ]),
  );
const settleEv = () =>
  event(
    "settle",
    map([["anchor", bytes32(ANCHOR)], ["how", sym("proof")], ["payer", addr(PAYER)], ["to_host", i128(13_000_000n)], ["to_payer", i128(7_000_000n)], ["unused_units", u32(7)]]),
  );

function chain(o: { session?: EscrowSession; events?: rpc.Api.EventResponse[]; wasm?: string } = {}): Rpc {
  const data = new Map<string, xdr.ScVal>([
    [
      instanceKey(ESCROW).toXdr("base64"),
      xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(hexToBytes(o.wasm ?? C.escrowWasm[0])), storage: null })),
    ],
  ]);
  if (o.session) data.set(sessionKey(ESCROW, HOST, "ERZGCG", "F3H9TXAB", o.session.anchor).toXdr("base64"), sessionVal(o.session));
  return {
    getHealth: vi.fn(async () => ({ status: "healthy", latestLedger: 5_000, oldestLedger: 1_000, ledgerRetentionWindow: 120_960 })),
    getEvents: vi.fn(async () => ({ events: o.events ?? [], cursor: `${(5000n << 32n).toString()}-4294967295`, latestLedger: 5_000, oldestLedger: 1_000 })),
    getLedgerEntries: vi.fn(async (...ks: xdr.LedgerKey[]) => ({
      latestLedger: 5_000,
      entries: ks
        .filter((k) => data.has(k.toXdr("base64")))
        .map((k) => {
          if (k.type !== "contractData") throw new Error();
          const cd = k.contractData;
          const val = data.get(k.toXdr("base64"))!;
          return {
            key: k,
            val: xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({ ext: xdr.ExtensionPoint.v0(), contract: cd.contract, key: cd.key, durability: cd.durability, val })),
            liveUntilLedgerSeq: 10_000_000,
          };
        }),
    })),
  } as unknown as Rpc;
}

describe("a receipt checked in public, by someone who did not pay it (review R2P3)", () => {
  it("shows the open session its proof names, and what a claim with it would split", async () => {
    const p = await publicReceipt(chain({ session: SESSION }), NET, r, REG);
    expect(p).toMatchObject({ state: "open", escrow: ESCROW, units: 7, paidUnits: 20, toPayer: 7_000_000n, toHost: 13_000_000n, amountMatches: true });
  });

  it("shows how it settled, with the settle and deposit transactions, from the events alone", async () => {
    const p = await publicReceipt(chain({ events: [depositEv(), depositEv(new Uint8Array(32).fill(9)), settleEv()] }), NET, r, REG);
    expect(p.state).toBe("settled");
    if (p.state !== "settled") throw new Error();
    expect(p.settle).toMatchObject({ how: "proof", toPayer: 7_000_000n, toHost: 13_000_000n, unusedUnits: 7 });
    // Another chain's deposit under the same ID is another session: not this receipt's.
    expect(p.deposits).toHaveLength(1);
    expect(p.amountMatches).toBe(true);
    expect(await publicReceipt(chain({ events: [depositEv()] }), NET, r, REG)).toMatchObject({ state: "deposited", amountMatches: true });
  });

  it("says nothing it cannot back: another contract's code, a station not in the registry, nothing on the ledger", async () => {
    expect(await publicReceipt(chain({ session: SESSION, wasm: "00".repeat(32) }), NET, r, REG)).toEqual({ state: "unknown" });
    expect(await publicReceipt(chain({ session: SESSION }), NET, r, { ...REG, stations: [] })).toEqual({ state: "unknown" });
    expect(await publicReceipt(chain(), NET, r, REG)).toEqual({ state: "unknown" });
    expect(await publicReceipt(chain({ session: SESSION }), NETWORKS.public, r, REG)).toEqual({ state: "unknown" });
  });

  it("is shown on /r with no wallet, or with a wallet that did not pay", () => {
    const screen = readFileSync(fileURLToPath(new URL("../components/CustodyReceipt.tsx", import.meta.url)), "utf8");
    expect(screen).toContain('check.state === "not_mine" && (check.reason === "noWallet" || check.reason === "noDeposit") && <PublicCheck receipt={r} />');
    expect(screen).toContain("publicReceipt(getRpc(net.custody), net, r, registry)");
  });
});
