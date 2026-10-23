#![cfg(test)]
//! R2C1: nothing the host does to its account can fail a claim.
//!
//! A Soroban transaction may touch only the ledger entries its footprint
//! names, read-only or read-write, and the footprint is fixed when the payer
//! simulates the claim. A claim that paid the host put the host's balance
//! (or account, or trustline) in it as it stood then, and the `owed` entry
//! only when that transfer failed. A host that changed its account between
//! the simulation and the ledger (one classic operation per ledger, or a
//! watcher racing each claim) then failed the whole claim on the footprint,
//! the payer's refund included, and took everything at release.
//!
//! The SDK's test env records a fresh footprint at each top-level call, as a
//! simulation does. A harness contract makes one top-level call that (1) runs
//! a claim the way the simulation sees it, recording the footprint, (2) lets
//! the host's balance change underneath, without touching the footprint,
//! and (3) switches storage to enforcing, as the ledger applies the
//! transaction, and claims a second session of the same shape.
extern crate std;

use super::test::{chain, sess, setup, terms_of};
use super::*;
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl,
    testutils::{Address as _, Events as _, IssuerFlags, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, xdr, Address, BytesN, Env, IntoVal, Symbol, TryFromVal, Val,
};
use soroban_env_host::storage::AccessType;
use std::{cell::RefCell, rc::Rc};

const XLM: i128 = 10_000_000;

type Entry = (xdr::LedgerKey, xdr::LedgerEntry, Option<u32>);

std::thread_local! {
    /// The host's balance entry as it stands when the claim applies.
    static AT_APPLY: RefCell<Option<Entry>> = const { RefCell::new(None) };
}

#[contract]
pub struct Harness;

#[contractimpl]
impl Harness {
    /// Pays (as the payer) and claims two sessions of the same shape: the
    /// first as the simulation sees it, the second as the ledger applies
    /// it, with the host's balance changed in between. Returns what the
    /// applied claim refunded, what the host is then owed, and the host's
    /// and the payer's balances (read here: storage stays enforcing after).
    #[allow(clippy::too_many_arguments)]
    pub fn run(
        env: Env,
        escrow: Address,
        token: Address,
        host: Address,
        st: Symbol,
        a: BytesN<32>,
        p: BytesN<32>,
        terms: Terms,
    ) -> (i128, i128, i128, i128) {
        let c = FichaEscrowClient::new(&env, &escrow);
        let me = env.current_contract_address();
        let simulated = Symbol::new(&env, "FR2C0001");
        let applied = Symbol::new(&env, "FR2C0002");
        // A top-up of the applied session puts its key in the footprint,
        // read-write, as the real claim's simulation would.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (me.clone(), escrow.clone(), XLM).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);
        c.deposit(&me, &host, &st, &applied, &1, &a, &terms);
        // The simulation: everything else a claim of this shape touches.
        c.claim(&host, &st, &simulated, &a, &7, &p);
        // Between the simulation and the ledger the host changes its
        // balance. Written straight into storage: the footprint stays as the
        // simulation recorded it (an entry it already holds keeps its access;
        // one it lacks would only be readable).
        let (key, entry, live_until) = AT_APPLY.with(|e| e.borrow_mut().take()).unwrap();
        env.host().setup_storage_entry(Rc::new(key), Some((Rc::new(entry), live_until)), AccessType::ReadOnly).unwrap();
        // The ledger applies the claim with the simulated footprint.
        env.host().switch_to_enforcing_storage().unwrap();
        let back = c.claim(&host, &st, &applied, &a, &7, &p);
        let tok = TokenClient::new(&env, &token);
        (back, c.owed(&host, &token), tok.balance(&host), tok.balance(&me))
    }
}

/// The SAC's balance entry of `who`, and its value now.
fn balance_entry(env: &Env, token: &Address, who: &Address) -> Entry {
    let sc = |v: Val| xdr::ScVal::try_from_val(env, &v).unwrap();
    let xdr::ScVal::Address(contract) = sc(token.to_val()) else { unreachable!() };
    let key = xdr::LedgerKey::ContractData(xdr::LedgerKeyContractData {
        contract,
        key: sc(vec![env, Symbol::new(env, "Balance").to_val(), who.to_val()].to_val()),
        durability: xdr::ContractDataDurability::Persistent,
    });
    let snap = env.to_ledger_snapshot();
    let (_, (entry, live_until)) = snap.ledger_entries.iter().find(|(k, _)| **k == key).expect("the host's balance entry");
    (key, (**entry).clone(), *live_until)
}

/// One claim simulated with the host able (or not) to receive, applied with
/// it not (or able). Returns what the applied claim refunded, or None when
/// the whole transaction failed.
fn run(able_at_simulation: bool) -> Option<i128> {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    env.ledger().set_timestamp(1_000_000);
    let h = env.register(Harness, ());
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    let token = sac.address();
    let admin = StellarAssetClient::new(&env, &token);
    let tok = TokenClient::new(&env, &token);
    let host = Address::generate(&env);
    admin.mint(&h, &(20 * XLM));
    // The host's balance entry in both states: the one at the simulation is
    // left in the ledger, the other is what the claim meets when it applies.
    admin.set_authorized(&host, &!able_at_simulation);
    let at_apply = balance_entry(&env, &token, &host);
    admin.set_authorized(&host, &able_at_simulation);
    AT_APPLY.with(|e| *e.borrow_mut() = Some(at_apply));

    let id = env.register(FichaEscrow, ());
    let c = FichaEscrowClient::new(&env, &id);
    let cfg = StationCfg { token: token.clone(), price: XLM, ficha_secs: 300, max_fichas: 12, unit_secs: 30, grace_secs: 1680, active: true };
    let st = Symbol::new(&env, "K7M2QX");
    c.register(&host, &st, &cfg);
    let terms = terms_of(&cfg);
    let ch = chain(&env, 61, 120);
    let a = &ch[120];
    for s in ["FR2C0001", "FR2C0002"] {
        c.deposit(&h, &host, &st, &Symbol::new(&env, s), &2, a, &terms);
    }
    let before = tok.balance(&h);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        HarnessClient::new(&env, &h).try_run(&id, &token, &host, &st, a, &ch[113], &terms)
    }));
    match r {
        Ok(Ok(Ok((back, owed, host_balance, payer_balance)))) => {
            // Both claims refunded the payer (7 of 20 units of 2 XLM, then 7
            // of 30 of 3 XLM after the top-up); the host's shares are owed.
            assert_eq!(back, 7 * XLM / 10);
            assert_eq!(payer_balance, before - XLM + 2 * back);
            assert_eq!(owed, (2 * XLM - back) + (3 * XLM - back));
            assert_eq!(host_balance, 0);
            Some(back)
        }
        _ => None, // the whole transaction failed, the payer's refund with it
    }
}

/// The finding: the host could take its account away (here its balance
/// frozen, as with a deauthorized trustline; a merged XLM account under
/// 1 XLM fails the same way) after the payer simulated the claim. The claim
/// then read the `owed` entry outside its footprint, a failure no contract
/// can catch, and the payer's refund went with it.
#[test]
fn a_host_frozen_after_the_simulation_cannot_fail_the_claim() {
    assert_eq!(run(true), Some(7 * XLM / 10));
}

/// The other way round: frozen at the simulation (its balance only read),
/// able to receive when the claim applies, so a transfer to it would write
/// an entry the footprint holds read-only.
#[test]
fn a_host_unfrozen_after_the_simulation_cannot_fail_the_claim() {
    assert_eq!(run(false), Some(7 * XLM / 10));
}

/// A claim never moves anything to the host, whatever its account can take,
/// so it never touches the host's ledger entries.
#[test]
fn a_claim_never_pays_the_host_directly() {
    let t = setup();
    let ch = chain(&t.env, 62, 120);
    let a = &ch[120];
    for (i, able) in [true, false, true].into_iter().enumerate() {
        t.sac().set_authorized(&t.host, &able);
        let s = Symbol::new(&t.env, &std::format!("FR2CN{i:03}"));
        t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, a, &t.terms());
        t.c.claim(&t.host, &t.st, &s, a, &7, &ch[113]);
        // The only token movement is the payer's refund.
        let moved = t.env.events().all().filter_by_contract(&t.cfg.token);
        assert_eq!(moved.events().len(), 1, "claim {i}");
        assert_eq!(t.tok.balance(&t.host), 0, "claim {i}");
    }
    assert_eq!(t.c.owed(&t.host, &t.cfg.token), 3 * (2 * XLM - 7 * XLM / 10));
    // release and host_refund still pay a host that can take it at once.
    let s = sess(&t.env, "FR2CREL0");
    let d = t.c.deposit(&t.payer, &t.host, &t.st, &s, &1, a, &t.terms());
    t.env.ledger().set_timestamp(d + 1);
    t.c.release(&t.host, &t.st, &s, a);
    assert_eq!(t.tok.balance(&t.host), XLM);
}

/// The same race through `owed` itself: pay_host used to delete the entry,
/// so one landing between a claim's simulation (entry there: an update) and
/// the ledger (entry gone: a new one) made the claim pay rent for a new
/// entry it had not budgeted for, and fail. pay_host now leaves it at 0, so
/// a claim after it writes an entry of the same size and pays no new rent.
#[test]
fn a_pay_host_just_before_a_claim_changes_nothing_the_claim_pays_for() {
    let t = setup();
    let ch = chain(&t.env, 63, 120);
    let a = &ch[120];
    let [s1, s2, s3] = ["FR2CP001", "FR2CP002", "FR2CP003"].map(|x| sess(&t.env, x));
    for s in [&s1, &s2, &s3] {
        t.c.deposit(&t.payer, &t.host, &t.st, s, &2, a, &t.terms());
    }
    // The host's first owed share creates the entry: rent for a new entry.
    t.c.claim(&t.host, &t.st, &s1, a, &7, &ch[113]);
    let first = t.env.cost_estimate().fee().persistent_entry_rent;
    assert!(first > 0, "{first}");
    // The next claim only updates it.
    t.c.claim(&t.host, &t.st, &s2, a, &7, &ch[113]);
    assert_eq!(t.env.cost_estimate().fee().persistent_entry_rent, 0);
    // pay_host empties it but keeps it, so a claim after it is the same.
    assert_eq!(t.c.pay_host(&t.host, &t.cfg.token), 2 * (2 * XLM - 7 * XLM / 10));
    assert_eq!(t.c.owed(&t.host, &t.cfg.token), 0);
    assert_eq!(t.c.try_pay_host(&t.host, &t.cfg.token), Err(Ok(Error::NothingOwed)));
    t.c.claim(&t.host, &t.st, &s3, a, &7, &ch[113]);
    assert_eq!(t.env.cost_estimate().fee().persistent_entry_rent, 0);
    assert_eq!(t.c.owed(&t.host, &t.cfg.token), 2 * XLM - 7 * XLM / 10);
}
