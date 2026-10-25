/**
 * Transaction builders and submission. Build -> sign on the phone
 * (src/wallet signTransaction) -> submit. Nothing here holds a key.
 *
 *   const tx = await buildPaymentTx({ net, source: publicKey, destination, asset, amount, memo });
 *   const { hash } = await submitTx(net, signTransaction(tx));
 */
import { Asset, BASE_FEE, Memo, NotFoundError, Operation, TransactionBuilder, type FeeBumpTransaction, type Horizon, type Transaction } from "@stellar/stellar-sdk";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AssetRef, NetworkConfig } from "@/config";
import { addAmounts, compareAmounts, fromStroops, toStroops } from "./amount";
import { balanceOf, getServer, type AccountSummary } from "./horizon";

export function toAsset(ref: AssetRef): Asset {
  return ref.issuer === null ? Asset.native() : new Asset(ref.code, ref.issuer);
}

/** MEMO_TEXT is at most 28 BYTES. Refuse, never truncate (a cut memo pays the wrong session). */
export function checkMemoText(memo: string): void {
  if (new TextEncoder().encode(memo).length > 28) throw new Error("memo longer than 28 bytes");
}

/** The highest fee per operation the app offers, in stroops (0.001 XLM). */
export const MAX_FEE_STROOPS = 10_000;

/**
 * The fee to bid per operation, in stroops, from Horizon's /fee_stats. A
 * transaction pays what it took to get into the ledger, not its bid, so bid
 * what recent ledgers charged (p90), or what most senders bid when ledgers
 * are nearly full (surge pricing). Capped so a bad answer cannot drain the
 * user; paymentFunds reserves the cap. fee_charged also counts contract
 * calls' resource fees, so the bid often reaches the cap (on testnet it
 * does); that costs nothing, the ledger still charges the inclusion price.
 * Not fetchBaseFee(): that is the network base fee (100 stroops) whatever
 * ledgers are charging.
 */
export function feeBid(stats: Horizon.HorizonApi.FeeStatsResponse): number {
  const stroops = (v: string | undefined) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.ceil(x) : 0;
  };
  let bid = Math.max(stroops(stats.last_ledger_base_fee), stroops(stats.fee_charged?.p90));
  if (Number(stats.ledger_capacity_usage) >= 0.9) bid = Math.max(bid, stroops(stats.max_fee?.mode));
  return Math.min(Math.max(bid, Number(BASE_FEE)), MAX_FEE_STROOPS);
}

async function fee(net: NetworkConfig): Promise<string> {
  try {
    return String(feeBid(await getServer(net).feeStats()));
  } catch {
    return BASE_FEE;
  }
}

export interface PaymentParams {
  net: NetworkConfig;
  /** The user's G... address (the payment source). */
  source: string;
  destination: string;
  asset: AssetRef;
  /** Decimal string, max 7 decimals, > 0. */
  amount: string;
  /** MEMO_TEXT (the station session memo). */
  memo?: string;
  /** Seconds the signed tx stays valid. */
  timeoutSec?: number;
}

export async function buildPaymentTx(p: PaymentParams): Promise<Transaction> {
  if (toStroops(p.amount) <= 0n) throw new Error("amount must be > 0");
  if (p.memo !== undefined) checkMemoText(p.memo);
  const account = await getServer(p.net).loadAccount(p.source);
  const b = new TransactionBuilder(account, { fee: await fee(p.net), networkPassphrase: p.net.passphrase })
    .addOperation(Operation.payment({ destination: p.destination, asset: toAsset(p.asset), amount: p.amount }))
    .setTimeout(p.timeoutSec ?? 180);
  if (p.memo !== undefined) b.addMemo(Memo.text(p.memo));
  return b.build();
}

export interface PaymentFunds {
  /** Spendable balance of the asset; null without a trustline. */
  balance: string | null;
  /** The asset balance covers the amount (and the fee, for XLM). */
  coversAmount: boolean;
  /** Paying in an issued asset, but spendable XLM does not cover the fee. */
  feeShort: boolean;
  enough: boolean;
}

/**
 * Whether the account can send a one-operation payment of `amount`. The fee
 * is always paid in XLM above the reserve, also for an issued asset such as
 * USDC, or the ledger rejects it (tx_insufficient_balance). `feeStroops`:
 * the most the transaction may cost (a contract call's is higher).
 */
export function paymentFunds(summary: AccountSummary, asset: AssetRef, amount: string, feeStroops: bigint = BigInt(MAX_FEE_STROOPS)): PaymentFunds {
  const fee = fromStroops(feeStroops);
  const balance = balanceOf(summary, asset);
  const needed = asset.issuer === null ? addAmounts(amount, fee) : amount;
  const coversAmount = balance !== null && compareAmounts(needed, balance) <= 0;
  const feeShort = asset.issuer !== null && compareAmounts(fee, summary.spendableXlm) > 0;
  return { balance, coversAmount, feeShort, enough: coversAmount && !feeShort };
}

/** Add a trustline so the account can hold `asset` (e.g. USDC). Costs 0.5 XLM of reserve. */
export async function buildTrustlineTx(p: { net: NetworkConfig; source: string; asset: AssetRef & { issuer: string } }): Promise<Transaction> {
  const account = await getServer(p.net).loadAccount(p.source);
  return new TransactionBuilder(account, { fee: await fee(p.net), networkPassphrase: p.net.passphrase })
    .addOperation(Operation.changeTrust({ asset: toAsset(p.asset) }))
    .setTimeout(180)
    .build();
}

export type SubmitErrorKind =
  /** The network rejected it: nothing happened, safe to fix and retry. */
  | "rejected"
  /** No answer: it MAY have gone through. Check history before paying again. */
  | "unknown";

export class SubmitError extends Error {
  constructor(
    public kind: SubmitErrorKind,
    /** Horizon result codes, e.g. { transaction: "tx_failed", operations: ["op_underfunded"] }. */
    public resultCodes?: { transaction?: string; operations?: string[] },
    public hash?: string,
  ) {
    super(kind === "rejected" ? `rejected: ${resultCodes?.transaction ?? "unknown"} ${resultCodes?.operations?.join(",") ?? ""}` : "outcome unknown");
    this.name = "SubmitError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Submit a signed transaction. On a timeout or network error it does NOT
 * resubmit blindly: it polls the hash for about 30 s, then throws
 * SubmitError("unknown") if still unseen. The transaction may still land
 * until its time bound: awaitTxOutcome waits that long.
 */
export async function submitTx(net: NetworkConfig, tx: Transaction | FeeBumpTransaction): Promise<{ hash: string; ledger: number }> {
  const server = getServer(net);
  // hash() is a plain Uint8Array (SDK 17): its toString() is not hex.
  const hash = bytesToHex(tx.hash());
  try {
    const r = await server.submitTransaction(tx);
    return { hash: r.hash, ledger: r.ledger };
  } catch (e) {
    const data = (e as { response?: { status?: number; data?: { extras?: { result_codes?: SubmitError["resultCodes"] } } } }).response;
    const codes = data?.data?.extras?.result_codes;
    if (codes && data?.status === 400) throw new SubmitError("rejected", codes, hash);
    // 504 / network error / other: find out what happened before telling the user.
    for (let i = 0; i < 10; i++) {
      await sleep(3000);
      try {
        const t = await server.transactions().transaction(hash).call();
        if (t.successful) return { hash, ledger: t.ledger_attr };
        throw new SubmitError("rejected", undefined, hash);
      } catch (pollErr) {
        if (pollErr instanceof SubmitError) throw pollErr;
        /* not found yet: keep polling */
      }
    }
    throw new SubmitError("unknown", undefined, hash);
  }
}

const notFound = (e: unknown) => e instanceof NotFoundError || (e as { response?: { status?: number } })?.response?.status === 404;

/**
 * After a SubmitError "unknown": poll the hash until a ledger has closed
 * after the transaction's `maxTime` (unix s), when it can no longer be
 * applied. The answer is then certain: { hash, ledger } if it landed,
 * SubmitError "rejected" if it failed, or "rejected" with tx_too_late if it
 * never landed (nothing happened, safe to sign again). Horizon still without
 * an answer `giveUpSec` after maxTime, by this device's clock (or no time
 * bound): SubmitError "unknown".
 */
export async function awaitTxOutcome(net: NetworkConfig, hash: string, maxTime: number, pollMs = 5000, giveUpSec = 300): Promise<{ hash: string; ledger: number }> {
  const server = getServer(net);
  for (;;) {
    if (!(maxTime > 0) || Date.now() / 1000 > maxTime + giveUpSec) throw new SubmitError("unknown", undefined, hash);
    // The newest ledger first: a transaction still not found once one closed after maxTime never lands.
    let closedAt = NaN;
    try {
      const page = await server.ledgers().order("desc").limit(1).call();
      closedAt = Date.parse(page.records[0]?.closed_at ?? "") / 1000;
    } catch {
      /* no answer: poll again */
    }
    try {
      const t = await server.transactions().transaction(hash).call();
      if (t.successful) return { hash, ledger: t.ledger_attr };
      throw new SubmitError("rejected", undefined, hash);
    } catch (e) {
      if (e instanceof SubmitError) throw e;
      if (notFound(e) && closedAt > maxTime) throw new SubmitError("rejected", { transaction: "tx_too_late" }, hash);
    }
    await sleep(pollMs);
  }
}
