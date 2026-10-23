#![cfg(test)]
//! The built wasm, run in the SDK's VM: what each call costs. Needs
//! `stellar contract build` first (see README.md).
extern crate std;

mod wasm {
    soroban_sdk::contractimport!(file = "target/wasm32v1-none/release/ficha_escrow.wasm");
}

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Bytes, BytesN, Env, Symbol,
};

fn report(env: &Env, what: &str) {
    let r = env.cost_estimate().resources();
    let f = env.cost_estimate().fee();
    std::println!(
        "{what}: instr={} mem={} write_entries={} write_bytes={} | fee total={} stroops (events={}, persistent rent={})",
        r.instructions, r.mem_bytes, r.write_entries, r.write_bytes, f.total, f.contract_events, f.persistent_entry_rent
    );
}

#[test]
fn wasm_costs() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let host = Address::generate(&env);
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &sac.address()).mint(&payer, &(100 * 10_000_000));
    let id = env.register(wasm::WASM, ());
    let c = wasm::Client::new(&env, &id);
    let cfg = wasm::StationCfg {
        token: sac.address(),
        price: 10_000_000,
        ficha_secs: 300,
        max_fichas: 12,
        unit_secs: 15,
        grace_secs: 1680,
        active: true,
    };
    let st = Symbol::new(&env, "ERZGCG");
    c.register(&host, &st, &cfg);
    let terms = wasm::Terms {
        token: cfg.token.clone(),
        price: cfg.price,
        ficha_secs: cfg.ficha_secs,
        max_fichas: cfg.max_fichas,
        unit_secs: cfg.unit_secs,
        grace_secs: cfg.grace_secs,
    };
    report(&env, "register");
    let mut ch: std::vec::Vec<BytesN<32>> = std::vec::Vec::new();
    let mut h = BytesN::from_array(&env, &[1u8; 32]);
    ch.push(h.clone());
    for _ in 0..240 {
        h = env.crypto().sha256(&Bytes::from(h)).to_bytes();
        ch.push(h.clone());
    }
    let s1 = Symbol::new(&env, "F3H9TXAB");
    let a = &ch[240];
    c.deposit(&payer, &host, &st, &s1, &2, a, &terms);
    report(&env, "deposit (new session)");
    c.deposit(&payer, &host, &st, &s1, &1, a, &terms);
    report(&env, "deposit (top-up)");
    c.claim(&host, &st, &s1, a, &14, &ch[240 - 14]);
    report(&env, "claim 14 units");
    let s2 = Symbol::new(&env, "F2222222");
    c.deposit(&payer, &host, &st, &s2, &12, a, &terms);
    c.claim(&host, &st, &s2, a, &240, &ch[0]);
    report(&env, "claim 240 units");
    assert!(env.cost_estimate().resources().instructions < 10_000_000);
    let s3 = Symbol::new(&env, "F3333333");
    let d = c.deposit(&payer, &host, &st, &s3, &1, a, &terms);
    env.ledger().set_timestamp(d + 1);
    c.release(&host, &st, &s3, a);
    report(&env, "release");
    // The longest proof a claim hashes: MAX_CHAIN (256) links.
    let mut long: std::vec::Vec<BytesN<32>> = std::vec::Vec::new();
    let mut h = BytesN::from_array(&env, &[2u8; 32]);
    long.push(h.clone());
    for _ in 0..256 {
        h = env.crypto().sha256(&Bytes::from(h)).to_bytes();
        long.push(h.clone());
    }
    let s4 = Symbol::new(&env, "F4444444");
    c.deposit(&payer, &host, &st, &s4, &12, &long[256], &terms);
    c.claim(&host, &st, &s4, &long[256], &256, &long[0]);
    report(&env, "claim 256 units (worst case)");
    assert!(env.cost_estimate().resources().instructions < 10_000_000);
    // The host's shares of the claims above, owed until anyone pays them out.
    c.pay_host(&host, &sac.address());
    report(&env, "pay_host");
}
