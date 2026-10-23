#![no_std]
//! FichaEscrow: custody of Ficha's prepaid charging time
//! (docs/station-app-contract.md, section 7, is the contract).
//!
//! Optimistic release, provable refunds. The payer's deposit waits here for
//! one session. The station holds no key and no account: for each session it
//! draws a random seed c0 and puts the tip of a hash chain,
//! anchor = sha256^N(c0), in the pay link. When the session ends it shows
//! c[N-U] in the receipt, which proves that U units of paid time were NOT
//! delivered. Only the payer can present it (claim): U units go back to the
//! payer in that transaction, and the rest is the host's, kept for it until
//! anyone calls `pay_host`. With no claim by the deadline everything goes to
//! the host (release, which anyone may call), which is what a direct payment
//! does today.
//!
//! A session is (host, station, session ID, anchor): a deposit with another
//! anchor under the same ID opens a session of its own, so nobody can take a
//! station's session by paying its QR's ID with a chain of their own. The
//! payer signs the terms it pays under (deposit's `terms`), so a register
//! that lands between the app's read and the deposit fails the deposit.
//!
//! The payer's refund never waits on the host. A claim never touches the
//! host's account: what it reads and writes must not depend on anything the
//! host controls, or a host that changed its account between the payer's
//! simulation and the ledger (merged, no trustline, frozen, or back again)
//! would fail the claim on its footprint and take everything at release. So
//! a claim always keeps the host's share for it, owed, and `pay_host` (by
//! anyone, to the host only) pays it out. release and host_refund pay the
//! host at once, or keep its share owed when its account cannot take it.
//!
//! No admin, no upgrade, no withdraw: whoever deploys this has no power over
//! it. Money leaves only to a session's host or back to its payer.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contractmeta, contracttype, symbol_short,
    token, Address, Bytes, BytesN, Env, Symbol,
};

contractmeta!(
    key = "Description",
    val = "Ficha custody for prepaid charging time: refund by hash-chain proof, no admin, no upgrade"
);

/// Longest hash chain a station may use (bounds a claim's CPU).
pub const MAX_CHAIN: u32 = 256;
/// Most paid time one session may hold (max_fichas x ficha_secs).
pub const MAX_SESSION_SECS: u64 = 86_400;
/// Bounds on the time between the paid time and the deadline.
pub const MIN_GRACE_SECS: u64 = 300;
pub const MAX_GRACE_SECS: u64 = 86_400;

const DAY: u32 = 17_280; // ledgers of ~5 s
// Only register and pay_host extend a TTL: the host's own station entry, and
// what is owed to a host, at the caller's cost (the host's, as a rule). A
// deposit or a claim never does, or any payer could be made to pay the rent
// of the whole contract. The instance and the code are kept alive by
// maintenance (`stellar contract extend`), which needs no permission.
const STATION_TTL_THRESHOLD: u32 = 30 * DAY;
const STATION_TTL_EXTEND_TO: u32 = 60 * DAY;

/// A station's terms, set by its host.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StationCfg {
    /// The asset's contract (the SAC for XLM or USDC).
    pub token: Address,
    /// Price of one ficha in the token's smallest unit (stroops).
    pub price: i128,
    /// Seconds one ficha buys.
    pub ficha_secs: u32,
    /// Most fichas one session may hold.
    pub max_fichas: u32,
    /// Refund granularity in seconds; divides ficha_secs.
    pub unit_secs: u32,
    /// From the end of the paid time to the deadline: time to plug in, the
    /// longest pause and the payer's window to claim.
    pub grace_secs: u64,
    /// false: no new deposits (open sessions still settle).
    pub active: bool,
}

/// The terms a deposit is made under, as the payer saw them: the station's
/// for a new session, the session's own for a top-up. The payer signs them
/// with the deposit, so terms changed after the app read them fail it
/// (TermsChanged) instead of applying.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Terms {
    pub token: Address,
    pub price: i128,
    pub ficha_secs: u32,
    pub max_fichas: u32,
    pub unit_secs: u32,
    pub grace_secs: u64,
}

/// One session's deposit. The terms are a snapshot of the station's at the
/// first deposit (the ones the payer signed): a later register does not
/// change them.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Session {
    pub payer: Address,
    pub token: Address,
    pub price: i128,
    pub ficha_secs: u32,
    pub unit_secs: u32,
    pub max_fichas: u32,
    pub grace_secs: u64,
    /// N = max_fichas x ficha_secs / unit_secs: the longest proof a claim takes.
    pub chain_len: u32,
    pub anchor: BytesN<32>,
    /// Totals over the first deposit and its top-ups.
    pub fichas: u32,
    pub amount: i128,
    /// Ledger time (unix seconds) of the first deposit.
    pub opened: u64,
    /// opened + fichas x ficha_secs + grace_secs.
    pub deadline: u64,
}

/// Storage keys, all persistent.
#[contracttype]
#[derive(Clone)]
pub enum Key {
    /// (host, station ID)
    Station(Address, Symbol),
    /// (host, station ID, session ID, anchor)
    Session(Address, Symbol, Symbol, BytesN<32>),
    /// (host, token): the host's shares kept for it until pay_host: every
    /// claim's, and a release's or host_refund's its account could not take.
    Owed(Address, Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// register: terms out of bounds.
    BadConfig = 1,
    /// deposit: no station under this (host, station).
    UnknownStation = 2,
    /// deposit: the station is not taking deposits.
    Inactive = 3,
    /// deposit: zero fichas, or more than the session may hold.
    BadFichas = 4,
    /// claim, release, host_refund: no open session under this key.
    NoSession = 5,
    /// deposit: another wallet already paid this session (same ID, same
    /// anchor).
    OtherPayer = 6,
    // 7 was AnchorMismatch: a deposit with another anchor now opens a
    // session of its own.
    /// deposit, claim: the session's deadline has passed.
    Expired = 8,
    /// release: the deadline has not passed; host_refund: before it only a
    /// full refund.
    TooEarly = 9,
    /// claim: the proof does not hash to the session's anchor.
    BadProof = 10,
    /// Arithmetic out of range.
    Overflow = 11,
    /// deposit: `terms` are not the station's (a new session) or the
    /// session's (a top-up): they changed after the payer read them.
    TermsChanged = 12,
    /// pay_host: nothing is owed to this host in this token.
    NothingOwed = 13,
}

/// register: the station's terms as they now stand.
#[contractevent(topics = ["station"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StationSet {
    #[topic]
    pub host: Address,
    #[topic]
    pub station: Symbol,
    pub cfg: StationCfg,
}

/// deposit: a new session or a top-up of one.
#[contractevent(topics = ["deposit"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub host: Address,
    #[topic]
    pub station: Symbol,
    #[topic]
    pub session: Symbol,
    pub payer: Address,
    /// Bought by this deposit.
    pub fichas: u32,
    pub amount: i128,
    /// The session's totals after it.
    pub total_fichas: u32,
    pub total_amount: i128,
    pub anchor: BytesN<32>,
    pub deadline: u64,
    /// The session's terms (frozen at its first deposit).
    pub terms: Terms,
}

/// claim, release, host_refund: the session is closed and paid out.
#[contractevent(topics = ["settle"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settled {
    #[topic]
    pub host: Address,
    #[topic]
    pub station: Symbol,
    #[topic]
    pub session: Symbol,
    /// With the session ID, which session this was.
    pub anchor: BytesN<32>,
    pub payer: Address,
    /// The host's share: paid to it, or kept for it (always in a claim), in
    /// which case an `owed` event comes just before this one, in the same
    /// call.
    pub to_host: i128,
    pub to_payer: i128,
    /// Units refunded, at most the units paid.
    pub unused_units: u32,
    /// proof (claim) | deadline (release) | host (host_refund)
    pub how: Symbol,
}

/// A settlement's host share kept here, owed to the host, until pay_host:
/// always in a claim (which never touches the host's account), and in a
/// release or host_refund when the host's account cannot take the token now
/// (merged, no trustline, deauthorized). Published just before that
/// settlement's `settle` event, in the same call.
#[contractevent(topics = ["owed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostOwed {
    #[topic]
    pub host: Address,
    #[topic]
    pub token: Address,
    /// This settlement's share.
    pub amount: i128,
    /// All that is owed to the host in this token now.
    pub total: i128,
}

/// pay_host: what was owed to the host, paid to it.
#[contractevent(topics = ["payout"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostPaid {
    #[topic]
    pub host: Address,
    #[topic]
    pub token: Address,
    pub amount: i128,
}

fn check_cfg(cfg: &StationCfg) -> Result<(), Error> {
    if cfg.price <= 0
        || cfg.ficha_secs == 0
        || cfg.unit_secs == 0
        || cfg.max_fichas == 0
        || cfg.ficha_secs % cfg.unit_secs != 0
        || cfg.grace_secs < MIN_GRACE_SECS
        || cfg.grace_secs > MAX_GRACE_SECS
    {
        return Err(Error::BadConfig);
    }
    // u32 x u32 always fits in u64.
    let session_secs = cfg.max_fichas as u64 * cfg.ficha_secs as u64;
    let chain = cfg.max_fichas as u64 * (cfg.ficha_secs / cfg.unit_secs) as u64;
    if session_secs > MAX_SESSION_SECS || chain > MAX_CHAIN as u64 {
        return Err(Error::BadConfig);
    }
    // A refund computes amount x units + units: keep the largest in range,
    // so no claim can ever fail on arithmetic.
    cfg.price
        .checked_mul(cfg.max_fichas as i128)
        .and_then(|a| a.checked_mul(chain as i128 + 1))
        .ok_or(Error::Overflow)?;
    Ok(())
}

fn station_terms(cfg: &StationCfg) -> Terms {
    Terms {
        token: cfg.token.clone(),
        price: cfg.price,
        ficha_secs: cfg.ficha_secs,
        max_fichas: cfg.max_fichas,
        unit_secs: cfg.unit_secs,
        grace_secs: cfg.grace_secs,
    }
}

fn session_terms(s: &Session) -> Terms {
    Terms {
        token: s.token.clone(),
        price: s.price,
        ficha_secs: s.ficha_secs,
        max_fichas: s.max_fichas,
        unit_secs: s.unit_secs,
        grace_secs: s.grace_secs,
    }
}

fn paid_units(s: &Session) -> u32 {
    s.fichas * (s.ficha_secs / s.unit_secs)
}

/// The payer's share of `units` unused out of `paid` units, rounded up (in
/// the payer's favour). `units` is at most `paid`, and `paid` is at least 1.
fn payer_share(amount: i128, units: u32, paid: u32) -> i128 {
    let units = units as i128;
    let paid = paid as i128;
    (amount * units + paid - 1) / paid
}

fn deadline(s: &Session) -> Result<u64, Error> {
    (s.fichas as u64 * s.ficha_secs as u64)
        .checked_add(s.grace_secs)
        .and_then(|d| d.checked_add(s.opened))
        .ok_or(Error::Overflow)
}

/// How a settlement pays the host's share.
#[derive(Clone, Copy)]
enum HostLeg {
    /// Keep it owed (claim): the payer's transaction never touches the
    /// host's account.
    Owe,
    /// Pay the host now, or keep it owed when its account cannot take it
    /// (release, host_refund).
    Try,
}

#[contract]
pub struct FichaEscrow;

#[contractimpl]
impl FichaEscrow {
    /// The host lists or changes one of its stations. Keyed by (host,
    /// station): nobody can list a station under another host's account.
    /// Open sessions keep the terms they started with.
    pub fn register(env: Env, host: Address, station: Symbol, cfg: StationCfg) -> Result<(), Error> {
        host.require_auth();
        check_cfg(&cfg)?;
        let key = Key::Station(host.clone(), station.clone());
        env.storage().persistent().set(&key, &cfg);
        env.storage()
            .persistent()
            .extend_ttl(&key, STATION_TTL_THRESHOLD, STATION_TTL_EXTEND_TO);
        StationSet { host, station, cfg }.publish(&env);
        Ok(())
    }

    /// A station's terms, or None.
    pub fn station(env: Env, host: Address, station: Symbol) -> Option<StationCfg> {
        env.storage().persistent().get(&Key::Station(host, station))
    }

    /// An open session, or None (never opened, or already settled).
    pub fn session(env: Env, host: Address, station: Symbol, session: Symbol, anchor: BytesN<32>) -> Option<Session> {
        env.storage().persistent().get(&Key::Session(host, station, session, anchor))
    }

    /// What the host is owed in `token`: its shares of claims, and of
    /// releases or host refunds its account could not take, until pay_host.
    /// 0 when nothing.
    pub fn owed(env: Env, host: Address, token: Address) -> i128 {
        env.storage().persistent().get(&Key::Owed(host, token)).unwrap_or(0)
    }

    /// The payer buys `fichas` for the session (host, station, session,
    /// anchor), moving fichas x price of the token into this contract, under
    /// `terms`: the station's for a new session, the session's own for a
    /// top-up (again, by the same payer and before the deadline). Returns the
    /// session's deadline (ledger unix seconds).
    #[allow(clippy::too_many_arguments)]
    pub fn deposit(
        env: Env,
        payer: Address,
        host: Address,
        station: Symbol,
        session: Symbol,
        fichas: u32,
        anchor: BytesN<32>,
        terms: Terms,
    ) -> Result<u64, Error> {
        payer.require_auth();
        let cfg: StationCfg = env
            .storage()
            .persistent()
            .get(&Key::Station(host.clone(), station.clone()))
            .ok_or(Error::UnknownStation)?;
        if !cfg.active {
            return Err(Error::Inactive);
        }
        let now = env.ledger().timestamp();
        let key = Key::Session(host.clone(), station.clone(), session.clone(), anchor.clone());
        let mut s = match env.storage().persistent().get::<_, Session>(&key) {
            Some(s) => {
                if s.payer != payer {
                    return Err(Error::OtherPayer);
                }
                if now > s.deadline {
                    return Err(Error::Expired);
                }
                if terms != session_terms(&s) {
                    return Err(Error::TermsChanged);
                }
                s
            }
            None => {
                if terms != station_terms(&cfg) {
                    return Err(Error::TermsChanged);
                }
                Session {
                    payer: payer.clone(),
                    token: cfg.token.clone(),
                    price: cfg.price,
                    ficha_secs: cfg.ficha_secs,
                    unit_secs: cfg.unit_secs,
                    max_fichas: cfg.max_fichas,
                    grace_secs: cfg.grace_secs,
                    chain_len: cfg.max_fichas * (cfg.ficha_secs / cfg.unit_secs),
                    anchor: anchor.clone(),
                    fichas: 0,
                    amount: 0,
                    opened: now,
                    deadline: now,
                }
            }
        };
        // s.fichas never exceeds s.max_fichas, so this does not underflow.
        if fichas == 0 || fichas > s.max_fichas - s.fichas {
            return Err(Error::BadFichas);
        }
        let amount = s.price.checked_mul(fichas as i128).ok_or(Error::Overflow)?;
        s.fichas += fichas;
        s.amount = s.amount.checked_add(amount).ok_or(Error::Overflow)?;
        s.deadline = deadline(&s)?;
        // Effects before the transfer.
        env.storage().persistent().set(&key, &s);
        token::Client::new(&env, &s.token).transfer(&payer, &env.current_contract_address(), &amount);
        Deposited {
            host,
            station,
            session,
            payer,
            fichas,
            amount,
            total_fichas: s.fichas,
            total_amount: s.amount,
            anchor,
            deadline: s.deadline,
            terms,
        }
        .publish(&env);
        Ok(s.deadline)
    }

    /// The payer presents the station's proof that `unused_units` of paid
    /// time were not delivered: sha256 applied `unused_units` times to
    /// `proof` gives the session's anchor. Until the deadline (inclusive).
    /// Settles at once: the payer's share, rounded up, to the payer; the rest
    /// is owed to the host (pay_host pays it out), so nothing the host does
    /// to its account can fail the claim. Returns the payer's share.
    /// `unused_units` 0 with proof = anchor settles all for the host now.
    /// Any proof up to MAX_CHAIN links counts, the units refunded capped at
    /// the units paid: a proof longer than the session's own chain would
    /// take inverting SHA-256.
    pub fn claim(
        env: Env,
        host: Address,
        station: Symbol,
        session: Symbol,
        anchor: BytesN<32>,
        unused_units: u32,
        proof: BytesN<32>,
    ) -> Result<i128, Error> {
        let key = Key::Session(host.clone(), station.clone(), session.clone(), anchor);
        let s: Session = env.storage().persistent().get(&key).ok_or(Error::NoSession)?;
        s.payer.require_auth();
        if env.ledger().timestamp() > s.deadline {
            return Err(Error::Expired);
        }
        if unused_units > MAX_CHAIN {
            return Err(Error::BadProof);
        }
        let mut h = proof;
        for _ in 0..unused_units {
            h = env.crypto().sha256(&Bytes::from(h)).to_bytes();
        }
        if h != s.anchor {
            return Err(Error::BadProof);
        }
        let paid = paid_units(&s);
        let units = unused_units.min(paid);
        let to_payer = payer_share(s.amount, units, paid);
        Self::settle(&env, &key, host, station, session, s, to_payer, units, symbol_short!("proof"), HostLeg::Owe);
        Ok(to_payer)
    }

    /// After the deadline, by anyone: everything to the host. Returns the
    /// host's share (paid, or owed to it).
    pub fn release(env: Env, host: Address, station: Symbol, session: Symbol, anchor: BytesN<32>) -> Result<i128, Error> {
        let key = Key::Session(host.clone(), station.clone(), session.clone(), anchor);
        let s: Session = env.storage().persistent().get(&key).ok_or(Error::NoSession)?;
        if env.ledger().timestamp() <= s.deadline {
            return Err(Error::TooEarly);
        }
        let amount = s.amount;
        Self::settle(&env, &key, host, station, session, s, 0, 0, symbol_short!("deadline"), HostLeg::Try);
        Ok(amount)
    }

    /// The host gives `units` back of its own accord (an interrupted
    /// session, say). Until the deadline only in full (units at least the
    /// units paid), so the host can never close a session with less than the
    /// station's proof would give the payer; after it, any number. Returns
    /// the payer's share.
    pub fn host_refund(
        env: Env,
        host: Address,
        station: Symbol,
        session: Symbol,
        anchor: BytesN<32>,
        units: u32,
    ) -> Result<i128, Error> {
        host.require_auth();
        let key = Key::Session(host.clone(), station.clone(), session.clone(), anchor);
        let s: Session = env.storage().persistent().get(&key).ok_or(Error::NoSession)?;
        let paid = paid_units(&s);
        if env.ledger().timestamp() <= s.deadline && units < paid {
            return Err(Error::TooEarly);
        }
        let units = units.min(paid);
        let to_payer = payer_share(s.amount, units, paid);
        Self::settle(&env, &key, host, station, session, s, to_payer, units, symbol_short!("host"), HostLeg::Try);
        Ok(to_payer)
    }

    /// By anyone: pays the host what it is owed in `token` (see `owed`),
    /// only ever to the host. Returns the amount paid. While the host's
    /// account still cannot take it the call fails, and it stays owed.
    pub fn pay_host(env: Env, host: Address, token: Address) -> Result<i128, Error> {
        let key = Key::Owed(host.clone(), token.clone());
        let amount: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if amount == 0 {
            return Err(Error::NothingOwed);
        }
        // Effects before the transfer. The entry stays, at 0, and lives on at
        // the caller's cost: a claim then always updates it and never has to
        // create it, so a pay_host landing just before a payer's claim cannot
        // make that claim cost more than it was simulated with (new-entry
        // rent) and fail.
        env.storage().persistent().set(&key, &0i128);
        env.storage()
            .persistent()
            .extend_ttl(&key, STATION_TTL_THRESHOLD, STATION_TTL_EXTEND_TO);
        token::Client::new(&env, &token).transfer(&env.current_contract_address(), &host, &amount);
        HostPaid { host, token, amount }.publish(&env);
        Ok(amount)
    }

    #[allow(clippy::too_many_arguments)]
    fn settle(
        env: &Env,
        key: &Key,
        host: Address,
        station: Symbol,
        session: Symbol,
        s: Session,
        to_payer: i128,
        unused_units: u32,
        how: Symbol,
        host_leg: HostLeg,
    ) {
        // Effects before the transfers: a session settles once.
        env.storage().persistent().remove(key);
        let to_host = s.amount - to_payer;
        let t = token::Client::new(env, &s.token);
        let me = env.current_contract_address();
        // The payer first, and never at the host's mercy.
        if to_payer > 0 {
            t.transfer(&me, &s.payer, &to_payer);
        }
        // A claim (HostLeg::Owe) never touches the host's account: the
        // ledger entries a transaction may touch are fixed when the payer
        // simulates it, so a transfer to the host would put the host's
        // account (or trustline, or balance) in the payer's footprint as it
        // stood then, and a host that changed it before the transaction
        // applied would fail the whole claim. Its share is owed instead, the
        // same entry whatever the host's state. release and host_refund try
        // the host first: a failure there only delays the host's own money.
        let owe = to_host > 0
            && match host_leg {
                HostLeg::Owe => true,
                HostLeg::Try => t.try_transfer(&me, &host, &to_host).is_err(),
            };
        if owe {
            let owed_key = Key::Owed(host.clone(), s.token.clone());
            let before: i128 = env.storage().persistent().get(&owed_key).unwrap_or(0);
            // Every owed stroop is held by this contract: the sum fits.
            let total = before + to_host;
            env.storage().persistent().set(&owed_key, &total);
            HostOwed { host: host.clone(), token: s.token.clone(), amount: to_host, total }.publish(env);
        }
        Settled {
            host,
            station,
            session,
            anchor: s.anchor,
            payer: s.payer,
            to_host,
            to_payer,
            unused_units,
            how,
        }
        .publish(env);
    }
}

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_account;
#[cfg(test)]
mod test_footprint;
#[cfg(test)]
mod test_spec;
#[cfg(test)]
mod test_wasm;
