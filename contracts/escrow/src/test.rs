#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, IssuerFlags, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env, Event as _, IntoVal, Symbol,
};
use std::vec::Vec;

const XLM: i128 = 10_000_000;

pub(crate) struct T<'a> {
    pub env: Env,
    pub c: FichaEscrowClient<'a>,
    pub tok: TokenClient<'a>,
    pub host: Address,
    pub payer: Address,
    pub st: Symbol,
    pub cfg: StationCfg,
}

impl T<'_> {
    /// The station's terms as the app reads them: what a deposit into a new
    /// session signs.
    pub fn terms(&self) -> Terms {
        terms_of(&self.cfg)
    }

    /// The asset's admin client (mint, and freeze or unfreeze a balance).
    pub fn sac(&self) -> StellarAssetClient<'_> {
        StellarAssetClient::new(&self.env, &self.cfg.token)
    }
}

/// A station's terms as a deposit's `terms` argument.
pub(crate) fn terms_of(cfg: &StationCfg) -> Terms {
    station_terms(cfg)
}

/// One station (1 XLM per 5-min ficha, at most 12, unit 30 s: a chain of
/// 120, grace 1680 s) and a payer holding 100 XLM. The asset's issuer may
/// freeze a balance (revocable), as USDC's can.
pub(crate) fn setup<'a>() -> T<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    let tok = TokenClient::new(&env, &sac.address());
    let host = Address::generate(&env);
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &sac.address()).mint(&payer, &(100 * XLM));
    let id = env.register(FichaEscrow, ());
    let c = FichaEscrowClient::new(&env, &id);
    let cfg = StationCfg {
        token: sac.address(),
        price: XLM,      // 1 XLM per ficha
        ficha_secs: 300, // 5 min
        max_fichas: 12,  // 60 min
        unit_secs: 30,   // chain of 120
        grace_secs: 180 + 600 + 900,
        active: true,
    };
    let st = Symbol::new(&env, "K7M2QX");
    c.register(&host, &st, &cfg);
    T { env, c, tok, host, payer, st, cfg }
}

/// The station's chain: c[0] = seed, c[i+1] = sha256(c[i]); anchor = c[n].
pub(crate) fn chain(env: &Env, seed: u8, n: u32) -> Vec<BytesN<32>> {
    chain_from(env, [seed; 32], n)
}

pub(crate) fn chain_from(env: &Env, seed: [u8; 32], n: u32) -> Vec<BytesN<32>> {
    let mut v = Vec::new();
    let mut h = BytesN::from_array(env, &seed);
    v.push(h.clone());
    for _ in 0..n {
        h = env.crypto().sha256(&Bytes::from(h)).to_bytes();
        v.push(h.clone());
    }
    v
}

pub(crate) fn sess(env: &Env, s: &str) -> Symbol {
    Symbol::new(env, s)
}

#[test]
fn partial_refund_with_proof() {
    let t = setup();
    let n = 120;
    let ch = chain(&t.env, 7, n);
    let a = &ch[n as usize];
    let s = sess(&t.env, "F3H9TXAB");
    let deadline = t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, a, &t.terms());
    assert_eq!(deadline, 1_000_000 + 600 + 1680);
    assert_eq!(t.tok.balance(&t.c.address), 2 * XLM);
    // Paid 600 s = 20 units; the station verified 400 s; unused 200 s -> 7 units (rounded up).
    t.env.ledger().set_timestamp(1_000_000 + 700);
    let u = 7u32;
    let back = t.c.claim(&t.host, &t.st, &s, a, &u, &ch[(n - u) as usize]);
    assert_eq!(back, 7 * XLM / 10); // 7/20 of 2 XLM
    assert_eq!(t.tok.balance(&t.payer), 98 * XLM + 7 * XLM / 10);
    // The claim never touches the host's account: its share is owed to it.
    let share = 2 * XLM - 7 * XLM / 10;
    assert_eq!(t.tok.balance(&t.host), 0);
    assert_eq!(t.c.owed(&t.host, &t.cfg.token), share);
    assert_eq!(t.tok.balance(&t.c.address), share);
    assert!(t.c.session(&t.host, &t.st, &s, a).is_none());
    // Anyone pays it out, to the host only.
    t.env.mock_auths(&[]);
    assert_eq!(t.c.pay_host(&t.host, &t.cfg.token), share);
    assert!(t.env.auths().is_empty());
    t.env.mock_all_auths();
    assert_eq!(t.tok.balance(&t.host), share);
    assert_eq!(t.tok.balance(&t.c.address), 0);
    assert_eq!(t.c.owed(&t.host, &t.cfg.token), 0);
    // Settles once.
    assert_eq!(t.c.try_claim(&t.host, &t.st, &s, a, &u, &ch[(n - u) as usize]), Err(Ok(Error::NoSession)));
    assert_eq!(t.c.try_release(&t.host, &t.st, &s, a), Err(Ok(Error::NoSession)));
}

#[test]
fn claim_needs_the_payer() {
    let t = setup();
    let ch = chain(&t.env, 1, 120);
    let s = sess(&t.env, "F2222222");
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &1, &ch[120], &t.terms());
    t.c.claim(&t.host, &t.st, &s, &ch[120], &10, &ch[110]);
    let auths = t.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, t.payer);
}

#[test]
fn cannot_claim_more_than_revealed() {
    let t = setup();
    let n = 120;
    let ch = chain(&t.env, 9, n);
    let a = &ch[n as usize];
    let s = sess(&t.env, "F3333333");
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, a, &t.terms());
    let revealed = ch[(n - 7) as usize].clone();
    // More units with the same proof: wrong.
    assert_eq!(t.c.try_claim(&t.host, &t.st, &s, a, &8, &revealed), Err(Ok(Error::BadProof)));
    // Beyond the chain: wrong whatever the proof (it would take a preimage of the seed).
    assert_eq!(t.c.try_claim(&t.host, &t.st, &s, a, &121, &ch[0]), Err(Ok(Error::BadProof)));
    // Beyond the longest chain a station may use: refused before any hashing.
    assert_eq!(t.c.try_claim(&t.host, &t.st, &s, a, &(MAX_CHAIN + 1), &ch[0]), Err(Ok(Error::BadProof)));
    assert_eq!(t.c.try_claim(&t.host, &t.st, &s, a, &u32::MAX, &ch[0]), Err(Ok(Error::BadProof)));
    // A proof for another anchor names no session.
    assert_eq!(t.c.try_claim(&t.host, &t.st, &s, &ch[119], &6, &ch[113]), Err(Ok(Error::NoSession)));
    // Hashing forward only ever gives proofs for FEWER units (worse for the payer).
    let fewer = t.env.crypto().sha256(&Bytes::from(revealed)).to_bytes();
    assert_eq!(t.c.claim(&t.host, &t.st, &s, a, &6, &fewer), 6 * XLM / 10);
}

#[test]
fn never_charged_full_refund() {
    let t = setup();
    let n = 120;
    let ch = chain(&t.env, 3, n);
    let s = sess(&t.env, "F4444444");
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &3, &ch[n as usize], &t.terms());
    // not_plugged: all 30 paid units unused.
    assert_eq!(t.c.claim(&t.host, &t.st, &s, &ch[n as usize], &30, &ch[(n - 30) as usize]), 3 * XLM);
    assert_eq!(t.tok.balance(&t.payer), 100 * XLM);
    assert_eq!(t.tok.balance(&t.host), 0);
}

#[test]
fn whole_chain_also_full_refund() {
    let t = setup();
    let ch = chain(&t.env, 4, 120);
    let s = sess(&t.env, "F5555555");
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &1, &ch[120], &t.terms());
    // Out of service: the station shows the seed itself.
    assert_eq!(t.c.claim(&t.host, &t.st, &s, &ch[120], &120, &ch[0]), XLM);
    assert_eq!(t.c.try_claim(&t.host, &t.st, &s, &ch[120], &121, &ch[0]), Err(Ok(Error::NoSession)));
}

#[test]
fn zero_units_settles_all_for_the_host_now() {
    let t = setup();
    let ch = chain(&t.env, 5, 120);
    let s = sess(&t.env, "F6666666");
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, &ch[120], &t.terms());
    assert_eq!(t.c.claim(&t.host, &t.st, &s, &ch[120], &0, &ch[120]), 0);
    assert!(t.c.session(&t.host, &t.st, &s, &ch[120]).is_none());
    assert_eq!(t.c.owed(&t.host, &t.cfg.token), 2 * XLM);
    assert_eq!(t.c.pay_host(&t.host, &t.cfg.token), 2 * XLM);
    assert_eq!(t.tok.balance(&t.host), 2 * XLM);
}

#[test]
fn deadline_releases_to_host() {
    let t = setup();
    let ch = chain(&t.env, 6, 120);
    let a = &ch[120];
    let s = sess(&t.env, "F7777777");
    let deadline = t.c.deposit(&t.payer, &t.host, &t.st, &s, &1, a, &t.terms());
    assert_eq!(t.c.try_release(&t.host, &t.st, &s, a), Err(Ok(Error::TooEarly)));
    t.env.ledger().set_timestamp(deadline + 1);
    assert_eq!(t.c.try_claim(&t.host, &t.st, &s, a, &10, &ch[110]), Err(Ok(Error::Expired)));
    assert_eq!(t.c.try_release(&t.host, &t.st, &s, &ch[119]), Err(Ok(Error::NoSession)));
    assert_eq!(t.c.release(&t.host, &t.st, &s, a), XLM);
    assert_eq!(t.tok.balance(&t.host), XLM);
    assert!(t.env.auths().is_empty()); // anyone may call it
}

#[test]
fn top_ups() {
    let t = setup();
    let ch = chain(&t.env, 8, 120);
    let a = &ch[120];
    let s = sess(&t.env, "F8888888");
    let d1 = t.c.deposit(&t.payer, &t.host, &t.st, &s, &1, a, &t.terms());
    t.env.ledger().set_timestamp(1_000_000 + 200);
    let d2 = t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, a, &t.terms());
    assert_eq!(d2, d1 + 600); // from the first deposit, not from the top-up
    // Another wallet with the same ID and anchor (a copied QR): the session is the payer's.
    let other = Address::generate(&t.env);
    t.sac().mint(&other, &(10 * XLM));
    assert_eq!(t.c.try_deposit(&other, &t.host, &t.st, &s, &1, a, &t.terms()), Err(Ok(Error::OtherPayer)));
    // 3 held, 12 at most: 10 more is too many, 9 fit.
    assert_eq!(t.c.try_deposit(&t.payer, &t.host, &t.st, &s, &10, a, &t.terms()), Err(Ok(Error::BadFichas)));
    assert_eq!(t.c.try_deposit(&t.payer, &t.host, &t.st, &s, &0, a, &t.terms()), Err(Ok(Error::BadFichas)));
    assert_eq!(t.c.try_deposit(&t.payer, &t.host, &t.st, &s, &u32::MAX, a, &t.terms()), Err(Ok(Error::BadFichas)));
    let got = t.c.session(&t.host, &t.st, &s, a).unwrap();
    assert_eq!((got.fichas, got.amount, got.deadline), (3, 3 * XLM, d2));
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &9, a, &t.terms());
    assert_eq!(t.c.try_deposit(&t.payer, &t.host, &t.st, &s, &1, a, &t.terms()), Err(Ok(Error::BadFichas)));
    assert_eq!(t.tok.balance(&t.c.address), 12 * XLM);
    // The same ID with another anchor is another session, whoever pays it.
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &1, &ch[119], &t.terms());
    assert_eq!(t.c.session(&t.host, &t.st, &s, &ch[119]).unwrap().fichas, 1);
    assert_eq!(t.c.session(&t.host, &t.st, &s, a).unwrap().fichas, 12);
    // A first deposit above the most a session holds.
    let s2 = sess(&t.env, "F8888889");
    assert_eq!(t.c.try_deposit(&t.payer, &t.host, &t.st, &s2, &13, a, &t.terms()), Err(Ok(Error::BadFichas)));
    // Unknown station: another ID, or the same ID under another host.
    let nowhere = Symbol::new(&t.env, "ZZZZZZ");
    assert_eq!(t.c.try_deposit(&t.payer, &t.host, &nowhere, &s2, &1, a, &t.terms()), Err(Ok(Error::UnknownStation)));
    assert_eq!(t.c.try_deposit(&t.payer, &other, &t.st, &s2, &1, a, &t.terms()), Err(Ok(Error::UnknownStation)));
}

#[test]
fn host_refund_rules() {
    let t = setup();
    let ch = chain(&t.env, 2, 120);
    let a = &ch[120];
    let s = sess(&t.env, "F9999999");
    let deadline = t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, a, &t.terms());
    // Before the deadline the host may not close with a partial refund...
    assert_eq!(t.c.try_host_refund(&t.host, &t.st, &s, a, &3), Err(Ok(Error::TooEarly)));
    assert_eq!(t.c.try_host_refund(&t.host, &t.st, &s, a, &19), Err(Ok(Error::TooEarly)));
    // ...after it, it may give back what it chooses.
    t.env.ledger().set_timestamp(deadline + 1);
    assert_eq!(t.c.try_host_refund(&t.host, &t.st, &s, &ch[119], &5), Err(Ok(Error::NoSession)));
    assert_eq!(t.c.host_refund(&t.host, &t.st, &s, a, &5), XLM / 2);
    assert_eq!(t.env.auths()[0].0, t.host);
    assert_eq!(t.tok.balance(&t.host), 2 * XLM - XLM / 2);
    // A full refund is allowed at any time, and more units than paid count as all of them.
    let s2 = sess(&t.env, "F9999998");
    t.c.deposit(&t.payer, &t.host, &t.st, &s2, &1, a, &t.terms());
    assert_eq!(t.c.host_refund(&t.host, &t.st, &s2, a, &u32::MAX), XLM);
    assert_eq!(t.c.try_host_refund(&t.host, &t.st, &s2, a, &10), Err(Ok(Error::NoSession)));
}

#[test]
fn register_rules() {
    let t = setup();
    let bad = |f: fn(&mut StationCfg)| {
        let mut cfg = t.cfg.clone();
        f(&mut cfg);
        t.c.try_register(&t.host, &t.st, &cfg)
    };
    assert_eq!(bad(|c| c.unit_secs = 7), Err(Ok(Error::BadConfig))); // does not divide 300
    assert_eq!(bad(|c| c.unit_secs = 1), Err(Ok(Error::BadConfig))); // a chain of 3600
    assert_eq!(bad(|c| c.unit_secs = 0), Err(Ok(Error::BadConfig)));
    assert_eq!(bad(|c| c.ficha_secs = 0), Err(Ok(Error::BadConfig)));
    assert_eq!(bad(|c| c.max_fichas = 0), Err(Ok(Error::BadConfig)));
    assert_eq!(bad(|c| c.price = 0), Err(Ok(Error::BadConfig)));
    assert_eq!(bad(|c| c.price = -1), Err(Ok(Error::BadConfig)));
    assert_eq!(bad(|c| c.grace_secs = MIN_GRACE_SECS - 1), Err(Ok(Error::BadConfig)));
    assert_eq!(bad(|c| c.grace_secs = MAX_GRACE_SECS + 1), Err(Ok(Error::BadConfig)));
    // 13 fichas of 2 h: 26 h in one session, over a day.
    assert_eq!(
        bad(|c| {
            c.ficha_secs = 7200;
            c.unit_secs = 3600;
            c.max_fichas = 13;
        }),
        Err(Ok(Error::BadConfig))
    );
    // 257 units.
    assert_eq!(
        bad(|c| {
            c.ficha_secs = 30;
            c.max_fichas = 257;
        }),
        Err(Ok(Error::BadConfig))
    );
    // A price whose largest refund would not fit an i128.
    assert_eq!(bad(|c| c.price = i128::MAX / 100), Err(Ok(Error::Overflow)));
    // The bounds themselves are fine: 256 units, 24 h, the shortest and longest grace.
    for ok in [
        StationCfg { ficha_secs: 480, unit_secs: 30, max_fichas: 16, ..t.cfg.clone() },
        StationCfg { ficha_secs: 3600, unit_secs: 900, max_fichas: 24, ..t.cfg.clone() },
        StationCfg { grace_secs: MIN_GRACE_SECS, ..t.cfg.clone() },
        StationCfg { grace_secs: MAX_GRACE_SECS, ..t.cfg.clone() },
    ] {
        t.c.register(&t.host, &t.st, &ok);
        assert_eq!(t.c.station(&t.host, &t.st), Some(ok));
    }
    t.c.register(&t.host, &t.st, &t.cfg);
    assert_eq!(t.env.auths()[0].0, t.host);
    // The same ID under another host is another station: no squatting.
    let other = Address::generate(&t.env);
    assert!(t.c.station(&other, &t.st).is_none());
    let mut theirs = t.cfg.clone();
    theirs.price = 9 * XLM;
    t.c.register(&other, &t.st, &theirs);
    assert_eq!(t.c.station(&t.host, &t.st), Some(t.cfg.clone()));
}

#[test]
fn terms_are_frozen_per_session_and_inactive_stops_new_ones() {
    let t = setup();
    let ch = chain(&t.env, 11, 120);
    let a = &ch[120];
    let s = sess(&t.env, "FAAAAAAA");
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &1, a, &t.terms());
    let mut dearer = t.cfg.clone();
    dearer.price = 5 * XLM;
    dearer.ficha_secs = 60;
    t.c.register(&t.host, &t.st, &dearer);
    // A top-up keeps the session's price and ficha length: the payer signs those.
    let d = t.c.deposit(&t.payer, &t.host, &t.st, &s, &1, a, &t.terms());
    assert_eq!(d, 1_000_000 + 600 + 1680);
    assert_eq!(t.c.session(&t.host, &t.st, &s, a).unwrap().amount, 2 * XLM);
    // A top-up under the station's new terms is not the session's: refused.
    assert_eq!(t.c.try_deposit(&t.payer, &t.host, &t.st, &s, &1, a, &terms_of(&dearer)), Err(Ok(Error::TermsChanged)));
    dearer.active = false;
    t.c.register(&t.host, &t.st, &dearer);
    let s2 = sess(&t.env, "FBBBBBBB");
    assert_eq!(t.c.try_deposit(&t.payer, &t.host, &t.st, &s2, &1, a, &terms_of(&dearer)), Err(Ok(Error::Inactive)));
    assert_eq!(t.c.try_deposit(&t.payer, &t.host, &t.st, &s, &1, a, &t.terms()), Err(Ok(Error::Inactive)));
    // The open session keeps its terms and can still settle: 10 of its 20 units back.
    assert_eq!(t.c.claim(&t.host, &t.st, &s, a, &10, &ch[110]), XLM);
}

#[test]
fn a_settled_session_id_opens_again_as_a_new_session() {
    // The contract keeps nothing of a settled session: the app never pays a
    // session it already holds a receipt for (section 7 of the spec).
    let t = setup();
    let ch = chain(&t.env, 14, 120);
    let a = &ch[120];
    let s = sess(&t.env, "FCCCCCCD");
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &1, a, &t.terms());
    t.c.claim(&t.host, &t.st, &s, a, &0, a);
    t.env.ledger().set_timestamp(1_000_000 + 5000);
    let d = t.c.deposit(&t.payer, &t.host, &t.st, &s, &1, a, &t.terms());
    assert_eq!(d, 1_000_000 + 5000 + 300 + 1680);
    assert_eq!(t.c.session(&t.host, &t.st, &s, a).unwrap().opened, 1_000_000 + 5000);
}

#[test]
fn claim_cost_worst_case() {
    let t = setup();
    let mut cfg = t.cfg.clone();
    cfg.unit_secs = 15; // 12 x 20 = 240 units
    let st2 = Symbol::new(&t.env, "ERZGCG");
    t.c.register(&t.host, &st2, &cfg);
    let ch = chain(&t.env, 12, MAX_CHAIN);
    let s = sess(&t.env, "FCCCCCCC");
    t.c.deposit(&t.payer, &t.host, &st2, &s, &12, &ch[MAX_CHAIN as usize], &terms_of(&cfg));
    t.env.cost_estimate().budget().reset_default();
    // The longest proof a claim hashes: MAX_CHAIN links, whatever the session's own N.
    t.c.claim(&t.host, &st2, &s, &ch[MAX_CHAIN as usize], &MAX_CHAIN, &ch[0]);
    let cpu = t.env.cost_estimate().budget().cpu_instruction_cost();
    std::println!("claim with {} hashes: {} cpu instructions (native, VM not counted)", MAX_CHAIN, cpu);
    assert!(cpu < 40_000_000);
}

// ---------------------------------------------------------------- C1: the host cannot hold a refund hostage

/// The finding: a host that makes its own account unable to take the token
/// (here its balance frozen by the issuer, as with a deauthorized USDC
/// trustline; for XLM a merged account) made every partial claim fail, then
/// took everything at release. Now the payer's refund goes through and the
/// host's share is owed to it (a claim's always is: see test_footprint.rs),
/// paid out by pay_host once it can take it. A release tries the host first
/// and keeps its share owed when its account cannot take it.
#[test]
fn a_host_that_cannot_receive_never_blocks_the_refund() {
    let t = setup();
    let ch = chain(&t.env, 31, 120);
    let a = &ch[120];
    let s = sess(&t.env, "FC1AAAAA");
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, a, &t.terms());
    t.sac().set_authorized(&t.host, &false);
    // 7 of 20 units back: the payer gets its share now.
    assert_eq!(t.c.claim(&t.host, &t.st, &s, a, &7, &ch[113]), 7 * XLM / 10);
    let share = 2 * XLM - 7 * XLM / 10;
    let events = t.env.events().all().filter_by_contract(&t.c.address);
    assert_eq!(events.events().len(), 2); // owed, then settle
    assert_eq!(
        events.events()[0],
        HostOwed { host: t.host.clone(), token: t.cfg.token.clone(), amount: share, total: share }.to_xdr(&t.env, &t.c.address)
    );
    assert_eq!(t.tok.balance(&t.payer), 98 * XLM + 7 * XLM / 10);
    assert!(t.c.session(&t.host, &t.st, &s, a).is_none());
    // The host's share stays in the contract, owed to the host.
    assert_eq!(t.tok.balance(&t.c.address), share);
    assert_eq!(t.c.owed(&t.host, &t.cfg.token), share);
    // While the host still cannot take it, pay_host fails and it stays owed.
    assert!(t.c.try_pay_host(&t.host, &t.cfg.token).is_err());
    assert_eq!(t.c.owed(&t.host, &t.cfg.token), share);
    // A second session adds to what is owed; release (anyone) too.
    let s2 = sess(&t.env, "FC1BBBBB");
    let d2 = t.c.deposit(&t.payer, &t.host, &t.st, &s2, &1, a, &t.terms());
    t.env.ledger().set_timestamp(d2 + 1);
    assert_eq!(t.c.release(&t.host, &t.st, &s2, a), XLM);
    assert_eq!(t.c.owed(&t.host, &t.cfg.token), share + XLM);
    // Once the host can take it, anyone pays it out: to the host only.
    t.sac().set_authorized(&t.host, &true);
    t.env.mock_auths(&[]);
    assert_eq!(t.c.pay_host(&t.host, &t.cfg.token), share + XLM);
    assert!(t.env.auths().is_empty());
    assert_eq!(
        t.env.events().all().filter_by_contract(&t.c.address),
        [HostPaid { host: t.host.clone(), token: t.cfg.token.clone(), amount: share + XLM }.to_xdr(&t.env, &t.c.address)]
    );
    assert_eq!(t.tok.balance(&t.host), share + XLM);
    assert_eq!(t.tok.balance(&t.c.address), 0);
    assert_eq!(t.c.owed(&t.host, &t.cfg.token), 0);
    assert_eq!(t.c.try_pay_host(&t.host, &t.cfg.token), Err(Ok(Error::NothingOwed)));
}

/// The finding's other case: a classic (G) host account with no trustline
/// to the asset. Every share of a refund still reaches the payer.
#[test]
fn a_host_with_no_trustline_never_blocks_the_refund() {
    let t = setup();
    let host = Address::from_str(&t.env, "GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6");
    t.c.register(&host, &t.st, &t.cfg);
    let ch = chain(&t.env, 32, 120);
    let a = &ch[120];
    let s = sess(&t.env, "FC1CCCCC");
    t.c.deposit(&t.payer, &host, &t.st, &s, &2, a, &t.terms());
    for u in [1u32, 7, 19] {
        let id = Symbol::new(&t.env, &std::format!("FC1U{u:04}"));
        t.c.deposit(&t.payer, &host, &t.st, &id, &2, a, &t.terms());
        assert_eq!(t.c.claim(&host, &t.st, &id, a, &u, &ch[(120 - u) as usize]), payer_share(2 * XLM, u, 20));
    }
    assert_eq!(t.c.claim(&host, &t.st, &s, a, &7, &ch[113]), 7 * XLM / 10);
    let owed = (2 * XLM - payer_share(2 * XLM, 1, 20)) + (2 * XLM - payer_share(2 * XLM, 7, 20)) * 2
        + (2 * XLM - payer_share(2 * XLM, 19, 20));
    assert_eq!(t.c.owed(&host, &t.cfg.token), owed);
    assert_eq!(t.tok.balance(&t.c.address), owed);
    assert_eq!(t.tok.balance(&t.payer), 100 * XLM - owed);
    // Still no trustline: pay_host fails and nothing moves.
    assert!(t.c.try_pay_host(&host, &t.cfg.token).is_err());
    assert_eq!(t.c.owed(&host, &t.cfg.token), owed);
}

/// The payer's own leg is not softened: a payer that cannot take its refund
/// fails its own claim, and nothing changes (the session stays open).
#[test]
fn a_payer_that_cannot_receive_fails_only_its_own_claim() {
    let t = setup();
    let ch = chain(&t.env, 33, 120);
    let a = &ch[120];
    let s = sess(&t.env, "FC1DDDDD");
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, a, &t.terms());
    t.sac().set_authorized(&t.payer, &false);
    assert!(t.c.try_claim(&t.host, &t.st, &s, a, &7, &ch[113]).is_err());
    assert!(t.c.session(&t.host, &t.st, &s, a).is_some());
    assert_eq!(t.c.owed(&t.host, &t.cfg.token), 0);
    t.sac().set_authorized(&t.payer, &true);
    assert_eq!(t.c.claim(&t.host, &t.st, &s, a, &7, &ch[113]), 7 * XLM / 10);
    assert_eq!(t.c.owed(&t.host, &t.cfg.token), 2 * XLM - 7 * XLM / 10);
}

// ---------------------------------------------------------------- C2: a session is its anchor too

/// The finding: anyone who saw the pay QR could deposit under its session
/// ID with a chain of their own, refund themselves in full, and lock the
/// real payer out (OtherPayer), at no cost but fees. Now that deposit opens
/// a session of its own, and the station's session is untouched.
#[test]
fn a_deposit_with_a_foreign_anchor_opens_its_own_session() {
    let t = setup();
    let station = chain(&t.env, 41, 120);
    let theirs = chain(&t.env, 42, 120);
    let s = sess(&t.env, "F3H9TXAB");
    let attacker = Address::generate(&t.env);
    t.sac().mint(&attacker, &(5 * XLM));
    t.c.deposit(&attacker, &t.host, &t.st, &s, &1, &theirs[120], &t.terms());
    // The real payer, with the station's anchor, pays the station's session.
    let d = t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, &station[120], &t.terms());
    assert_eq!(d, 1_000_000 + 600 + 1680);
    let mine = t.c.session(&t.host, &t.st, &s, &station[120]).unwrap();
    assert_eq!((mine.payer.clone(), mine.fichas), (t.payer.clone(), 2));
    assert_eq!(t.c.session(&t.host, &t.st, &s, &theirs[120]).unwrap().payer, attacker);
    // The other session settles alone, and its event names its anchor.
    assert_eq!(t.c.claim(&t.host, &t.st, &s, &theirs[120], &120, &theirs[0]), XLM);
    assert_eq!(
        t.env.events().all().filter_by_contract(&t.c.address),
        [Settled {
            host: t.host.clone(),
            station: t.st.clone(),
            session: s.clone(),
            anchor: theirs[120].clone(),
            payer: attacker.clone(),
            to_host: 0,
            to_payer: XLM,
            unused_units: 10,
            how: symbol_short!("proof"),
        }
        .to_xdr(&t.env, &t.c.address)]
    );
    assert_eq!(t.tok.balance(&attacker), 5 * XLM);
    // The station's session is still open, and settles with its own proof.
    assert_eq!(t.c.session(&t.host, &t.st, &s, &station[120]), Some(mine));
    // Its chain cannot settle the station's session, nor the other way round.
    assert_eq!(t.c.try_claim(&t.host, &t.st, &s, &station[120], &120, &theirs[0]), Err(Ok(Error::BadProof)));
    assert_eq!(t.c.claim(&t.host, &t.st, &s, &station[120], &7, &station[113]), payer_share(2 * XLM, 7, 20));
    assert_eq!(t.c.owed(&t.host, &t.cfg.token), 2 * XLM - payer_share(2 * XLM, 7, 20));
}

// ---------------------------------------------------------------- C3: the payer signs the terms

fn deposit_signed(t: &T, s: &Symbol, fichas: u32, anchor: &BytesN<32>, terms: &Terms, amount: i128) -> Result<u64, Error> {
    t.env.mock_auths(&[MockAuth {
        address: &t.payer,
        invoke: &MockAuthInvoke {
            contract: &t.c.address,
            fn_name: "deposit",
            args: (t.payer.clone(), t.host.clone(), t.st.clone(), s.clone(), fichas, anchor.clone(), terms.clone()).into_val(&t.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &t.cfg.token,
                fn_name: "transfer",
                args: (t.payer.clone(), t.c.address.clone(), amount).into_val(&t.env),
                sub_invokes: &[],
            }],
        },
    }]);
    let r = t.c.try_deposit(&t.payer, &t.host, &t.st, s, &fichas, anchor, terms);
    t.env.mock_all_auths();
    match r {
        Ok(Ok(d)) => Ok(d),
        Err(Ok(e)) => Err(e),
        other => panic!("not a contract result: {other:?}"),
    }
}

/// The finding: a register landing between the app's read and the deposit
/// froze other unit_secs, ficha_secs or max_fichas into the session, under
/// a signature that covered only the price, and the station's refunds came
/// out wrong (half, a quarter, or a proof the contract refused). Now the
/// payer signs the terms, and any change fails the deposit before money
/// moves.
#[test]
fn terms_changed_after_the_read_fail_the_deposit() {
    let t = setup();
    let ch = chain(&t.env, 51, 120);
    let a = &ch[120];
    let seen = t.terms(); // what the app read and checked against the registry
    let other_token = Address::generate(&t.env);
    let changed = [
        StationCfg { unit_secs: 15, ..t.cfg.clone() },
        StationCfg { ficha_secs: 600, ..t.cfg.clone() },
        StationCfg { max_fichas: 6, ..t.cfg.clone() },
        StationCfg { grace_secs: 900, ..t.cfg.clone() },
        StationCfg { price: 2 * XLM, ..t.cfg.clone() },
        StationCfg { token: other_token, ..t.cfg.clone() },
    ];
    for (i, cfg) in changed.iter().enumerate() {
        t.c.register(&t.host, &t.st, cfg);
        let s = Symbol::new(&t.env, &std::format!("FC3T{i:04}"));
        assert_eq!(deposit_signed(&t, &s, 2, a, &seen, 2 * XLM), Err(Error::TermsChanged), "change {i}");
        assert!(t.c.session(&t.host, &t.st, &s, a).is_none());
        assert_eq!(t.tok.balance(&t.payer), 100 * XLM);
    }
    // Back to the terms the payer saw: the same signature goes through, and
    // the session holds exactly those terms.
    t.c.register(&t.host, &t.st, &t.cfg);
    let s = sess(&t.env, "FC3OK000");
    deposit_signed(&t, &s, 2, a, &seen, 2 * XLM).unwrap();
    let got = t.c.session(&t.host, &t.st, &s, a).unwrap();
    assert_eq!(session_terms(&got), seen);
    assert_eq!(got.chain_len, 120);
    // A top-up signs the session's own terms, even after the station's changed.
    let mut finer = t.cfg.clone();
    finer.unit_secs = 15;
    t.c.register(&t.host, &t.st, &finer);
    deposit_signed(&t, &s, 1, a, &seen, XLM).unwrap();
    assert_eq!(deposit_signed(&t, &s, 1, a, &terms_of(&finer), XLM), Err(Error::TermsChanged));
    // 300 of 900 s unused, in the station's 30 s units: 10 of 30 units, a third back.
    assert_eq!(t.c.claim(&t.host, &t.st, &s, a, &10, &ch[110]), XLM);
}

/// The other half of the finding: a station whose N is longer than the
/// session's chain (its max_fichas was lowered on the contract) showed a
/// full-refund proof (q = N, z = c[0]) that claim refused (BadProof). Any
/// proof up to MAX_CHAIN now counts, capped at the units paid.
#[test]
fn a_proof_longer_than_the_session_chain_still_refunds() {
    let t = setup();
    let mut fewer = t.cfg.clone();
    fewer.max_fichas = 6; // the contract's N is 60
    t.c.register(&t.host, &t.st, &fewer);
    let ch = chain(&t.env, 52, 120); // the station's own N is 120
    let a = &ch[120];
    let s = sess(&t.env, "FC3LONG0");
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &1, a, &terms_of(&fewer));
    assert_eq!(t.c.session(&t.host, &t.st, &s, a).unwrap().chain_len, 60);
    assert_eq!(t.c.claim(&t.host, &t.st, &s, a, &120, &ch[0]), XLM);
    assert_eq!(t.tok.balance(&t.payer), 100 * XLM);
}
