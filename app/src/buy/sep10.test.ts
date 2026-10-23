import { Account, Asset, Keypair, Memo, Networks, Operation, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { ChallengeError, validateChallenge } from "./sep10";

const server = Keypair.random();
const client = Keypair.random();
const HOME = "testanchor.stellar.org";
const AUTH = "https://testanchor.stellar.org/auth";
const opts = {
  serverKey: server.publicKey(),
  passphrase: Networks.TESTNET,
  homeDomain: HOME,
  webAuthEndpoint: AUTH,
  account: client.publicKey(),
};

const good = () => WebAuth.buildChallengeTx(server, client.publicKey(), HOME, 300, Networks.TESTNET, HOME);
const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64");

/** Hand-built challenge, to break one rule at a time. */
function custom(edit: (b: TransactionBuilder) => void, opt: { sequence?: string; signer?: Keypair; timeout?: number } = {}): string {
  const b = new TransactionBuilder(new Account(server.publicKey(), opt.sequence ?? "-1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.manageData({ name: `${HOME} auth`, value: nonce(), source: client.publicKey() }))
    .addOperation(Operation.manageData({ name: "web_auth_domain", value: HOME, source: server.publicKey() }))
    .setTimeout(opt.timeout ?? 300);
  edit(b);
  const tx = b.build();
  tx.sign(opt.signer ?? server);
  return tx.toXdr();
}

describe("validateChallenge (SEP-10)", () => {
  it("accepts a correct challenge", () => {
    const tx = validateChallenge(good(), opts);
    expect(tx.operations[0].source).toBe(client.publicKey());
    expect(tx.signatures).toHaveLength(1);
    expect(validateChallenge(custom(() => {}), opts).sequence).toBe("0");
  });

  it("rejects a challenge for another account", () => {
    expect(() => validateChallenge(good(), { ...opts, account: Keypair.random().publicKey() })).toThrow(ChallengeError);
  });

  it("rejects a challenge not signed by the anchor's SIGNING_KEY", () => {
    expect(() => validateChallenge(custom(() => {}, { signer: Keypair.random() }), opts)).toThrow(/not signed by server/);
    expect(() => validateChallenge(good(), { ...opts, serverKey: Keypair.random().publicKey() })).toThrow(ChallengeError);
  });

  it("rejects the wrong network", () => {
    expect(() => validateChallenge(good(), { ...opts, passphrase: Networks.PUBLIC })).toThrow(ChallengeError);
    expect(() => validateChallenge(good(), { ...opts, serverPassphrase: Networks.PUBLIC })).toThrow(/passphrase/);
  });

  it("rejects the wrong home domain or web_auth_domain", () => {
    expect(() => validateChallenge(good(), { ...opts, homeDomain: "evil.example" })).toThrow(ChallengeError);
    expect(() => validateChallenge(good(), { ...opts, webAuthEndpoint: "https://evil.example/auth" })).toThrow(/web_auth_domain/);
  });

  it("rejects a non-zero sequence (a real, spendable transaction)", () => {
    expect(() => validateChallenge(custom(() => {}, { sequence: "41" }), opts)).toThrow(/sequence/);
  });

  it("rejects any operation that is not manage_data", () => {
    const pay = custom((b) =>
      b.addOperation(Operation.payment({ destination: server.publicKey(), asset: Asset.native(), amount: "1", source: client.publicKey() })),
    );
    expect(() => validateChallenge(pay, opts)).toThrow(ChallengeError);
  });

  it("rejects extra operations sourced by our account", () => {
    const extra = custom((b) => b.addOperation(Operation.manageData({ name: "x", value: "y", source: client.publicKey() })));
    expect(() => validateChallenge(extra, opts)).toThrow(ChallengeError);
  });

  it("rejects a client_domain operation we did not ask for", () => {
    const cd = custom((b) => b.addOperation(Operation.manageData({ name: "client_domain", value: "evil.example", source: Keypair.random().publicKey() })));
    expect(() => validateChallenge(cd, opts)).toThrow(/client_domain/);
  });

  it("rejects a memo", () => {
    expect(() => validateChallenge(custom((b) => b.addMemo(Memo.id("7"))), opts)).toThrow(/memo/);
  });

  it("rejects an expired or infinite challenge", () => {
    expect(() => validateChallenge(custom(() => {}, { timeout: 0 }), opts)).toThrow(ChallengeError);
    const old = new TransactionBuilder(new Account(server.publicKey(), "-1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: 1, maxTime: 1000 },
    })
      .addOperation(Operation.manageData({ name: `${HOME} auth`, value: nonce(), source: client.publicKey() }))
      .build();
    old.sign(server);
    expect(() => validateChallenge(old.toXdr(), opts)).toThrow(/expired/);
  });

  it("rejects a challenge that already carries another signature", () => {
    const xdr = custom(() => {});
    const tx = TransactionBuilder.fromXdr(xdr, Networks.TESTNET);
    tx.sign(Keypair.random());
    expect(() => validateChallenge(tx.toXdr(), opts)).toThrow(/signatures/);
  });

  it("rejects garbage", () => {
    expect(() => validateChallenge("AAAA", opts)).toThrow(ChallengeError);
  });
});
