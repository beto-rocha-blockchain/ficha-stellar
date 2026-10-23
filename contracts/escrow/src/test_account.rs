#![cfg(test)]
//! A smart account pays. The payer can be a contract account (`C...`): the
//! escrow only asks `payer.require_auth()`, so Soroban runs that account's
//! own `__check_auth` with the hash of what it authorizes. Here a minimal
//! one that holds a secp256r1 public key (the curve passkeys use) and checks
//! a signature over that hash, as a passkey wallet's account contract does
//! (a real one also unwraps the WebAuthn envelope around it). Real
//! signatures throughout: no mocked auth in the calls under test.
extern crate std;

use super::test::{chain, sess, setup, T};
use super::*;
use p256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl,
    crypto::Hash,
    xdr::{self, WriteXdr},
    Address, Bytes, BytesN, Env, IntoVal, Symbol, TryFromVal, Val, Vec,
};
use std::vec;

type List<T> = std::vec::Vec<T>;

const XLM: i128 = 10_000_000;

#[contract]
pub struct PasskeyAccount;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AccountError {
    NoKey = 1,
}

#[contractimpl]
impl PasskeyAccount {
    pub fn __constructor(env: Env, public_key: BytesN<65>) {
        env.storage().instance().set(&symbol_short!("pk"), &public_key);
    }
}

#[contractimpl]
impl CustomAccountInterface for PasskeyAccount {
    type Signature = BytesN<64>;
    type Error = AccountError;

    /// Any call this account authorizes needs a signature by its key over
    /// the payload (which covers the call, its arguments and sub-calls).
    #[allow(non_snake_case)]
    fn __check_auth(env: Env, signature_payload: Hash<32>, signature: BytesN<64>, _contexts: Vec<Context>) -> Result<(), AccountError> {
        let pk: BytesN<65> = env.storage().instance().get(&symbol_short!("pk")).ok_or(AccountError::NoKey)?;
        env.crypto().secp256r1_verify(&pk, &signature_payload, &signature);
        Ok(())
    }
}

/// A passkey: a secp256r1 key pair.
struct Passkey(SigningKey);

impl Passkey {
    fn new(seed: u8) -> Self {
        Passkey(SigningKey::from_slice(&[seed; 32]).unwrap())
    }

    fn public(&self, env: &Env) -> BytesN<65> {
        let point = self.0.verifying_key().to_encoded_point(false);
        BytesN::from_array(env, point.as_bytes().try_into().unwrap())
    }

    fn sign(&self, env: &Env, payload: &[u8; 32]) -> BytesN<64> {
        let sig: Signature = self.0.sign_prehash(payload).unwrap();
        let sig = sig.normalize_s().unwrap_or(sig); // Soroban takes low-S only
        let mut raw = [0u8; 64];
        raw.copy_from_slice(&sig.to_bytes());
        BytesN::from_array(env, &raw)
    }
}

fn sc<V: IntoVal<Env, Val>>(env: &Env, v: V) -> xdr::ScVal {
    xdr::ScVal::try_from_val(env, &v.into_val(env)).unwrap()
}

fn sc_address(env: &Env, a: &Address) -> xdr::ScAddress {
    match sc(env, a.clone()) {
        xdr::ScVal::Address(x) => x,
        other => panic!("not an address: {other:?}"),
    }
}

/// One call in an authorization tree.
fn call(env: &Env, contract: &Address, fn_name: &str, args: List<xdr::ScVal>, sub: List<xdr::SorobanAuthorizedInvocation>) -> xdr::SorobanAuthorizedInvocation {
    xdr::SorobanAuthorizedInvocation {
        function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
            contract_address: sc_address(env, contract),
            function_name: xdr::ScSymbol(fn_name.try_into().unwrap()),
            args: args.try_into().unwrap(),
        }),
        sub_invocations: sub.try_into().unwrap(),
    }
}

/// `account`'s authorization of `root`, signed with `key` as a wallet signs
/// it: over the hash of the network, a nonce, an expiry and the call tree.
fn signed(env: &Env, account: &Address, key: &Passkey, nonce: i64, root: xdr::SorobanAuthorizedInvocation) -> xdr::SorobanAuthorizationEntry {
    let expiry = env.ledger().sequence() + 100;
    let preimage = xdr::HashIdPreimage::SorobanAuthorization(xdr::HashIdPreimageSorobanAuthorization {
        network_id: xdr::Hash(env.ledger().network_id().to_array()),
        nonce,
        signature_expiration_ledger: expiry,
        invocation: root.clone(),
    });
    let payload = env.crypto().sha256(&Bytes::from_slice(env, &preimage.to_xdr(xdr::Limits::none()).unwrap())).to_array();
    xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
            address: sc_address(env, account),
            nonce,
            signature_expiration_ledger: expiry,
            signature: sc(env, key.sign(env, &payload)),
        }),
        root_invocation: root,
    }
}

/// deposit(payer, ...) with the token's transfer into the escrow under it.
fn deposit_tree(t: &T, payer: &Address, s: &Symbol, fichas: u32, anchor: &BytesN<32>) -> xdr::SorobanAuthorizedInvocation {
    let e = &t.env;
    let args = vec![
        sc(e, payer.clone()),
        sc(e, t.host.clone()),
        sc(e, t.st.clone()),
        sc(e, s.clone()),
        sc(e, fichas),
        sc(e, anchor.clone()),
        sc(e, t.terms()),
    ];
    let transfer = call(e, &t.cfg.token, "transfer", vec![sc(e, payer.clone()), sc(e, t.c.address.clone()), sc(e, t.cfg.price * fichas as i128)], vec![]);
    call(e, &t.c.address, "deposit", args, vec![transfer])
}

fn claim_tree(t: &T, s: &Symbol, anchor: &BytesN<32>, units: u32, proof: &BytesN<32>) -> xdr::SorobanAuthorizedInvocation {
    let e = &t.env;
    let args = vec![sc(e, t.host.clone()), sc(e, t.st.clone()), sc(e, s.clone()), sc(e, anchor.clone()), sc(e, units), sc(e, proof.clone())];
    call(e, &t.c.address, "claim", args, vec![])
}

/// A wallet that is a contract: its account contract, holding 10 XLM.
fn wallet(t: &T, key: &Passkey) -> Address {
    t.env.mock_all_auths();
    let account = t.env.register(PasskeyAccount, (key.public(&t.env),));
    t.sac().mint(&account, &(10 * XLM));
    account
}

/// A contract account deposits, tops up and claims its refund with its own
/// signatures, as a G account does; the host's share is owed as usual.
#[test]
fn a_smart_account_pays_tops_up_and_claims() {
    let t = setup();
    let key = Passkey::new(7);
    let me = wallet(&t, &key);
    let ch = chain(&t.env, 71, 120);
    let a = &ch[120];
    let s = sess(&t.env, "FSMART01");
    t.env.set_auths(&[signed(&t.env, &me, &key, 1, deposit_tree(&t, &me, &s, 2, a))]);
    let d = t.c.deposit(&me, &t.host, &t.st, &s, &2, a, &t.terms());
    assert_eq!(d, 1_000_000 + 600 + 1680);
    t.env.set_auths(&[signed(&t.env, &me, &key, 2, deposit_tree(&t, &me, &s, 1, a))]);
    t.c.deposit(&me, &t.host, &t.st, &s, &1, a, &t.terms());
    let open = t.c.session(&t.host, &t.st, &s, a).unwrap();
    assert_eq!((open.payer.clone(), open.fichas, open.amount), (me.clone(), 3, 3 * XLM));
    assert_eq!(t.tok.balance(&me), 7 * XLM);
    // 10 of the 30 units paid back, with the station's proof.
    t.env.set_auths(&[signed(&t.env, &me, &key, 3, claim_tree(&t, &s, a, 10, &ch[110]))]);
    assert_eq!(t.c.claim(&t.host, &t.st, &s, a, &10, &ch[110]), XLM);
    assert_eq!(t.tok.balance(&me), 8 * XLM);
    assert_eq!(t.c.owed(&t.host, &t.cfg.token), 2 * XLM);
    assert!(t.c.session(&t.host, &t.st, &s, a).is_none());
}

/// Only that account, with its own key, can claim the session it paid: not
/// another key on the same account, and not another account, however
/// validly it signs its own authorization.
#[test]
fn only_the_smart_account_that_paid_can_claim() {
    let t = setup();
    let key = Passkey::new(8);
    let me = wallet(&t, &key);
    let thief_key = Passkey::new(9);
    let thief = wallet(&t, &thief_key);
    let ch = chain(&t.env, 72, 120);
    let a = &ch[120];
    let s = sess(&t.env, "FSMART02");
    t.env.set_auths(&[signed(&t.env, &me, &key, 1, deposit_tree(&t, &me, &s, 2, a))]);
    t.c.deposit(&me, &t.host, &t.st, &s, &2, a, &t.terms());
    let full = claim_tree(&t, &s, a, 20, &ch[100]);
    // The payer's address, signed with another key: __check_auth refuses it.
    t.env.set_auths(&[signed(&t.env, &me, &thief_key, 2, full.clone())]);
    assert!(t.c.try_claim(&t.host, &t.st, &s, a, &20, &ch[100]).is_err());
    // Another account, with its own valid signature: not the session's payer.
    t.env.set_auths(&[signed(&t.env, &thief, &thief_key, 1, full.clone())]);
    assert!(t.c.try_claim(&t.host, &t.st, &s, a, &20, &ch[100]).is_err());
    assert!(t.c.session(&t.host, &t.st, &s, a).is_some());
    assert_eq!((t.tok.balance(&me), t.tok.balance(&thief)), (8 * XLM, 10 * XLM));
    // A deposit the account did not sign as called (3 fichas, signed for 2) fails too.
    let s2 = sess(&t.env, "FSMART03");
    t.env.set_auths(&[signed(&t.env, &me, &key, 3, deposit_tree(&t, &me, &s2, 2, a))]);
    assert!(t.c.try_deposit(&me, &t.host, &t.st, &s2, &3, a, &t.terms()).is_err());
    assert!(t.c.session(&t.host, &t.st, &s2, a).is_none());
    // The payer's own signature does it: the full refund.
    t.env.set_auths(&[signed(&t.env, &me, &key, 4, full)]);
    assert_eq!(t.c.claim(&t.host, &t.st, &s, a, &20, &ch[100]), 2 * XLM);
    assert_eq!(t.tok.balance(&me), 10 * XLM);
}
