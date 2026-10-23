/** SEP-10 challenge verification (kept free of wallet imports so it is unit-testable). */
import { WebAuth, type Transaction } from "@stellar/stellar-sdk";

export class ChallengeError extends Error {
  constructor(reason: string) {
    super(`invalid SEP-10 challenge: ${reason}`);
    this.name = "ChallengeError";
  }
}

/**
 * Check a SEP-10 challenge before signing it (SEP-10 "Verification"):
 * sequence 0, source = the anchor's SIGNING_KEY, signed by it, manage_data
 * ops only, first op `<home_domain> auth` sourced by OUR account, valid time
 * bounds, web_auth_domain = the auth endpoint host, network passphrase. On
 * top of the SDK checks: it must be for our account, carry no memo, no
 * client_domain op (we never ask for one) and no signature but the server's.
 * Throws ChallengeError on anything else.
 */
export function validateChallenge(
  challengeXdr: string,
  opts: { serverKey: string; passphrase: string; homeDomain: string; webAuthEndpoint: string; account: string; serverPassphrase?: string },
): Transaction {
  try {
    if (opts.serverPassphrase !== undefined && opts.serverPassphrase !== opts.passphrase) throw new Error("network passphrase mismatch");
    const webAuthDomain = new URL(opts.webAuthEndpoint).host;
    const { tx, clientAccountID, memo } = WebAuth.readChallengeTx(challengeXdr, opts.serverKey, opts.passphrase, opts.homeDomain, webAuthDomain);
    if (clientAccountID !== opts.account) throw new Error("challenge is for another account");
    if (memo) throw new Error("unexpected memo");
    for (const op of tx.operations) {
      if (op.type !== "manageData") throw new Error("non manage_data operation");
      if (op.name === "client_domain") throw new Error("unexpected client_domain");
    }
    if (tx.operations[0].source !== opts.account) throw new Error("first operation is not ours");
    if (tx.signatures.length !== 1) throw new Error("unexpected signatures");
    return tx;
  } catch (e) {
    throw new ChallengeError(e instanceof Error ? e.message : String(e));
  }
}
