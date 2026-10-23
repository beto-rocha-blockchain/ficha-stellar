# FichaEscrow

The Soroban contract behind Ficha's custody mode. The payer's deposit for one
charging session waits here. When the session ends, the station's receipt
carries a hash-chain proof of the paid time it did not deliver; with it the
payer claims that part back in one transaction, and the rest is kept for
the host until anyone sends `pay_host`. With no claim by the deadline,
anyone can release everything to the host. No admin, no upgrade, no
withdraw: money leaves only to the session's host or back to its payer. The
station holds no key and only reads the ledger.

Four guarantees, each with its tests:

- The payer's refund never waits on the host, and nothing the host does to
  its account can fail a claim. A claim never touches the host's account:
  the ledger entries a transaction may touch are fixed when the payer
  simulates it, so a host that changed its account before the claim landed
  (merged away, no trustline, frozen, or back again) would otherwise fail
  the whole claim. The host's share is owed to it, and `pay_host` (anyone,
  to that host alone) pays it out. `release` and `host_refund` pay the host
  at once, or keep its share owed when its account cannot take it.
- A session is (host, station, session ID, anchor). Paying a QR's session ID
  with a chain of one's own opens a session of its own: it cannot take the
  station's session or lock its payer out.
- The payer signs the terms it pays under (`deposit`'s `terms`): a register
  that lands between the app's read and the deposit fails it
  (`TermsChanged`) before any money moves.
- The payer can be a smart account. The contract only asks
  `payer.require_auth()`, so a contract account (`C...`) pays, tops up and
  claims under its own `__check_auth`: tested with a minimal account
  contract that checks a secp256r1 signature (the curve passkeys use), with
  real signatures.

The interface, the events, the hash chain and every rule the station and the
app follow are in [docs/station-app-contract.md](../../docs/station-app-contract.md),
section 7. This file is how to build, test and deploy it.

## Testnet deployment

| | |
|---|---|
| Contract | [`CBRNN2W726PIWP7DLLCAOW663I2TBSMR6N7J7S4CGGUIWIXK4HYI6KYC`](https://stellar.expert/explorer/testnet/contract/CBRNN2W726PIWP7DLLCAOW663I2TBSMR6N7J7S4CGGUIWIXK4HYI6KYC) |
| Wasm sha256 (= on-chain wasm hash) | `d4314635246e3a17b65d154bd8bae208a94a2594741ed12f3a24198d1e9bd865` (20 437 bytes) |
| Built with | soroban-sdk 28.0.0, rustc 1.98.1, stellar-cli 28.1.0, `stellar contract build` |
| Deployed | 2026-10-02 by `GBMMSOX2NI6VI2OH3I6L7WAPE3BYHWGUX3NLQSP5WOWFEECD3E4XKZIO`, which has no power over it: upload [`278647e7…`](https://stellar.expert/explorer/testnet/tx/278647e750c251d52dd63e4210aec8c235dedb7350bbc60106b1aec27c33998a), create [`67f9e841…`](https://stellar.expert/explorer/testnet/tx/67f9e84106a10f21459c33b59d24bf8aef25551806515a05ac301721e8228f40) |
| Stations | host `GCJC2PFI…3XTN6` (the demo host), XLM, 1 XLM per ficha, grace 1680 s, both signed by the host: `ERZGCG` (the bench), 300 s fichas, at most 12, unit 30 s, [register](https://stellar.expert/explorer/testnet/tx/cc02486280cf5a72ff3268c782be4c08efd90489705cdde87ae06a87e8f13f39); `YX3DGE` (the Lisbon demo), 60 s fichas, at most 10, unit 15 s, [register](https://stellar.expert/explorer/testnet/tx/1daaf358b9f41f385c7745328bcb20ad10f5b1f420e6ee8d3c9db2d8f6579d4d) |
| XLM on testnet (SAC) | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Retired | `CDC7XU5PNLVM7AJ6SPDDTPUGC67BJ72KKIZOFHG2GGLIL277BIZZGL4K` (wasm `01871cc7…96cb`, 2026-10-02): the second deployment, whose claim paid the host directly, so a host that changed its account between the payer's simulation and the ledger could fail the claim; same interface and events. `CA4HZBR2GTVE6AQUKELHC3EJ3PVBP3CGU6HC6FTXU4Z74FUQBJUVWH36` (wasm `94f3dc49…c5fe`, 2026-09-30): the first, before the other guarantees above, with an older interface. The registry names neither and the app pins neither's code; both were left as they are |

End-to-end run on this contract (2 October 2026, from 05:15 UTC), with
throwaway identities and a test station `TESTE2` that is not in the
registry (0.1 XLM per 60 s ficha, at most 4, unit 15 s, grace 300 s), every
call through `stellar contract invoke`:

| Session | Steps | Result |
|---|---|---|
| A | [register](https://stellar.expert/explorer/testnet/tx/e4b8c7367e856351a141a863b178a2663a153d268bbb30c5540bd6a96208da69), [deposit of 2 fichas](https://stellar.expert/explorer/testnet/tx/8fc4f23685819c4abc93c5b20fc22c49803dde27b44f2b52c5dbaba4dfca9b1d), [claim of 3 unused units of 8](https://stellar.expert/explorer/testnet/tx/97aa669b44ad1809f9bd381b3edd394abe8aac1021409df19f82c64ba74ef496) | 0.075 XLM back to the payer; 0.125 XLM owed to the host (`owed`, then `settle`) |
| C | [deposit](https://stellar.expert/explorer/testnet/tx/a6027446122fdbac68d4753c0ec5c8d489421ff87f0e2f5b47651465e1b192c4), [full host_refund](https://stellar.expert/explorer/testnet/tx/6c57b684e2268ddc3336aaaa2c096d94fa2f5b6cc96f590caf74ae74be2688c8) | all 0.1 XLM back |
| D | another wallet pays the session ID first with a chain of its own ([deposit](https://stellar.expert/explorer/testnet/tx/380d950f72a5c4d5f434b08c6755f5186ab810aa08b0e2597c475001a6dc73b4)); the payer's [deposit](https://stellar.expert/explorer/testnet/tx/d44f8ea0285a1ce8652d0e48bdeb0722302d4f014fe8516b4926af9f93af2b79) with the station's anchor still goes through; the other wallet's [claim](https://stellar.expert/explorer/testnet/tx/d89ff0cbdeb932b7de2f2ac150b9d883d1f43c9ee179809c12fc8cef8dc9a273) settles only its own session; the payer's [claim](https://stellar.expert/explorer/testnet/tx/66d72d2ef466d2f1050a86f3998bd765ab6339136cafa34d2f94b4554c87ccf4) of 2 units of 4 | two sessions under one ID, apart by their anchors; 0.05 XLM back to the payer, 0.05 XLM owed to the host (0.175 XLM owed in all) |
| E | a deposit signed for other terms (price 0.2 XLM), simulated | `Error(Contract, #12)`, `TermsChanged`, before anything is signed |
| B | [deposit](https://stellar.expert/explorer/testnet/tx/ddfa56fcce1493f1cc23b0fdc278e8835a9ccd1ab5e74dc891af333375cf23f8); release before the deadline fails with `TooEarly` (#9); after it, [released to the host by a third party](https://stellar.expert/explorer/testnet/tx/bfd5d2691195dfc714d20ad427b477dc3a619f46bca0ec67d768edda92ab74c1) | all 0.1 XLM to the host's account at once; the deployer only paid the fee: a release needs no signature from the host or the payer |
| | [pay_host by a third party](https://stellar.expert/explorer/testnet/tx/7b1e016e5d4ebec185bf8cdaab0b3c6a52022fa881d3e798f96214908ed36f02) | the 0.175 XLM the claims kept for the host, to the host; `owed` is then 0, and a second `pay_host` fails with `NothingOwed` (#13) at simulation |

The station and the app on this contract, end to end:
[docs/testnet-e2e.md](../../docs/testnet-e2e.md) (runs H to J, the demo's
flow, each ending with a `pay_host`; run K, ESC on the bench; run L, the
deadline and a release). The host whose account cannot receive, or changes it between a
claim's simulation and the ledger, is covered by the tests here
(`src/test.rs`, `src/test_footprint.rs`), not on testnet.

Fees charged on testnet: a deposit 0.036 XLM (mostly rent for the new
session entry; the contract's very first deposit paid 0.083 XLM, with its
token balance entry), a top-up 0.0024 XLM, a claim 0.0024 XLM (0.0116 XLM
when it creates a host's owed entry: the first claim for that host and
token), a full-refund claim 0.0019 XLM, a host_refund 0.0019 XLM, a
release 0.0018 XLM, a pay_host 0.0017 XLM, or 0.07 XLM when it extends the
owed entry (mostly 60 days of rent), a register 0.16 XLM (60 days of rent for the
station entry). The upload cost the deployer 6.23 XLM and the code's
90-day extension 73.7 XLM.

## Build and test

Build only in WSL (Ubuntu): Windows Smart App Control blocks native Rust
builds. Toolchain: Rust with the `wasm32v1-none` target
(`rustup target add wasm32v1-none`) and stellar-cli 28.1.0.

```sh
cd /mnt/c/<path to the repo>/contracts/escrow
stellar contract build      # -> target/wasm32v1-none/release/ficha_escrow.wasm
sha256sum target/wasm32v1-none/release/ficha_escrow.wasm
cargo test                  # after the build: test_wasm.rs loads the wasm
```

The same sources, Cargo.lock and toolchain give the sha256 above. The
build is much faster from a copy on the Linux side (say `~/ficha-escrow`)
than on `/mnt/c`.

- `src/test.rs`: the contract's behaviour (refunds, top-ups, deadlines,
  register rules, frozen terms, worst-case cost), and one regression test
  per finding of the first review: a host that cannot receive (a frozen
  balance, no trustline) never blocks the payer's refund and is paid later
  by `pay_host`; a deposit with a foreign anchor opens a session of its
  own; terms changed after the payer's read fail the deposit, and a proof
  longer than the session's chain still refunds.
- `src/test_footprint.rs`, from the second review: a harness contract
  records a claim's footprint as the payer's simulation would, changes the
  host's balance underneath (frozen to able, or able to frozen), and
  applies the claim with that footprint, as the ledger does. Both went
  through; on the previous build both failed the whole claim with
  `Error(Storage, ExceededLimit)`. Also: a claim never pays the host
  directly, and a claim right after `pay_host` pays no new rent.
- `src/test_account.rs`: a smart account as the payer. A minimal account
  contract whose `__check_auth` checks a secp256r1 signature over the
  authorization payload deposits, tops up and claims with real signatures
  (no mocked auth); another key on that account, another account, or a
  deposit called with other arguments than signed all fail.
- `src/test_spec.rs`: what the spec promises the station and the app: the
  events as published and their wire layout (`owed` and `payout` too, and
  the contract spec's docs saying `owed` comes just before its `settle`),
  the storage keys, the payer's auth tree (the terms are an argument and
  the token transfer a sub-invocation, so terms or a price changed after
  signing fail the deposit), payer + host shares for every U, the
  deadline's edges, no TTL extension on deposit, and `test-vectors.json`.
- `src/test_wasm.rs`: the built wasm in the SDK's VM, with what each call
  costs (`cargo test wasm_costs -- --nocapture`).
- `test-vectors.json`: hash chains, rounding, deadlines, a pay link and a
  receipt, written with Python's hashlib. The station's and the app's tests
  check the same file.

## Deploy (testnet)

```sh
stellar keys generate ficha-dev --network testnet --fund   # deployer: gets no power over the contract
stellar contract deploy --wasm target/wasm32v1-none/release/ficha_escrow.wasm \
  --source-account ficha-dev --network testnet --alias ficha_escrow_v3
```

A new deployment is a new contract ID: the contract cannot be upgraded. The
host registers its stations on it again, the registry then names the new ID
for each station (re-signed), the app pins the new wasm sha256
(`app/src/config.ts`), and sessions open on the old one still settle there.
A running custody station moves in this order: **stop it, publish the
re-signed registry (republish the site), update its `.env`
(`ESCROW_CONTRACT`), start it** (docs/operators.md). Published while the
station still runs on the old ID, the app would pay the new contract where
the station never looks, for up to a minute, until its re-read puts it out
of service.

## Register a station

Signed by the host's key, on the host's own device: never on the station.
`price` is in stroops, the times in seconds; `token` is the asset's SAC
(`stellar contract id asset --asset native --network testnet` for XLM).

```sh
stellar contract invoke --id ficha_escrow_v3 --source-account <host identity> --network testnet -- \
  register --host <host G...> --station ERZGCG \
  --cfg '{"token":"CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC","price":"10000000","ficha_secs":300,"max_fichas":12,"unit_secs":30,"grace_secs":1680,"active":true}'
stellar contract invoke --id ficha_escrow_v3 --source-account ficha-dev --network testnet --send=no -- \
  station --host <host G...> --station ERZGCG
```

## Collect what the host is owed

A claim keeps the host's share in the contract (an `owed` event), and so
does a release or host_refund while the host's account cannot take the
token. Anyone sends it, to the host only, all of it per token in one call;
the host does so now and then (say daily), once its account can take the
token. The Ficha app's host mode shows it under "Held for you in the
contract" and sends `pay_host` with its Collect button. From the CLI:

```sh
stellar contract invoke --id ficha_escrow_v3 --source-account ficha-dev --network testnet --send=no -- \
  owed --host <host G...> --token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
stellar contract invoke --id ficha_escrow_v3 --source-account <any identity> --network testnet -- \
  pay_host --host <host G...> --token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
```

`pay_host` leaves the host's entry at 0 rather than deleting it, and
extends its TTL to 60 days when it has under 30 left, at the sender's
cost: claims then never pay to create it again.

## Keep it alive (TTL)

Nothing a payer does extends a TTL (a deposit would otherwise make one payer
pay the whole contract's rent). Testnet gives a new entry 7 days. Anyone may
extend, with no permission:

```sh
stellar contract extend --id ficha_escrow_v3 --ledgers-to-extend 1555200 \
  --source-account ficha-dev --network testnet                      # instance, ~90 days
stellar contract extend --wasm-hash d4314635246e3a17b65d154bd8bae208a94a2594741ed12f3a24198d1e9bd865 \
  --ledgers-to-extend 1555200 --source-account ficha-dev --network testnet   # code
```

On 2026-10-02 the instance and the code were extended to ledgers 6 534 089
and 6 534 090 (about 2026-12-31;
[instance](https://stellar.expert/explorer/testnet/tx/3dc8ef189fb30f1f5f6f4955c39b9c1f94da6af08ad05489646aee7aaabab067),
[code](https://stellar.expert/explorer/testnet/tx/4a2193f46c744323a27d5ccf559a17f5a832d592ea1584a021a4454bdd3a614e)).
A station's entry lives 60 days from its last `register`, which the host
re-runs to extend it; a host's owed entry, 60 days from a `pay_host` that
found it under 30. Sessions last minutes and need nothing; one left open
past 7 days is archived, and its claim or release then needs a restore first
(the RPC's simulation asks for it). The next testnet reset is announced for
2026-12-16 (developers.stellar.org/docs/networks): after it the contract has
to be deployed and its stations registered again, under a new ID.
