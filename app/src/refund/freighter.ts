/**
 * A refund signed by the Freighter browser extension, as the host
 * (src/refund/request.ts). The host's key never touches the app: Freighter
 * signs the transaction built here, and the app checks that what came back
 * is that same transaction, signed by the host, before it submits it.
 *
 *   const s = await connectFreighter();                  // asks for access once
 *   freighterBlocks(s, r.net, station.host_key);         // [] = right network and account
 *   const { hash } = await sendRefund(r, station.host_key);
 */
import { getAddress, getNetworkDetails, isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";
import { FeeBumpTransaction, Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { bytesToHex } from "@noble/hashes/utils.js";
import { shortAddress } from "@/lib/format";
import { buildPaymentTx, submitTx } from "@/stellar/tx";
import type { NetworkConfig } from "@/config";
import { networkFor, type RefundRequest } from "./request";

export class FreighterError extends Error {
  constructor(
    public code:
      /** No Freighter extension in this browser (or it does not answer). */
      | "not_installed"
      /** Access or signing refused, or Freighter failed: its own message. */
      | "refused"
      /** Freighter signed something else, or not as the host: nothing is submitted. */
      | "bad_signature",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "FreighterError";
  }
}

export interface FreighterSession {
  address: string;
  /** Freighter's name for its network ("PUBLIC", "TESTNET", ...). */
  network: string;
  networkPassphrase: string;
}

async function session(address: () => ReturnType<typeof getAddress>): Promise<FreighterSession> {
  const c = await isConnected();
  if (c.error || !c.isConnected) throw new FreighterError("not_installed", c.error?.message);
  const a = await address();
  if (a.error || !a.address) throw new FreighterError("refused", a.error?.message);
  const n = await getNetworkDetails();
  if (n.error) throw new FreighterError("refused", n.error.message);
  return { address: a.address, network: n.network, networkPassphrase: n.networkPassphrase };
}

/** The account and network selected in Freighter, asking the host to allow this site the first time. */
export function connectFreighter(): Promise<FreighterSession> {
  return session(requestAccess);
}

/** The same, without a prompt: right before signing, the host may have switched account or network. */
export function readFreighter(): Promise<FreighterSession> {
  return session(getAddress);
}

/** Why Freighter's selection cannot sign this refund: the message keys and values; [] when it can. */
export function freighterBlocks(s: FreighterSession, net: NetworkConfig, hostKey: string): { key: string; vars: Record<string, string> }[] {
  const out: { key: string; vars: Record<string, string> }[] = [];
  if (s.networkPassphrase !== net.passphrase) {
    out.push({ key: "wrongNetwork", vars: { got: networkFor(s.networkPassphrase)?.label ?? (s.network || "?"), want: net.label } });
  }
  if (s.address !== hostKey) out.push({ key: "wrongAccount", vars: { got: shortAddress(s.address, 6, 6), want: shortAddress(hostKey, 6, 6) } });
  return out;
}

/** The refund payment: from the host, the same fee policy and 180 s time bound as the app's own payments. */
export function buildRefundTx(r: RefundRequest, hostKey: string): Promise<Transaction> {
  return buildPaymentTx({
    net: r.net,
    source: hostKey,
    destination: r.req.destination,
    asset: r.req.asset,
    amount: r.amount,
    memo: r.req.memo,
    timeoutSec: 180,
  });
}

/** Freighter signs `tx` as the host; anything but that same transaction with the host's signature is refused. */
export async function signWithFreighter(tx: Transaction, net: NetworkConfig, hostKey: string): Promise<Transaction> {
  const res = await signTransaction(tx.toXDR(), { networkPassphrase: net.passphrase, address: hostKey });
  if (res.error || !res.signedTxXdr) throw new FreighterError("refused", res.error?.message);
  if (res.signerAddress && res.signerAddress !== hostKey) throw new FreighterError("bad_signature", "signed by another account");
  let signed: Transaction | FeeBumpTransaction;
  try {
    signed = TransactionBuilder.fromXDR(res.signedTxXdr, net.passphrase);
  } catch {
    throw new FreighterError("bad_signature", "not a transaction");
  }
  // The hash covers everything but the signatures: the same hash is the same payment.
  if (signed instanceof FeeBumpTransaction || bytesToHex(signed.hash()) !== bytesToHex(tx.hash())) {
    throw new FreighterError("bad_signature", "another transaction");
  }
  const host = Keypair.fromPublicKey(hostKey);
  const hash = signed.hash();
  const ok = signed.signatures.some((s) => {
    try {
      return host.verify(hash, s.signature);
    } catch {
      return false;
    }
  });
  if (!ok) throw new FreighterError("bad_signature", "no signature by the host");
  return signed;
}

/**
 * Build, sign in Freighter and submit, once. A SubmitError "unknown" means
 * it MAY have gone through: the caller never sends it again on its own.
 * `onSigned`: Freighter has signed, the submit starts.
 */
export async function sendRefund(r: RefundRequest, hostKey: string, onSigned?: () => void): Promise<{ hash: string; ledger: number }> {
  const tx = await buildRefundTx(r, hostKey);
  const signed = await signWithFreighter(tx, r.net, hostKey);
  onSigned?.();
  return submitTx(r.net, signed);
}
