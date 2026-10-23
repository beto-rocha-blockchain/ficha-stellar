# Ficha for judges: the 5-minute tour

Ficha is pay-per-minute phone charging on Stellar. The payer's deposit waits
in a Soroban escrow with no admin; the station, which holds no key, proves
with a hash chain how many minutes it did not deliver, and the payer claims
them back. **Everything runs on testnet.**

## 1. Pay a station (2 minutes)

At our table, scan the QR on the station's screen with your phone's camera.

1. The Ficha app opens in the browser. Pick **English**.
2. **Create a new wallet**: write down the 24 words, type back the three it
   asks for, set a PIN. It is a testnet wallet: the app activates it with
   test XLM from Friendbot by itself.
3. Back on the pay page: "Station checked in the signed registry and on the
   custody contract." Choose 1 or 2 fichas and tap **Pay**.
4. Watch the station: it credits the deposit, closes the relay, probes, and
   only then counts time.
5. When the session ends, scan the receipt QR on the station and tap
   **Get … XLM back** (the camera opens it while the FINISHED screen shows
   it, 60 s; the copy left on the waiting screen opens from the app's
   **Scan QR**).

Away from the table: <https://ficha-stellar.vercel.app> (the PWA), and
<https://ficha-stellar.vercel.app/stations> for the stations in the signed
registry.

## 2. Check it on the ledger (1 minute)

- The contract: [`CBRNN2W726PIWP7DLLCAOW663I2TBSMR6N7J7S4CGGUIWIXK4HYI6KYC`](https://stellar.expert/explorer/testnet/contract/CBRNN2W726PIWP7DLLCAOW663I2TBSMR6N7J7S4CGGUIWIXK4HYI6KYC)
  on stellar.expert. Its wasm sha256 is
  `d4314635246e3a17b65d154bd8bae208a94a2594741ed12f3a24198d1e9bd865`;
  `stellar contract build` in `contracts/escrow` with rustc 1.98.1 (target
  `wasm32v1-none`) and stellar-cli 28.1.0 gives the same bytes. Both
  versions are written into the wasm's metadata: another toolchain gives
  another hash, not a different contract.
- A recorded session, run I: [deposit](https://stellar.expert/explorer/testnet/tx/e849584f1fb79a1d0c4d261650f8d470ffd33789e33865e78ceed7143e8d26fc),
  [top-up](https://stellar.expert/explorer/testnet/tx/27b4335b1860b77717096f35eaead7e8528d9f87c2610bdecaca5afaa3e6761b),
  [claim](https://stellar.expert/explorer/testnet/tx/f6c3a51acd8fd192fcda399a8c94085d4b33f04734738abcc410cf015c41f968),
  [pay_host](https://stellar.expert/explorer/testnet/tx/a8219e11bf4d14b44c48ebac0503ece3fea24587f7d5e097e717495c60668cef):
  2 XLM in, 40 s of 120 s charged, 1.5 XLM back to the payer in the claim
  and 0.5 XLM kept for the venue (a claim never touches the venue's
  account), then paid to it by `pay_host`, which anyone may send (the
  venue's phone does it with host mode's **Collect** button).
- Any receipt link can be checked by anyone, with no wallet: the app
  follows its proof to the session on the contract and shows it open, or
  how it settled, with the transactions (while the testnet RPC keeps the
  session's events, about 7 days).
- More runs, including a release after the deadline and a squatter kept
  apart:
  [docs/testnet-e2e.md](../testnet-e2e.md) and
  [contracts/escrow/README.md](../../contracts/escrow/README.md).

## 3. Read the code (2 minutes)

| To see | Open |
|---|---|
| The escrow: deposit, claim with the hash-chain proof, release, host refund, no admin | [`contracts/escrow/src/lib.rs`](../../contracts/escrow/src/lib.rs) |
| Its invariants as tests | [`contracts/escrow/src/test.rs`](../../contracts/escrow/src/test.rs), [`test_spec.rs`](../../contracts/escrow/src/test_spec.rs), [`test_footprint.rs`](../../contracts/escrow/src/test_footprint.rs) (a venue that changes its account cannot fail a claim) |
| A smart-account payer: a contract account whose `__check_auth` checks a secp256r1 (passkey curve) signature pays, tops up and claims | [`contracts/escrow/src/test_account.rs`](../../contracts/escrow/src/test_account.rs) |
| The station's hash chain, pay link and escrow watcher (no key) | [`escrow.py`](../../escrow.py) |
| Paid time counted only while probes prove charging | [`session.py`](../../session.py) |
| The app's deposit and claim: simulate, check the authorization, sign on the phone | [`app/src/custody/`](../../app/src/custody/) |
| Host mode, the venue's side: terms, release, refunds, collecting what the contract holds for it (`pay_host`) | [`app/src/custody/host.ts`](../../app/src/custody/host.ts) |
| The binding spec between the three | [`docs/station-app-contract.md`](../station-app-contract.md), section 7 |
| The architecture and the trust model, honest limits included | [`docs/architecture.md`](../architecture.md) |

Run the tests: `python smoke_test.py` (station), `npm test` in `app/`,
`cargo test` in `contracts/escrow` (after `stellar contract build`; Linux or
WSL).

## What is real, and what is not

- Real: the testnet transactions, the contract, the signed registry, the
  app, the relay switching a charger, the meter and the probes.
- Not: real money (test XLM only), switched mains (the demo switches 5 V),
  an audit (custody stays on testnet; mainnet stations take direct SEP-7
  payments). The meter reads the phone's own battery over ADB, so the phone
  being charged at the demo is ours; your phone pays.
- Built before HackMeridian, entered in the Scale path: see the README's
  status section.
