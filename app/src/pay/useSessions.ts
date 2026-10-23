/**
 * The wallet's charging sessions on the active network, joined with stored
 * receipts: direct payments from Horizon, custody deposits from the phone and
 * the escrow's events and sessions on Soroban RPC (src/custody/sessions.ts).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { NetworkConfig } from "@/config";
import { fromB64url } from "@/custody/chain";
import type { DepositRecord } from "@/custody/deposits-store";
import { receiptLeadsTo } from "@/custody/receipt";
import { getRpc } from "@/custody/escrow";
import { sessionName } from "@/custody/link";
import { loadCustodySessions } from "@/custody/sessions";
import { hostKeys, stationForMemo, useRegistry, type Registry } from "@/registry";
import { fromStroops } from "@/stellar/amount";
import { useNetwork } from "@/stellar/network";
import { useWallet } from "@/wallet";
import { fetchMyPayments, fetchReceiptPayments, groupSessions, mayBeShared, recheckReceipt, sessionHosts, type MyPayment, type Session } from "./history";
import { isCustodyReceipt } from "./receipt";
import { listReceipts, saveReceipt, type StoredReceipt } from "./receipts-store";
import { parseFichaMemo } from "./sep7";

/** Receipts per History load checked against the host's payments (sessions paid by several wallets). */
const SHARED_CHECKS = 3;

/** A stored receipt checked against the host's payments with its memo, from every wallet. */
async function recheckShared(net: NetworkConfig, r: StoredReceipt, payments: MyPayment[], registry: Registry | null): Promise<StoredReceipt> {
  try {
    const session = await fetchReceiptPayments(net, r.receipt, payments);
    const fm = parseFichaMemo(r.receipt.memo);
    const st = stationForMemo(registry, fm?.kind === "station" ? fm.stationId : null, r.receipt.hostKey);
    return recheckReceipt(r, payments, { payments: session.payments, asset: st?.asset, fichaPrice: st?.ficha_price });
  } catch {
    return recheckReceipt(r, payments);
  }
}

export interface SessionRow extends Session {
  receipt?: StoredReceipt;
  /** Custody mode: this wallet's deposit and its state on the contract. */
  custody?: DepositRecord;
}

/**
 * The receipt kept under a row's session name, if it is the row's: for a
 * custody session, only one whose proof leads to its anchor (two sessions
 * under one ID, one from a forged pay link, share the name, not the receipt).
 */
export function receiptFor(row: Pick<SessionRow, "custody">, stored: StoredReceipt | undefined): StoredReceipt | undefined {
  if (!stored || !row.custody) return stored;
  try {
    return receiptLeadsTo(stored.receipt, fromB64url(row.custody.anchor)) ? stored : undefined;
  } catch {
    return undefined;
  }
}

/** A custody deposit as a History row: its amount is this wallet's deposit, its memo the session's name. */
export function custodyRow(d: DepositRecord): SessionRow {
  return {
    memo: sessionName(d.stationId, d.session),
    stationId: d.stationId,
    hostKey: d.hostKey,
    assetCode: d.asset.code,
    assetIssuer: d.asset.issuer,
    amount: fromStroops(BigInt(d.amount)),
    startedAt: new Date(d.createdAt).toISOString(),
    txHashes: d.txHashes,
    custody: d,
  };
}

export function useSessions() {
  const net = useNetwork();
  const publicKey = useWallet((s) => s.publicKey);
  const reg = useRegistry();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (registry: Registry | null) => {
      if (!publicKey) return;
      const mine = ++seq.current;
      setLoading(true);
      try {
        const known = hostKeys(registry);
        // Receipts are the station's statement; they also tell us host keys of legacy stations.
        const all = await listReceipts(net.id);
        // Custody receipts (v2) are checked against the deposit, on the receipt screen: not against payments.
        const stored = all.filter((r) => !isCustodyReceipt(r.receipt));
        for (const r of stored) known.add(r.receipt.hostKey);
        const [payments, deposits] = await Promise.all([
          fetchMyPayments(net, publicKey),
          net.custody ? loadCustodySessions(getRpc(net.custody), net, publicKey, registry).catch(() => []) : [],
        ]);
        const hosts = sessionHosts(known, payments);
        // A receipt the receipt screen could not confirm (offline, say) is checked again now;
        // the newest ones the user's payments are only part of, against every wallet's payments.
        const shared = new Set(
          stored
            .filter((r) => r.check !== "confirmed" && mayBeShared(r.receipt, payments))
            .sort((a, b) => b.receipt.finishedAt - a.receipt.finishedAt)
            .slice(0, SHARED_CHECKS),
        );
        const receipts = await Promise.all(stored.map((r) => (shared.has(r) ? recheckShared(net, r, payments, registry) : recheckReceipt(r, payments))));
        for (const [i, r] of receipts.entries()) if (r !== stored[i]) void saveReceipt(r);
        const byKey = new Map([...all, ...receipts].map((r) => [`${r.receipt.hostKey}|${r.receipt.memo}`, r]));
        const direct: SessionRow[] = groupSessions(payments, hosts);
        const out = [...direct, ...deposits.map(custodyRow)]
          .map((s) => ({ ...s, receipt: receiptFor(s, byKey.get(`${s.hostKey}|${s.memo}`)) }))
          .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
        if (mine === seq.current) {
          setRows(out);
          setError(null);
        }
      } catch (e) {
        if (mine === seq.current) setError(e);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [net, publicKey],
  );

  useEffect(() => {
    if (reg.status === "ready" || reg.status === "error") void load(reg.registry);
  }, [reg.status, reg.registry, load]);

  return { rows, loading: loading || reg.status === "loading", error, refresh: () => load(reg.registry), registry: reg.registry, registryStatus: reg.status };
}
