#![cfg(test)]
//! What docs/station-app-contract.md, section 7, promises the station and
//! the app: the events as they go on the wire, what the payer signs, how a
//! refund splits, the deadline's edges, and the shared test vectors.
extern crate std;

use super::test::{chain, chain_from, sess, setup, terms_of};
use super::*;
use soroban_sdk::{
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger, MockAuth, MockAuthInvoke,
    },
    token::StellarAssetClient,
    xdr, Address, Env, Event as _, IntoVal, Symbol, TryFromVal, Val,
};
use std::{format, string::{String, ToString}, vec, vec::Vec};

const XLM: i128 = 10_000_000;
const VECTORS: &str = include_str!("../test-vectors.json");

fn sym(v: &xdr::ScVal) -> String {
    match v {
        xdr::ScVal::Symbol(s) => String::from_utf8(s.0.to_vec()).unwrap(),
        other => panic!("not a symbol: {other:?}"),
    }
}

/// (key, value type) of an event's data map, in the order on the wire.
fn map_shape(v: &xdr::ScVal) -> Vec<(String, xdr::ScValType)> {
    match v {
        xdr::ScVal::Map(Some(m)) => m.0.iter().map(|e| (sym(&e.key), e.val.discriminant())).collect(),
        other => panic!("not a map: {other:?}"),
    }
}

fn body(e: &xdr::ContractEvent) -> (Vec<xdr::ScVal>, xdr::ScVal) {
    let xdr::ContractEventBody::V0(v0) = &e.body;
    (v0.topics.to_vec(), v0.data.clone())
}

#[test]
fn events_as_published() {
    let t = setup();
    // register (the last call of setup)
    assert_eq!(
        t.env.events().all().filter_by_contract(&t.c.address),
        [StationSet { host: t.host.clone(), station: t.st.clone(), cfg: t.cfg.clone() }.to_xdr(&t.env, &t.c.address)]
    );
    let ch = chain(&t.env, 21, 120);
    let s = sess(&t.env, "F3H9TXAB");
    let d = t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, &ch[120], &t.terms());
    let deposited = |fichas: u32, total: u32| Deposited {
        host: t.host.clone(),
        station: t.st.clone(),
        session: s.clone(),
        payer: t.payer.clone(),
        fichas,
        amount: fichas as i128 * XLM,
        total_fichas: total,
        total_amount: total as i128 * XLM,
        anchor: ch[120].clone(),
        deadline: 1_000_000 + total as u64 * 300 + 1680,
        terms: t.terms(),
    };
    assert_eq!(d, deposited(2, 2).deadline);
    assert_eq!(t.env.events().all().filter_by_contract(&t.c.address), [deposited(2, 2).to_xdr(&t.env, &t.c.address)]);
    // The token's own transfer event comes with it.
    assert_eq!(t.env.events().all().filter_by_contract(&t.cfg.token).events().len(), 1);
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &1, &ch[120], &t.terms());
    assert_eq!(t.env.events().all().filter_by_contract(&t.c.address), [deposited(1, 3).to_xdr(&t.env, &t.c.address)]);

    let settled = |session: &Symbol, to_host: i128, to_payer: i128, unused_units: u32, how: &str| {
        Settled {
            host: t.host.clone(),
            station: t.st.clone(),
            session: session.clone(),
            anchor: ch[120].clone(),
            payer: t.payer.clone(),
            to_host,
            to_payer,
            unused_units,
            how: Symbol::new(&t.env, how),
        }
        .to_xdr(&t.env, &t.c.address)
    };
    // claim: 7 of 30 units back, rounded up: 3 XLM x 7 / 30 = 0.7 XLM. The
    // host's share is owed (a claim never pays the host): `owed` just before
    // `settle`, in the same call.
    t.c.claim(&t.host, &t.st, &s, &ch[120], &7, &ch[113]);
    let owed = |amount: i128, total: i128| {
        HostOwed { host: t.host.clone(), token: t.cfg.token.clone(), amount, total }.to_xdr(&t.env, &t.c.address)
    };
    assert_eq!(
        t.env.events().all().filter_by_contract(&t.c.address),
        [owed(23 * XLM / 10, 23 * XLM / 10), settled(&s, 23 * XLM / 10, 7 * XLM / 10, 7, "proof")]
    );
    // A full refund leaves the host nothing, and nothing owed.
    let s2 = sess(&t.env, "F3H9TXAC");
    t.c.deposit(&t.payer, &t.host, &t.st, &s2, &1, &ch[120], &t.terms());
    t.c.claim(&t.host, &t.st, &s2, &ch[120], &120, &ch[0]);
    assert_eq!(t.env.events().all().filter_by_contract(&t.c.address), [settled(&s2, 0, XLM, 10, "proof")]);
    // release and host_refund pay a host that can take it at once: no `owed`.
    let s3 = sess(&t.env, "F3H9TXAD");
    let s4 = sess(&t.env, "F3H9TXAE");
    let d3 = t.c.deposit(&t.payer, &t.host, &t.st, &s3, &1, &ch[120], &t.terms());
    t.c.deposit(&t.payer, &t.host, &t.st, &s4, &1, &ch[120], &t.terms());
    t.env.ledger().set_timestamp(d3 + 1);
    t.c.release(&t.host, &t.st, &s3, &ch[120]);
    assert_eq!(t.env.events().all().filter_by_contract(&t.c.address), [settled(&s3, XLM, 0, 0, "deadline")]);
    t.c.host_refund(&t.host, &t.st, &s4, &ch[120], &4);
    assert_eq!(t.env.events().all().filter_by_contract(&t.c.address), [settled(&s4, 6 * XLM / 10, 4 * XLM / 10, 4, "host")]);
}

/// Topic and data layout exactly as section 7 of the spec describes it, so
/// a change here is a change of the spec.
#[test]
fn event_wire_format() {
    use xdr::ScValType as Ty;
    let t = setup();
    let (topics, data) = body(&t.env.events().all().filter_by_contract(&t.c.address).events()[0]);
    assert_eq!(topics.len(), 3);
    assert_eq!(sym(&topics[0]), "station");
    let host: Val = t.host.clone().into_val(&t.env);
    assert_eq!(topics[1], xdr::ScVal::try_from_val(&t.env, &host).unwrap());
    assert_eq!(sym(&topics[2]), "K7M2QX");
    let cfg_shape = vec![
        ("active".into(), Ty::Bool),
        ("ficha_secs".into(), Ty::U32),
        ("grace_secs".into(), Ty::U64),
        ("max_fichas".into(), Ty::U32),
        ("price".into(), Ty::I128),
        ("token".into(), Ty::Address),
        ("unit_secs".into(), Ty::U32),
    ];
    assert_eq!(map_shape(&data), cfg_shape);

    let ch = chain(&t.env, 22, 120);
    let s = sess(&t.env, "F3H9TXAB");
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, &ch[120], &t.terms());
    let (topics, data) = body(&t.env.events().all().filter_by_contract(&t.c.address).events()[0]);
    assert_eq!(topics.len(), 4);
    assert_eq!(sym(&topics[0]), "deposit");
    assert_eq!(topics[1].discriminant(), Ty::Address);
    assert_eq!(sym(&topics[2]), "K7M2QX");
    assert_eq!(sym(&topics[3]), "F3H9TXAB");
    assert_eq!(
        map_shape(&data),
        vec![
            ("amount".into(), Ty::I128),
            ("anchor".into(), Ty::Bytes),
            ("deadline".into(), Ty::U64),
            ("fichas".into(), Ty::U32),
            ("payer".into(), Ty::Address),
            ("terms".into(), Ty::Map),
            ("total_amount".into(), Ty::I128),
            ("total_fichas".into(), Ty::U32),
        ]
    );
    let xdr::ScVal::Map(Some(m)) = &data else { unreachable!() };
    assert_eq!(m.0[1].val, xdr::ScVal::Bytes(xdr::ScBytes(ch[120].to_array().to_vec().try_into().unwrap())));
    // Terms: StationCfg's fields but `active`, in the same key order.
    let terms_shape = vec![
        ("ficha_secs".into(), Ty::U32),
        ("grace_secs".into(), Ty::U64),
        ("max_fichas".into(), Ty::U32),
        ("price".into(), Ty::I128),
        ("token".into(), Ty::Address),
        ("unit_secs".into(), Ty::U32),
    ];
    assert_eq!(map_shape(&m.0[5].val), terms_shape);

    t.c.claim(&t.host, &t.st, &s, &ch[120], &7, &ch[113]);
    let claimed = t.env.events().all().filter_by_contract(&t.c.address);
    assert_eq!(claimed.events().len(), 2);
    assert_eq!(sym(&body(&claimed.events()[0]).0[0]), "owed");
    let (topics, data) = body(&claimed.events()[1]);
    assert_eq!(topics.len(), 4);
    assert_eq!(sym(&topics[0]), "settle");
    assert_eq!(sym(&topics[3]), "F3H9TXAB");
    assert_eq!(
        map_shape(&data),
        vec![
            ("anchor".into(), Ty::Bytes),
            ("how".into(), Ty::Symbol),
            ("payer".into(), Ty::Address),
            ("to_host".into(), Ty::I128),
            ("to_payer".into(), Ty::I128),
            ("unused_units".into(), Ty::U32),
        ]
    );

    // A release to a host that cannot take its share: owed, then payout.
    let d = t.c.deposit(&t.payer, &t.host, &t.st, &s, &1, &ch[120], &t.terms());
    StellarAssetClient::new(&t.env, &t.cfg.token).set_authorized(&t.host, &false);
    t.env.ledger().set_timestamp(d + 1);
    t.c.release(&t.host, &t.st, &s, &ch[120]);
    let (topics, data) = body(&t.env.events().all().filter_by_contract(&t.c.address).events()[0]);
    assert_eq!(topics.len(), 3);
    assert_eq!(sym(&topics[0]), "owed");
    assert_eq!(topics[1].discriminant(), Ty::Address);
    assert_eq!(topics[2].discriminant(), Ty::Address);
    assert_eq!(map_shape(&data), vec![("amount".into(), Ty::I128), ("total".into(), Ty::I128)]);
    StellarAssetClient::new(&t.env, &t.cfg.token).set_authorized(&t.host, &true);
    t.c.pay_host(&t.host, &t.cfg.token);
    let (topics, data) = body(&t.env.events().all().filter_by_contract(&t.c.address).events()[0]);
    assert_eq!(topics.len(), 3);
    assert_eq!(sym(&topics[0]), "payout");
    assert_eq!(map_shape(&data), vec![("amount".into(), Ty::I128)]);

    // The storage keys, as getLedgerEntries takes them.
    let key = |k: Key| {
        let k: Val = k.into_val(&t.env);
        match xdr::ScVal::try_from_val(&t.env, &k).unwrap() {
            xdr::ScVal::Vec(Some(parts)) => parts.to_vec(),
            other => panic!("a key is a vec: {other:?}"),
        }
    };
    let parts = key(Key::Station(t.host.clone(), t.st.clone()));
    assert_eq!((sym(&parts[0]).as_str(), parts.len()), ("Station", 3));
    let parts = key(Key::Session(t.host.clone(), t.st.clone(), s.clone(), ch[120].clone()));
    assert_eq!((sym(&parts[0]).as_str(), parts.len()), ("Session", 5));
    assert_eq!(sym(&parts[3]), "F3H9TXAB");
    assert_eq!(parts[4].discriminant(), Ty::Bytes);
    let parts = key(Key::Owed(t.host.clone(), t.cfg.token.clone()));
    assert_eq!((sym(&parts[0]).as_str(), parts.len()), ("Owed", 3));
}

/// R2C3: the event docs ship in the wasm's contract spec, which explorers
/// and generated bindings show. They said an `owed` event "then follows" the
/// settle, while it is published just before it: a decoder that trusted
/// them would pair each `owed` with the next settlement's. The docs now say
/// what the contract does, and this pins both.
#[test]
fn event_docs_say_owed_comes_just_before_its_settle() {
    use xdr::{Limits, ReadXdr, ScSpecEntry};
    let spec = |bytes: &[u8]| match ScSpecEntry::from_xdr(bytes, Limits::none()).unwrap() {
        ScSpecEntry::EventV0(e) => e,
        other => panic!("not an event: {other:?}"),
    };
    let settled = spec(&Settled::spec_xdr());
    let to_host = settled.params.iter().find(|p| p.name.to_utf8_string_lossy() == "to_host").unwrap();
    let doc = to_host.doc.to_utf8_string_lossy();
    assert!(doc.contains("just before this one, in the same"), "{doc}");
    assert!(!doc.contains("then follows"), "{doc}");
    let owed = spec(&HostOwed::spec_xdr()).doc.to_utf8_string_lossy();
    assert!(owed.contains("just before that") && owed.contains("`settle` event, in the same call"), "{owed}");
    // And the contract does publish them in that order, in the same call.
    let t = setup();
    let ch = chain(&t.env, 28, 120);
    let s = sess(&t.env, "FR2C3AAA");
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, &ch[120], &t.terms());
    t.c.claim(&t.host, &t.st, &s, &ch[120], &7, &ch[113]);
    let names: Vec<String> =
        t.env.events().all().filter_by_contract(&t.c.address).events().iter().map(|e| sym(&body(e).0[0])).collect();
    assert_eq!(names, ["owed", "settle"]);
}

#[test]
fn deposit_auth_covers_the_token_transfer() {
    let t = setup();
    let ch = chain(&t.env, 23, 120);
    let s = sess(&t.env, "FDDDDDDD");
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, &ch[120], &t.terms());
    assert_eq!(
        t.env.auths(),
        vec![(
            t.payer.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    t.c.address.clone(),
                    Symbol::new(&t.env, "deposit"),
                    (t.payer.clone(), t.host.clone(), t.st.clone(), s.clone(), 2u32, ch[120].clone(), t.terms())
                        .into_val(&t.env),
                )),
                sub_invocations: vec![AuthorizedInvocation {
                    function: AuthorizedFunction::Contract((
                        t.cfg.token.clone(),
                        symbol_short!("transfer"),
                        (t.payer.clone(), t.c.address.clone(), 2 * XLM).into_val(&t.env),
                    )),
                    sub_invocations: vec![],
                }],
            }
        )]
    );
}

/// The payer signs the terms and the transfer's amount: a price raised
/// between the app's simulation and the ledger fails the deposit instead of
/// charging more.
#[test]
fn a_price_change_after_signing_fails_the_deposit() {
    let t = setup();
    let ch = chain(&t.env, 24, 120);
    let s = sess(&t.env, "FDDDDDDE");
    let signed = |env: &Env| {
        env.mock_auths(&[MockAuth {
            address: &t.payer,
            invoke: &MockAuthInvoke {
                contract: &t.c.address,
                fn_name: "deposit",
                args: (t.payer.clone(), t.host.clone(), t.st.clone(), s.clone(), 2u32, ch[120].clone(), t.terms())
                    .into_val(env),
                sub_invokes: &[MockAuthInvoke {
                    contract: &t.cfg.token,
                    fn_name: "transfer",
                    args: (t.payer.clone(), t.c.address.clone(), 2 * XLM).into_val(env),
                    sub_invokes: &[],
                }],
            },
        }])
    };
    let mut dearer = t.cfg.clone();
    dearer.price = 2 * XLM;
    t.c.register(&t.host, &t.st, &dearer);
    signed(&t.env);
    assert_eq!(t.c.try_deposit(&t.payer, &t.host, &t.st, &s, &2, &ch[120], &t.terms()), Err(Ok(Error::TermsChanged)));
    assert_eq!(t.tok.balance(&t.payer), 100 * XLM);
    // Calling with the new terms, which the payer did not sign, fails on authorization.
    signed(&t.env);
    assert!(t.c.try_deposit(&t.payer, &t.host, &t.st, &s, &2, &ch[120], &terms_of(&dearer)).is_err());
    assert_eq!(t.tok.balance(&t.payer), 100 * XLM);
    // At the price the payer saw, the same signature goes through.
    t.env.mock_all_auths();
    t.c.register(&t.host, &t.st, &t.cfg);
    signed(&t.env);
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, &ch[120], &t.terms());
    assert_eq!(t.tok.balance(&t.payer), 98 * XLM);
}

#[test]
fn only_the_payer_can_claim_and_anyone_can_release() {
    let t = setup();
    let ch = chain(&t.env, 25, 120);
    let s = sess(&t.env, "FEEEEEEE");
    let d = t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, &ch[120], &t.terms());
    let claim_signed_by = |who: &Address| {
        t.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract: &t.c.address,
                fn_name: "claim",
                args: (t.host.clone(), t.st.clone(), s.clone(), ch[120].clone(), 0u32, ch[120].clone()).into_val(&t.env),
                sub_invokes: &[],
            },
        }]);
        t.c.try_claim(&t.host, &t.st, &s, &ch[120], &0, &ch[120])
    };
    // The host (or anyone else) cannot close the session early with U = 0.
    assert!(claim_signed_by(&t.host).is_err());
    assert!(claim_signed_by(&Address::generate(&t.env)).is_err());
    assert!(t.c.session(&t.host, &t.st, &s, &ch[120]).is_some());
    // Nor can anyone but the host refund in its name.
    t.env.mock_auths(&[]);
    assert!(t.c.try_host_refund(&t.host, &t.st, &s, &ch[120], &20).is_err());
    // release needs no signature at all, once the deadline has passed.
    t.env.ledger().set_timestamp(d + 1);
    assert_eq!(t.c.release(&t.host, &t.st, &s, &ch[120]), 2 * XLM);
    assert!(t.env.auths().is_empty());
    assert_eq!(t.tok.balance(&t.host), 2 * XLM);
}

/// For every U the payer may prove, the payer's and the host's shares add up
/// to the deposit, the payer's is the exact share rounded up to a stroop, and
/// more unused units never give back less.
#[test]
fn shares_add_up_for_every_unit() {
    // (price, ficha_secs, unit_secs, max_fichas, fichas)
    let cases: [(i128, u32, u32, u32, u32); 5] = [
        (XLM, 300, 30, 12, 2),
        (10_000_001, 300, 30, 12, 3),
        (7, 90, 30, 12, 2),
        (1, 300, 15, 12, 12),
        (3 * XLM + 1, 60, 15, 30, 7),
    ];
    for (n, &(price, ficha_secs, unit_secs, max_fichas, fichas)) in cases.iter().enumerate() {
        let t = setup();
        t.env.cost_estimate().budget().reset_unlimited();
        let st = Symbol::new(&t.env, &format!("PRP{n}"));
        let cfg = StationCfg { price, ficha_secs, unit_secs, max_fichas, ..t.cfg.clone() };
        t.c.register(&t.host, &st, &cfg);
        let chain_len = max_fichas * (ficha_secs / unit_secs);
        let paid = fichas * (ficha_secs / unit_secs);
        let amount = price * fichas as i128;
        StellarAssetClient::new(&t.env, &t.cfg.token).mint(&t.payer, &(amount * (paid as i128 + 2)));
        let ch = chain(&t.env, n as u8, chain_len);
        let mut last = -1i128;
        for u in (0..=paid).chain([chain_len]) {
            let s = Symbol::new(&t.env, &format!("FU{u:03}"));
            t.c.deposit(&t.payer, &t.host, &st, &s, &fichas, &ch[chain_len as usize], &terms_of(&cfg));
            let (payer0, owed0) = (t.tok.balance(&t.payer), t.c.owed(&t.host, &t.cfg.token));
            let to_payer = t.c.claim(&t.host, &st, &s, &ch[chain_len as usize], &u, &ch[(chain_len - u) as usize]);
            let to_host = t.c.owed(&t.host, &t.cfg.token) - owed0;
            assert_eq!(t.tok.balance(&t.payer) - payer0, to_payer);
            assert_eq!(to_payer + to_host, amount, "case {n}, u {u}");
            let units = u.min(paid) as i128;
            // The smallest whole number of stroops at or above amount x units / paid.
            assert!(to_payer * paid as i128 >= amount * units, "case {n}, u {u}");
            assert!((to_payer - 1) * (paid as i128) < amount * units, "case {n}, u {u}");
            assert!(to_payer >= last, "case {n}, u {u}");
            last = to_payer;
            if u == 0 {
                assert_eq!(to_payer, 0);
            }
            if u >= paid {
                assert_eq!(to_payer, amount);
            }
        }
        // What is left in the contract is exactly what the host is owed.
        assert_eq!(t.tok.balance(&t.c.address), t.c.owed(&t.host, &t.cfg.token));
    }
}

#[test]
fn deadline_boundaries() {
    let t = setup();
    let ch = chain(&t.env, 26, 120);
    let [a, b, c, e] = ["FDA22222", "FDB22222", "FDC22222", "FDE22222"].map(|x| sess(&t.env, x));
    let k = &ch[120];
    let tm = t.terms();
    let d = t.c.deposit(&t.payer, &t.host, &t.st, &a, &1, k, &tm);
    for x in [&b, &c, &e] {
        assert_eq!(t.c.deposit(&t.payer, &t.host, &t.st, x, &1, k, &tm), d);
    }
    // At the deadline itself it is still the payer's turn.
    t.env.ledger().set_timestamp(d);
    assert_eq!(t.c.try_release(&t.host, &t.st, &a, k), Err(Ok(Error::TooEarly)));
    assert_eq!(t.c.try_host_refund(&t.host, &t.st, &a, k, &9), Err(Ok(Error::TooEarly)));
    assert_eq!(t.c.claim(&t.host, &t.st, &a, k, &10, &ch[110]), XLM);
    // A top-up at the deadline is taken and moves it by the fichas bought.
    assert_eq!(t.c.deposit(&t.payer, &t.host, &t.st, &b, &1, k, &tm), d + 300);
    // One second later it is the host's.
    t.env.ledger().set_timestamp(d + 1);
    assert_eq!(t.c.try_claim(&t.host, &t.st, &c, k, &10, &ch[110]), Err(Ok(Error::Expired)));
    assert_eq!(t.c.try_deposit(&t.payer, &t.host, &t.st, &c, &1, k, &tm), Err(Ok(Error::Expired)));
    assert_eq!(t.c.release(&t.host, &t.st, &c, k), XLM);
    assert_eq!(t.c.host_refund(&t.host, &t.st, &e, k, &3), 3 * XLM / 10);
    // b's deadline moved with its top-up.
    assert_eq!(t.c.try_release(&t.host, &t.st, &b, k), Err(Ok(Error::TooEarly)));
    t.env.ledger().set_timestamp(d + 300);
    assert_eq!(t.c.claim(&t.host, &t.st, &b, k, &1, &ch[119]), XLM / 10);
}

/// A deposit extends no TTL: neither the contract's instance nor the
/// station's entry (rent is the host's, through register, or maintenance).
#[test]
fn a_deposit_extends_no_ttl() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.timestamp = 1_000_000;
        li.sequence_number = 1_000;
        li.min_persistent_entry_ttl = 120 * DAY;
        li.min_temp_entry_ttl = 16;
        li.max_entry_ttl = 180 * DAY;
    });
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let host = Address::generate(&env);
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &sac.address()).mint(&payer, &(10 * XLM));
    let id = env.register(FichaEscrow, ());
    let c = FichaEscrowClient::new(&env, &id);
    let st = Symbol::new(&env, "K7M2QX");
    let cfg = StationCfg {
        token: sac.address(),
        price: XLM,
        ficha_secs: 300,
        max_fichas: 12,
        unit_secs: 30,
        grace_secs: 1680,
        active: true,
    };
    c.register(&host, &st, &cfg);
    let station_key = Key::Station(host.clone(), st.clone());
    let ttls = || {
        env.as_contract(&id, || (env.storage().instance().get_ttl(), env.storage().persistent().get_ttl(&station_key)))
    };
    // 100 days on: both entries are under the 30 days at which the
    // prototype's deposit extended them.
    env.ledger().with_mut(|li| li.sequence_number += 100 * DAY);
    let before = ttls();
    assert!(before.0 < STATION_TTL_THRESHOLD && before.1 < STATION_TTL_THRESHOLD, "{before:?}");
    let ch = chain(&env, 27, 120);
    c.deposit(&payer, &host, &st, &sess(&env, "F3H9TXAB"), &1, &ch[120], &terms_of(&cfg));
    assert_eq!(ttls(), before);
    // register does extend the host's own station entry.
    c.register(&host, &st, &cfg);
    assert_eq!(ttls().1, STATION_TTL_EXTEND_TO);
    assert_eq!(ttls().0, before.0);
}

fn unhex(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    assert_eq!(s.len(), 64, "{s}");
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// RFC 4648 section 5, no padding.
fn b64url(b: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in b.chunks(3) {
        let v = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..=chunk.len() {
            out.push(A[(v >> (18 - 6 * i)) as usize & 63] as char);
        }
    }
    out
}

/// contracts/escrow/test-vectors.json, written by an independent
/// implementation (Python hashlib), is what this contract computes; the
/// station and the app check the same file.
#[test]
fn shared_test_vectors() {
    let v: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
    assert_eq!(v["format"], "ficha-escrow-vectors/1");
    let env = Env::default();
    let s = |x: &serde_json::Value| x.as_str().unwrap().to_string();
    for c in v["chains"].as_array().unwrap() {
        let seed = unhex(&s(&c["seed_hex"]));
        assert_eq!(b64url(&seed), s(&c["seed_b64url"]));
        let n = c["n"].as_u64().unwrap() as u32;
        let ch = chain_from(&env, seed, n);
        let anchor = ch[n as usize].to_array();
        assert_eq!(hex(&anchor), s(&c["anchor_hex"]));
        assert_eq!(b64url(&anchor), s(&c["anchor_b64url"]));
        for p in c["proofs"].as_array().unwrap() {
            let u = p["u"].as_u64().unwrap() as u32;
            let proof = ch[(n - u) as usize].to_array();
            assert_eq!(hex(&proof), s(&p["proof_hex"]), "n {n}, u {u}");
            assert_eq!(b64url(&proof), s(&p["proof_b64url"]), "n {n}, u {u}");
        }
        if let Some(all) = c.get("chain_hex") {
            let all: Vec<String> = all.as_array().unwrap().iter().map(s).collect();
            assert_eq!(all, ch.iter().map(|x| hex(&x.to_array())).collect::<Vec<_>>());
        }
    }
    for x in v["unused_units"].as_array().unwrap() {
        let (paid, consumed, unit) = (
            x["paid_seconds"].as_i64().unwrap(),
            x["consumed_seconds"].as_i64().unwrap(),
            x["unit_seconds"].as_i64().unwrap(),
        );
        // ceil((paid - consumed) / unit), at least 0 and at most the units paid
        let u = ((paid - consumed).max(0) + unit - 1) / unit;
        assert_eq!(x["paid_units"].as_i64().unwrap(), paid / unit);
        assert_eq!(x["u"].as_i64().unwrap(), u.min(paid / unit), "{x}");
    }
    for x in v["payer_share"].as_array().unwrap() {
        let amount: i128 = s(&x["amount"]).parse().unwrap();
        let paid = x["paid_units"].as_u64().unwrap() as u32;
        let u = x["u"].as_u64().unwrap() as u32;
        let to_payer = payer_share(amount, u.min(paid), paid);
        assert_eq!(to_payer.to_string(), s(&x["to_payer"]), "{x}");
        assert_eq!((amount - to_payer).to_string(), s(&x["to_host"]), "{x}");
    }
    for x in v["deadline"].as_array().unwrap() {
        let f = |k: &str| x[k].as_u64().unwrap();
        assert_eq!(f("opened") + f("total_fichas") * f("ficha_seconds") + f("grace_seconds"), f("deadline"));
    }
    // The receipt example's proof is chain 0's for its q.
    let q: u32 = s(&v["receipt_v2"]["params"]["q"]).parse().unwrap();
    let c0 = &v["chains"][0];
    let p = c0["proofs"].as_array().unwrap().iter().find(|p| p["u"].as_u64() == Some(q as u64)).unwrap();
    assert_eq!(v["receipt_v2"]["params"]["z"], p["proof_b64url"]);
    assert!(s(&v["pay_link"]["link"]).ends_with(&format!("&a={}", s(&c0["anchor_b64url"]))));
}

/// The vector's chain 0 and receipt, played on the contract: a station with
/// ERZGCG's terms (n = 120), 2 fichas, 400 s delivered.
#[test]
fn shared_vectors_on_the_contract() {
    let v: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
    let t = setup();
    let c0 = &v["chains"][0];
    assert_eq!(c0["n"], 120);
    let ch = chain_from(&t.env, unhex(c0["seed_hex"].as_str().unwrap()), 120);
    let s = sess(&t.env, v["pay_link"]["session"].as_str().unwrap());
    t.c.deposit(&t.payer, &t.host, &t.st, &s, &2, &ch[120], &t.terms());
    let q: u32 = v["receipt_v2"]["params"]["q"].as_str().unwrap().parse().unwrap();
    assert_eq!(q, 7);
    let to_payer = t.c.claim(&t.host, &t.st, &s, &ch[120], &q, &ch[(120 - q) as usize]);
    let share = v["payer_share"].as_array().unwrap().iter().find(|x| x["amount"] == "20000000" && x["u"] == 7).unwrap();
    assert_eq!(to_payer.to_string(), share["to_payer"].as_str().unwrap());
}
