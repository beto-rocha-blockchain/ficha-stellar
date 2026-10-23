# Custody mode, end to end on testnet

Recorded runs of custody mode (docs/station-app-contract.md, section 7)
with real testnet transactions, on 2 October 2026 (UTC) and, for runs M
and N, on 23 October 2026: a station process, the Ficha app's own code,
the FichaEscrow contract and the signed registry, each as it shipped at the
time. Every transaction links to stellar.expert.

Runs H to N are on the current contract, deployed after a second review:
its claim never touches the host's account, and keeps the host's share
owed until `pay_host`. Runs M and N are the latest: the flows of runs J
and K again, after the testnet RPC moved to Stellar RPC 30 (about 20
October), which no longer sends `inSuccessfulContractCall` in getEvents.
With Python stellar-sdk 16.1.0 the station refused every getEvents page
with events in it, so it credited no deposit; runs M and N use the
committed fix (the station reads a record that does not say as a
successful call's, and `requirements.txt` asks for stellar-sdk 16.1.1 or
later), with stellar-sdk 16.1.1. Runs J to L come from the final check
after that review: the station and the app as committed after the second
review's station and app fixes (receipts that take turns on the waiting
screen, the minute re-reads of the registry and the contract, the app's
ledger-clock time bounds and its re-read of the session before a deposit),
with two stations side by side, `YX3DGE` and `ERZGCG`, each reading the
registry as published on the live site, republished just before. Run I
used the same code half an hour earlier, reading the repo's copy of the
registry; run H, an hour earlier, used the station and the app from before
those fixes. Runs D to G were made earlier
the same day on the second deployment, `CDC7XU5P…BIZZGL4K`, retired since
(section 7.1 of the spec): the same interface and events, but its claim
paid the host directly, so a host could fail claims by changing its
account between the payer's simulation and the ledger. Runs A to C were
made on the first deployment, also retired: its interface had no anchor in
a session's key and no terms in the deposit, so the app and the station of
today no longer speak to it.
The transactions of every run stay on the ledger as they were.

The test reads the pay link off the station's screen (`/ws`), checks it
against the signed registry and the contract (§7.4 steps 1 to 4), deposits
(simulated first, its authorization checked, then signed and sent), waits
for the station to credit it and verify the charge with a probe, ends the
session (ESC, E, or the station itself at the deadline), reads the v2
receipt off the FINISHED screen, checks that its proof leads to the
deposit's anchor and that `q` follows §7.7, and claims. It then
compares the balances on the ledger, to the stroop, and the station's log.

## On the current contract

| | |
|---|---|
| Contract | FichaEscrow [`CBRNN2W726PIWP7DLLCAOW663I2TBSMR6N7J7S4CGGUIWIXK4HYI6KYC`](https://stellar.expert/explorer/testnet/contract/CBRNN2W726PIWP7DLLCAOW663I2TBSMR6N7J7S4CGGUIWIXK4HYI6KYC), wasm sha256 `d4314635…d865` |
| Registry | `registry/stations.json` issued `2026-10-02T05:15:00Z`, signed by the testnet registry key, naming this contract for ERZGCG and YX3DGE. Runs J to N: the stations read the copy published at `https://ficha-stellar.vercel.app/registry/stations.json`, the same bytes, with `REGISTRY_CHECK=true`, at startup and at each minute's re-read (each stayed in service, registry and escrow ok, for the whole of its runs). Runs H and I: the station read the repo copy (`REGISTRY_URL` pointed at an `https` address that does not answer): the copy the live site served at the time still named the previous contract |
| Demo host | [`GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6`](https://stellar.expert/explorer/testnet/account/GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6) |
| Station | `main.py` with `.env.lisbon.example` (simulated relay and phone, `MOCK=true`; real deposits, `MOCK_PAYMENT=false`), other values as overrides (ERZGCG: its id, name, 5-minute fichas, at most 60 minutes, unit 30 s); its log and cursor outside the repo. Runs I to N: the committed station files (runs I, M and N exported them with `git archive`; runs J to L ran them from the repository with its own `.env` kept out). Runs M and N: with the Stellar RPC 30 fix, on Python stellar-sdk 16.1.1 |
| Payer | the app's code in `app/src/custody/station.testnet.test.ts` (runs I to N: as committed after the fixes), with a fresh Friendbot account for each run, whose key never left the operator's machine |

### Run M: YX3DGE, the demo's flow, on Stellar RPC 30

Deposit, top-up, E, claim: run J's flow, on 23 October 2026, after the
testnet RPC moved to Stellar RPC 30 (`getVersionInfo`: `30.0.0`, built
20 October, protocol 29). The station started alone at 11:10:19 UTC: it
matched its entry in the published registry and its terms on this
contract, and read the contract's events at once (escrow events ok).
Payer
[`GBDNU5JS…ZBPJ5KCO`](https://stellar.expert/explorer/testnet/account/GBDNU5JS7SFYNI5LNAFTN65QF24FAKSI5ZPM6DFYOBSSSJ7IZBPJ5KCO),
session `YX3DGE.FZB7EM5D`. Test:
`FICHA_E2E_FICHAS=2 FICHA_E2E_TOPUP=1 FICHA_E2E_CHARGE=40 FICHA_E2E_END=e`,
1 passed in 64.4 s.

| Time (UTC) | Step | Transaction | Result |
|---|---|---|---|
| 11:11:47 | deposit, 2 fichas, signing YX3DGE's terms | [754db012…](https://stellar.expert/explorer/testnet/tx/754db0126176e3b5e55781d5e3c292c08a9631039711ec09ff9dc9b1d80c06b1) | 2 XLM into the contract; the station credits it about a second later, closes the relay, and the probe passes 5 s later |
| 11:11:57 | top-up, 1 ficha, while charging | [90bbd9e6…](https://stellar.expert/explorer/testnet/tx/90bbd9e6887d5f1c841599f8d8bd01d5f640a66f15c97096083b56d238294916) | 3 XLM in the session, credited the same second; deadline 28 min after the 3 paid minutes |
| 11:12:36 | E after 40 s of charging | | end reason `stopped`; receipt v2: `p=180&u=40&…&q=10&z=tDumkSby…`, cut confirmed 0.7 s later |
| 11:12:42 | claim with `q=10` and `z` (and the session's anchor) | [e984afe7…](https://stellar.expert/explorer/testnet/tx/e984afe7e8c8d0559a15b461071cb344cc445d1181f2c043390481b4482fc925) | 2.5 XLM back to the payer; 0.5 XLM kept for the host (`owed`, then `settle`, which the station logs the same second); the host's account untouched |

- `q` = ceil((180 − 40) / 15) = 10 of the 12 units paid; the payer's share
  ceil(3 × 10 / 12) = 2.5 XLM.
- Payer: 10000 → 9999.4316926 XLM = − 3 (deposits) − 0.0683074 (fees:
  deposit 0.0658970, top-up 0.0012211, claim 0.0011893) + 2.5.
- Host: its balance did not move at the claim (10071.8087533 XLM before
  and after, checked to the stroop); `owed(host, XLM)` went from 0.85 to
  1.35 XLM. The 0.85 XLM came from claims made earlier that morning by a
  pre-flight check, not recorded here. No `pay_host` followed runs M and
  N: 1.45 XLM stays owed to the host until anyone sends one.
- Station log: `seed`, `credited`, `delivering`, `credited`, `consumed`,
  `finished` (end reason `stopped`, 40 s consumed, 140 s unused), `cut`,
  `settled` (how `proof`, `to_payer` 2.5, `to_host` 0.5, `unused_units` 10).
- The receipt the app read:
  `https://ficha-stellar.vercel.app/r?v=2&m=YX3DGE.FZB7EM5D&n=t&h=GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6&a=3&k=XLM&f=3&p=180&u=40&wh=0.160&x=3725&vd=d&c=1&t=1792753956&q=10&z=tDumkSbyaXiLO5bx8qnCs0K0a_oRvKTbJDsbuHwvMGk`.
- Before the fix, the same morning: the station as committed then
  (stellar-sdk 16.1.0) ran the same flow and never credited the app's
  deposit
  [2f48ee30…](https://stellar.expert/explorer/testnet/tx/2f48ee3023fd5431933925a1f8bfe6b73a4bb7c9226dc05c7800f9d8873489db)
  (10:43:47 UTC): its log said `escrow events error 1 validation error
  for GetEventsResponse`, and the test failed with "no credited deposit
  in 90 s".

### Run N: ERZGCG, the bench (deposit, ESC, claim), on Stellar RPC 30

Run K's flow on `ERZGCG`, on its own station process, started at 11:13:28
UTC after run M's had stopped: registry and contract terms matched, escrow
events ok. Payer
[`GB66EAZE…D7OGOZAJ`](https://stellar.expert/explorer/testnet/account/GB66EAZEYAULPMAUKQOSFBALL4QW2W23YXPHRHD4XFSE2ZDAD7OGOZAJ),
session `ERZGCG.FJA6CBY9`. Test:
`FICHA_E2E_FICHAS=1 FICHA_E2E_CHARGE=40 FICHA_E2E_END=esc`, 1 passed in
66.0 s.

| Time (UTC) | Step | Transaction | Result |
|---|---|---|---|
| 11:13:47 | deposit, 1 ficha | [9444e37d…](https://stellar.expert/explorer/testnet/tx/9444e37dd9b00e12fe0e738229af90532714c9840f51126c890875ea1e1ca901) | 1 XLM into the contract, credited the same second |
| 11:14:34 | ESC after 40 s of charging | | end reason `emergency_stop`; receipt v2: `p=300&u=40&…&q=9`, cut confirmed 0.9 s later |
| 11:14:42 | claim with `q=9` | [cb0e6d14…](https://stellar.expert/explorer/testnet/tx/cb0e6d1460dd6aa0dfdd843018146209a2c3d01c1321ab02b5364f382670b5cc) | 0.9 XLM back to the payer; 0.1 XLM kept for the host; the host's account untouched |

- `q` = ceil((300 − 40) / 30) = 9 of 10 units. Payer: 10000 → 9999.8329139
  XLM = − 1 − 0.0670861 (fees: deposit 0.0658970, claim 0.0011891) + 0.9.
  `owed(host, XLM)` 1.35 → 1.45 XLM.
- Station log: `seed`, `credited`, `delivering`, `consumed`, `finished`
  (end reason `emergency_stop`, 40 s consumed, 260 s unused), `cut`,
  `settled` (how `proof`, `to_payer` 0.9, `to_host` 0.1, `unused_units` 9).
- Right after, the app's own contract suite
  (`FICHA_TESTNET_E2E=1 npx vitest run src/custody/escrow.testnet.test.ts`:
  a throwaway host and station, deposit, top-up, the refusals before
  signing, claim) passed against the same RPC, 1 test in 39.8 s
  (11:15:04 to 11:15:48 UTC). Its accounts are made in memory and its
  transactions are not recorded here.

### Run J: YX3DGE, the demo's flow, with the published registry

Deposit, top-up, E, claim, then `pay_host`. Both stations started at
06:56:31 UTC: each matched its entry in the published registry and its
terms on this contract. Payer
[`GCPDZQ3Q…GWIJPMSN`](https://stellar.expert/explorer/testnet/account/GCPDZQ3QB674PYGO5QF7BGE3C5ASQTWEC5GILQHB4H2O52T3GWIJPMSN),
session `YX3DGE.FY6QXCA2`.

| Time (UTC) | Step | Transaction | Result |
|---|---|---|---|
| 07:00:42 | deposit, 1 ficha, signing YX3DGE's terms | [91a5868e…](https://stellar.expert/explorer/testnet/tx/91a5868e91208fb8fb601a173efdbcb542da30f964c250178a67ff06bea2fa8e) | 1 XLM into the contract; the station credits it within a second, closes the relay, and the probe passes 5 s later |
| 07:00:52 | top-up, 1 ficha, while charging | [6f40ddc4…](https://stellar.expert/explorer/testnet/tx/6f40ddc470e56c3e006758875ab218f386e464d85a221e9c85b759a20ebe8505) | 2 XLM in the session, deadline 28 min after the 2 paid minutes |
| 07:01:30 | E after 40 s of charging | | end reason `stopped`; receipt v2: `p=120&u=40&…&q=6&z=BEgynFXX…`, cut confirmed 0.9 s later |
| 07:01:37 | claim with `q=6` and `z` (and the session's anchor) | [0ef06e87…](https://stellar.expert/explorer/testnet/tx/0ef06e870da2969aae06131c0b44580bbf8e05456c5b071420f6b414c862a423) | 1.5 XLM back to the payer; 0.5 XLM kept for the host (`owed`, then `settle`); the host's account untouched |
| 07:02:12 | `pay_host`, sent by a third party (the deployer) | [6861c0c4…](https://stellar.expert/explorer/testnet/tx/6861c0c4c66b2b3e0e325b258fce799584639b34771905b31dc456b3e745cecf) | the 1.1 XLM owed (this run's 0.5, run K's 0.1 and the first attempt's 0.5, below), to the host only; `owed` back to 0; fee 0.0016767 XLM |

- `q` = ceil((120 − 40) / 15) = 6 of the 8 units paid; the payer's share
  ceil(2 × 6 / 8) = 1.5 XLM.
- Payer: 10000 → 9999.4594785 XLM = − 2 (deposits) − 0.0405215 (fees:
  deposit 0.0357015, top-up 0.0024429, claim 0.0023771) + 1.5.
- Host: its balance did not move at the claim (checked to the stroop);
  `owed(host, XLM)` went from 0.6 to 1.1 XLM (the claims of run K and of
  the first attempt came before it), then `pay_host` paid all of it.
- Station log: `seed`, `credited`, `delivering`, `credited`, `consumed`,
  `finished` (end reason `stopped`, 40 s consumed, 80 s unused), `cut`,
  `settled` (how `proof`, `to_payer` 1.5, `to_host` 0.5, `unused_units` 6),
  then the session record and the next session's `seed`.
- The receipt the app read:
  `https://ficha-stellar.vercel.app/r?v=2&m=YX3DGE.FY6QXCA2&n=t&h=GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6&a=2&k=XLM&f=2&p=120&u=40&wh=0.133&x=3045&vd=d&c=1&t=1790924490&q=6&z=BEgynFXXrUeMsabxZNuwirEskKyxSgC0glupvJvIyTg`.
  Opened on the live site with no wallet, it shows "Checked in public on
  the blockchain": settled with the proof, 1.5 XLM back to the payer and
  0.5 XLM to the venue, with the settle and deposit transactions.
- The first attempt at this run, session `YX3DGE.FWWYMRCD` (payer
  [`GBY6HYMA…AE7PUJIN`](https://stellar.expert/explorer/testnet/account/GBY6HYMAODPVDSPVJORYG247ZEER4YMSCZPBVYEFYYVZW6WDAE7PUJIN)),
  ran at the same time as run K, under the same host: deposit
  [c7e2fbed…](https://stellar.expert/explorer/testnet/tx/c7e2fbed2d80e9832f5b0546228af947df4068f4cb233ef388491b1ea1ef5d14),
  top-up [4a087f90…](https://stellar.expert/explorer/testnet/tx/4a087f90e959bc9aeb4864c68397699c1c4c47e21aa19ebf30deb3c98399fd2d),
  E after 40 s, claim [8f6f7abb…](https://stellar.expert/explorer/testnet/tx/8f6f7abbb0883025d9baebd9978432b39381c3523f370369e829242e3964d4bb).
  On the ledger and in the station's log it went exactly as run J (1.5 XLM
  back, 0.5 XLM owed, settled by proof, the payer's balance right to the
  stroop), but the test's check of the host's owed amount saw + 0.6 XLM:
  its own 0.5 and run K's 0.1, claimed in the same minute. The test
  reads `owed` before and after, so it needs the host to itself; run J
  repeated the flow alone.

### Run K: ERZGCG, the bench (deposit, ESC, claim)

`ERZGCG`: 1 XLM per 5-minute ficha, refund unit 30 s, grace 1680 s, on its
own station process next to YX3DGE's. Payer
[`GCFW5AER…ZUHBQD7`](https://stellar.expert/explorer/testnet/account/GCFW5AERF3D7DW7XS44DKJXKQ66RHAF4JTO3H25NJTSUDVCB4ZUHBQD7),
session `ERZGCG.FDR8BD82`.

| Time (UTC) | Step | Transaction | Result |
|---|---|---|---|
| 06:58:17 | deposit, 1 ficha | [abe70121…](https://stellar.expert/explorer/testnet/tx/abe701211d4389aac7db39bb01508c66e1853bc686b14e0a3f436d6b2e189277) | 1 XLM into the contract, credited the same second |
| 06:59:05 | ESC after 40 s of charging | | end reason `emergency_stop`; receipt v2: `p=300&u=40&…&q=9`, cut confirmed |
| 06:59:12 | claim with `q=9` | [3ba576eb…](https://stellar.expert/explorer/testnet/tx/3ba576ebf9fa2a103808d9cef4fdcdaf55c8cca1a837c522ed8f4dbd7f47bd6a) | 0.9 XLM back to the payer; 0.1 XLM kept for the host; the host's account untouched |

- `q` = ceil((300 − 40) / 30) = 9 of 10 units. Payer: 10000 → 9999.8619330
  XLM = − 1 − 0.0380670 (fees: deposit 0.0356883, claim 0.0023787) + 0.9.
  `owed(host, XLM)` 0 → 0.1 XLM, paid out by run J's `pay_host`.
- Station log: `seed`, `credited`, `delivering`, `consumed`, `finished`
  (end reason `emergency_stop`, 40 s consumed, 260 s unused), `cut`,
  `settled` (how `proof`, `to_payer` 0.9, `to_host` 0.1, `unused_units` 9).

### Run L: YX3DGE, the deadline, then release

No claim: the payer leaves the receipt unused, and after the deadline
anyone releases the whole deposit to the host. The same station as run J
(this session came first; run J and its first attempt ran on the same
station while its receipt waited).
Payer [`GBUYKFNR…BTYJGQYV`](https://stellar.expert/explorer/testnet/account/GBUYKFNRUYVGBHVERYHFR3X26KQ3OGSUTGKE56BHHMRY4AM7BTYJGQYV),
session `YX3DGE.F5MAGKKQ`.

| Time (UTC) | Step | Transaction | Result |
|---|---|---|---|
| 06:57:12 | deposit, 1 ficha | [d055861c…](https://stellar.expert/explorer/testnet/tx/d055861c67ff60f7309855173226d8edf5ca0adf9ea242c6ddbbfb7d77758f75) | 1 XLM into the contract, deadline 07:26:12 (60 s paid + 1680 s grace) |
| 06:57:39 | E after 20 s of charging | | end reason `stopped`; receipt v2: `p=60&u=20&…&q=3`, cut confirmed 0.8 s later |
| | no claim | | between the station's later sessions, the receipt waits on its waiting screen (as a `ficha:` link) |
| 07:26:12 | the deadline passes, in ledger time | | the station drops the receipt from its waiting screen at that second ("deadline passed, nothing left to claim"); a claim with the receipt's proof now fails at simulation with `Expired`, before anything is signed |
| 07:26:47 | `release`, sent by the payer: anyone may | [221be524…](https://stellar.expert/explorer/testnet/tx/221be5240692735a0329a665845bd5197acdf7030e1c744772630c75b63d8508) | all 1 XLM to the host's account at once (a release pays the host directly, not through `owed`); fee 0.001799 XLM |

- `q` = ceil((60 − 20) / 15) = 3 of 4 units: what the payer could have
  claimed until 07:26:12 (0.75 XLM).
- After the release, a second `release` fails at simulation with
  `NoSession`. Host: + 1 XLM exactly. Payer: 10000 → 9998.9625127 XLM
  = − 1 − 0.0374873 (fees: deposit 0.0356883, release 0.001799).
- Station log: `seed`, `credited`, `delivering`, `finished` (end reason
  `stopped`, 20 s consumed, 40 s unused), `cut`, `session`, then 29
  minutes later `settled` (how `deadline`, `to_payer` 0, `to_host` 1,
  `unused_units` 0). Through the wait the station stayed in service.

### Run I: YX3DGE, ended with E, on the current station and app

The same flow as run H, after the second review's station and app fixes.
The station started at 06:29:22 UTC: YX3DGE matched its entry in the
registry and its terms on this contract. Payer
[`GDT4C4SM…NLVXZF6D`](https://stellar.expert/explorer/testnet/account/GDT4C4SMPL6XAOWOG3TXH3VYNZY7QKI6MESSQVPFBUOVFL4UNLVXZF6D),
session `YX3DGE.FPE9QPJB`.

| Time (UTC) | Step | Transaction | Result |
|---|---|---|---|
| 06:29:42 | deposit, 1 ficha, signing YX3DGE's terms | [e849584f…](https://stellar.expert/explorer/testnet/tx/e849584f1fb79a1d0c4d261650f8d470ffd33789e33865e78ceed7143e8d26fc) | 1 XLM into the contract; the station credits it within a second, closes the relay, and the probe passes 5 s later |
| 06:29:52 | top-up, 1 ficha, while charging | [27b4335b…](https://stellar.expert/explorer/testnet/tx/27b4335b1860b77717096f35eaead7e8528d9f87c2610bdecaca5afaa3e6761b) | 2 XLM in the session, deadline 28 min after the 2 paid minutes |
| 06:30:29 | E after 40 s of charging | | end reason `stopped`; receipt v2: `p=120&u=40&…&q=6&z=l7CU_YG6…`, cut confirmed 1 s later |
| 06:30:37 | claim with `q=6` and `z` (and the session's anchor) | [f6c3a51a…](https://stellar.expert/explorer/testnet/tx/f6c3a51acd8fd192fcda399a8c94085d4b33f04734738abcc410cf015c41f968) | 1.5 XLM back to the payer; 0.5 XLM kept for the host (`owed`, then `settle`); the host's account untouched |
| 06:31:07 | `pay_host`, sent by a third party (the deployer) | [a8219e11…](https://stellar.expert/explorer/testnet/tx/a8219e11bf4d14b44c48ebac0503ece3fea24587f7d5e097e717495c60668cef) | the 0.5 XLM owed, to the host only; `owed` back to 0; fee 0.0016767 XLM (the entry had more than 30 days left: no extension) |

- `q` = ceil((120 − 40) / 15) = 6 of the 8 units paid; the payer's share
  ceil(2 × 6 / 8) = 1.5 XLM.
- Payer: 10000 → 9999.4595181 XLM = − 2 (deposits) − 0.0404819 (fees:
  deposit 0.0356619, top-up 0.0024429, claim 0.0023771) + 1.5. The claim
  only updated the demo host's owed entry, which run H created.
- Host: its balance did not move at the claim (checked to the stroop);
  `owed(host, XLM)` went from 0 to 0.5 XLM, then `pay_host` paid it.
- Station log: `seed`, `credited`, `delivering`, `credited`, `consumed`,
  `finished` (end reason `stopped`, 40 s consumed, 80 s unused), `cut`,
  `settled` (how `proof`, `to_payer` 1.5, `to_host` 0.5, `unused_units` 6),
  then the session record, and the next session's `seed`.
- The receipt the app read:
  `https://ficha-stellar.vercel.app/r?v=2&m=YX3DGE.FPE9QPJB&n=t&h=GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6&a=2&k=XLM&f=2&p=120&u=40&wh=0.135&x=3162&vd=d&c=1&t=1790922629&q=6&z=l7CU_YG6wDmqcEFOb7USgzFgpiL6ZdkhoSoStqzVVFY`
  (settled: its proof can no longer be used).

### Run H: YX3DGE, ended with E (deposit, top-up, E, claim, then pay_host)

The demo's flow on the current contract, with the station and the app from
before the second review's station and app fixes. The station started at 05:19:33
UTC: YX3DGE matched its entry in the registry and its terms on this
contract. Payer [`GAWHCTJH…AAC5OQ7R`](https://stellar.expert/explorer/testnet/account/GAWHCTJHVP55P6VFDA6OD2VRHIW3W4BURITSY7N62TQ5DASIAAC5OQ7R),
session `YX3DGE.FH8BXR4G`.

| Time (UTC) | Step | Transaction | Result |
|---|---|---|---|
| 05:14:07 | the host registers YX3DGE on this contract (1 XLM, 60 s, 10 fichas, 15 s, 1680 s) | [1daaf358…](https://stellar.expert/explorer/testnet/tx/1daaf358b9f41f385c7745328bcb20ad10f5b1f420e6ee8d3c9db2d8f6579d4d) | fee 0.1630245 XLM, mostly 60 days of rent |
| 05:19:52 | deposit, 1 ficha, signing YX3DGE's terms | [475dba1f…](https://stellar.expert/explorer/testnet/tx/475dba1f1a1bddbe5eb7af787089e3c9cd22e02932a83891040d317cab0d1e8b) | 1 XLM into the contract; the station credits it, closes the relay and verifies the charge with a probe |
| 05:20:02 | top-up, 1 ficha, while charging | [c39a81d5…](https://stellar.expert/explorer/testnet/tx/c39a81d543f4209b82437c4868c5050a8a3c747146a6345774658105e1cc92cf) | 2 XLM in the session, deadline 28 min after the 2 paid minutes |
| 05:20:39 | E after 40 s of charging | | end reason `stopped`; receipt v2: `p=120&u=40&…&q=6&z=BnPnZOgM…`, cut confirmed |
| 05:20:47 | claim with `q=6` and `z` (and the session's anchor) | [0ec01b2d…](https://stellar.expert/explorer/testnet/tx/0ec01b2db355315393abeceb429135e95a5d0e3caad5f113fd0b1e05ba4cbbd6) | 1.5 XLM back to the payer; 0.5 XLM kept for the host (`owed`, then `settle`); the host's account untouched |
| 05:23:07 | `pay_host`, sent by a third party (the deployer): anyone may | [26b4a846…](https://stellar.expert/explorer/testnet/tx/26b4a846d1e1375cd746577f65549cdf6d1a3ae42ff362c73f4593e2e9dbe5a1) | the 0.5 XLM owed, to the host only; `owed` back to 0 |

- `q` = ceil((120 − 40) / 15) = 6 of the 8 units paid; the payer's share
  ceil(2 × 6 / 8) = 1.5 XLM.
- Payer: 10000 → 9999.4503019 XLM = − 2 (deposits) − 0.0496981 (fees of
  three transactions) + 1.5. The claim's fee, 0.0115603 XLM, includes
  creating the demo host's owed entry, the first on this contract; a later
  claim only updates it (0.0024 XLM in the CLI run).
- Host: its balance did not move at the claim (checked to the stroop);
  `owed(host, XLM)` went from 0 to 0.5 XLM, then `pay_host` paid it.
- Station log: `seed`, `credited`, `delivering`, `credited`, `consumed`,
  `finished` (end reason `stopped`), `cut`, `settled` (how `proof`,
  `to_payer` 1.5, `to_host` 0.5, `unused_units` 6, the session's `anchor`).
- The receipt the app read:
  `https://ficha-stellar.vercel.app/r?v=2&m=YX3DGE.FH8BXR4G&n=t&h=GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6&a=2&k=XLM&f=2&p=120&u=40&wh=0.129&x=3036&vd=d&c=1&t=1790918439&q=6&z=BnPnZOgMO9EM1I7iC4TZlpU5-sS3TYE36XApj_zgdCI`
  (settled: its proof can no longer be used).

### Also on this contract

- The contract's own run with `stellar contract invoke`
  (`contracts/escrow/README.md`): two claims whose host shares were kept
  as owed, a full `host_refund`, another wallet paying a session ID first
  with a chain of its own while the payer's deposit under the same ID still
  goes through, a deposit signed for terms that are no longer the
  station's (`TermsChanged` at simulation), a release after the deadline
  by a third party, paid to the host at once, and `pay_host` by a third
  party for the claims' shares.
- The app's other opt-in tests passed against it, last alongside runs J
  to L with the app as committed: `escrow.testnet.test.ts`
  (deposit, top-up, refusals before signing, `OtherPayer` and
  `TermsChanged` among them, claim, and a squatter's session under the
  same ID refunded on its own) and `host.testnet.test.ts` (register, the
  host's view, a full refund before the deadline, release all and a partial
  refund after it; and, with host mode's own code, a claim whose host
  share the view then shows as owed, collected with `pay_host`, after
  which a second `pay_host` fails with `NothingOwed` at simulation).
- The app's public check of a receipt (`publicReceipt`, what `/r` shows a
  wallet that did not pay) on run H's receipt, against testnet and in a
  browser on a local build, and on run J's receipt on the live site: settled
  by proof, 1.5 XLM back to the payer and 0.5 XLM to the venue, with the
  transactions.

## On the second deployment (retired)

| | |
|---|---|
| Contract | FichaEscrow [`CDC7XU5PNLVM7AJ6SPDDTPUGC67BJ72KKIZOFHG2GGLIL277BIZZGL4K`](https://stellar.expert/explorer/testnet/contract/CDC7XU5PNLVM7AJ6SPDDTPUGC67BJ72KKIZOFHG2GGLIL277BIZZGL4K), wasm sha256 `01871cc7…96cb`, retired: its claim paid the host directly |
| Registry | `registry/stations.json` issued `2026-10-02T02:18:00Z`, signed by the testnet registry key. Run D: the station read the repo copy (the published one still had the earlier issue). Runs E and F: the station read the copy published at `https://ficha-stellar.vercel.app/registry/stations.json`, the same bytes, with `REGISTRY_CHECK=true` |
| Demo host | [`GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6`](https://stellar.expert/explorer/testnet/account/GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6) |
| Station | `main.py` with `.env.lisbon.example` (simulated relay and phone, `MOCK=true`; real deposits, `MOCK_PAYMENT=false`), other values as overrides; its log and cursor outside the repo |
| Payer | the app's code in `app/src/custody/station.testnet.test.ts`, with a fresh Friendbot account for each run, whose key never left the operator's machine |

In these runs a claim paid the host its share in the same transaction,
as the results below say; on the current contract that share is kept for
the host until `pay_host`.

### Run D: YX3DGE, the Lisbon demo (deposit, top-up, claim)

Payer [`GD3ZPE7F…T24G4O3`](https://stellar.expert/explorer/testnet/account/GD3ZPE7FGVVNUFRJOUHRBRL22AIBCFYBFHXHC4BEPB2BABUCMT24G4O3), session `YX3DGE.FP9MPJXV`.

| Time (UTC) | Step | Transaction | Result |
|---|---|---|---|
| 01:52:37 | the host registers YX3DGE on this contract (1 XLM, 60 s, 10 fichas, 15 s, 1680 s) | [06e091f7…](https://stellar.expert/explorer/testnet/tx/06e091f72ba25ee44b5f4d7866f51310cfa84f5d6d89a8738ad2838cbbce9c95) | fee 0.1682302 XLM, mostly 60 days of rent |
| 02:20:17 | deposit, 1 ficha, signing YX3DGE's terms | [78c33a2f…](https://stellar.expert/explorer/testnet/tx/78c33a2fb9f328b3d50723babb60fc3ab07060d5743ba587e0d796249357574a) | 1 XLM into the contract; the station credits it within a second, closes the relay, probes and starts the countdown 7 s later |
| 02:20:27 | top-up, 1 ficha, while charging | [516f2925…](https://stellar.expert/explorer/testnet/tx/516f292599aafe92979b5d777a43ec892ddc3181a4f4657cc61da2e154985f8c) | 2 XLM in the session, deadline 28 min after the 2 paid minutes |
| 02:21:05 | ESC after 40 s of charging | | receipt v2: `p=120&u=40&…&q=6&z=qx3QaK-G…`, cut confirmed |
| 02:21:12 | claim with `q=6` and `z` (and the session's anchor) | [ed36bdc3…](https://stellar.expert/explorer/testnet/tx/ed36bdc3ac92f91127fa4239f87a930f4dd155923968a26b88999c94afa96ca0) | 1.5 XLM back to the payer, 0.5 XLM to the host |

- `q` = ceil((120 − 40) / 15) = 6 of the 8 units paid; the payer's share
  ceil(2 × 6 / 8) = 1.5 XLM.
- Payer: 10000 → 9999.4582448 XLM = − 2 (deposits) − 0.0417552 (fees of
  three transactions) + 1.5. Host: + 0.5 XLM.
- Station log: `seed`, `credited`, `delivering`, `credited`, `consumed`,
  `finished`, `cut`, `settled` (how `proof`, `to_payer` 1.5, `unused_units`
  6, and the session's `anchor`).
- The receipt the app read:
  `https://ficha-stellar.vercel.app/r?v=2&m=YX3DGE.FP9MPJXV&n=t&h=GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6&a=2&k=XLM&f=2&p=120&u=40&wh=0.135&x=3185&vd=d&c=1&t=1790907665&q=6&z=qx3QaK-GO-8lvKPJ7Pti5cymzXLyUGdjKliOoEyN3Lo`
  (settled: its proof can no longer be used).

### Run E: YX3DGE, ended with E (deposit, top-up, E, claim)

The demo's own flow: the operator presses E when the customer is done.
Payer [`GBLT6Y6B…NPLIYGE`](https://stellar.expert/explorer/testnet/account/GBLT6Y6B4DCWOYAIXTN567J4BVNZKJL7H56YYFXE5FYYDUVELNPLIYGE), session `YX3DGE.F28KSPT9`.

| Time (UTC) | Step | Transaction | Result |
|---|---|---|---|
| 03:42:23 | the station starts: YX3DGE matches its entry in the published registry and its terms on the contract | | pay link on screen |
| 03:42:47 | deposit, 1 ficha, signing YX3DGE's terms | [e622e758…](https://stellar.expert/explorer/testnet/tx/e622e758cca614a87f646fb451cc5f90c57128e2fd0b6c7d4257dc7b3e6b8082) | 1 XLM into the contract; the station credits it within a second, closes the relay, and the probe passes 5 s later |
| 03:42:57 | top-up, 1 ficha, while charging | [5ac24e76…](https://stellar.expert/explorer/testnet/tx/5ac24e76e84bf55a2b73189934c571638501cb1664267cc5b6eb49217696361b) | 2 XLM in the session, deadline 04:12:47, 28 min after the 2 paid minutes |
| 03:43:35 | E after 40 s of charging | | end reason `stopped`; receipt v2: `p=120&u=40&…&q=6&z=R3qnPKiP…`, cut confirmed 0.9 s later |
| 03:43:42 | claim with `q=6` and `z` (and the session's anchor) | [119d08e2…](https://stellar.expert/explorer/testnet/tx/119d08e2cdb594c39bf604ef6354f56bb56dc510cdcddfe3510bc954d56eede6) | 1.5 XLM back to the payer, 0.5 XLM to the host |

- `q` = ceil((120 − 40) / 15) = 6 of the 8 units paid; the payer's share
  ceil(2 × 6 / 8) = 1.5 XLM.
- Payer: 10000 → 9999.4586282 XLM = − 2 (deposits) − 0.0413718 (fees of
  three transactions) + 1.5. Host: + 0.5 XLM.
- Station log: `seed`, `credited`, `credited`, `delivering`, `consumed`,
  `finished` (end reason `stopped`, 40 s consumed, 80 s unused), `cut`,
  `settled` (how `proof`, `to_payer` 1.5, `unused_units` 6, the session's
  `anchor`).

### Run F: ERZGCG, the bench (deposit, ESC, claim)

`ERZGCG`: 1 XLM per 5-minute ficha, refund unit 30 s, grace 1680 s.
Payer [`GB3QDKUN…Y6POX7QJ`](https://stellar.expert/explorer/testnet/account/GB3QDKUNSLN2CMWPFBHMO6H3QQNQ2NSZRQSPIGTVB6KS4DCEY6POX7QJ), session `ERZGCG.FCRJV36S`.

| Time (UTC) | Step | Transaction | Result |
|---|---|---|---|
| 03:44:32 | deposit, 1 ficha | [ed42831a…](https://stellar.expert/explorer/testnet/tx/ed42831ad695152873fc9a69251c5204b5ea94476f51bb2ae946315710e6caa0) | 1 XLM into the contract, credited the same second |
| 03:45:20 | ESC after 40 s of charging | | end reason `emergency_stop`; receipt v2: `p=300&u=40&…&q=9`, cut confirmed |
| 03:45:27 | claim with `q=9` | [42fcb737…](https://stellar.expert/explorer/testnet/tx/42fcb737d3e8ccd4478a559617527893b9ee60a20d8a44c3bf34948d7179b170) | 0.9 XLM back to the payer, 0.1 XLM to the host |

- `q` = ceil((300 − 40) / 30) = 9 of 10 units. Payer: − 1 − 0.0389305
  (fees) + 0.9 XLM. Host: + 0.1 XLM. Station log as in run E, end reason
  `emergency_stop`, settled by proof.

### Run G: the deadline in ledger time, then release

As run C below, on this contract and with the station's deadline decisions
in ledger time (the latest ledger's close time from `getEvents`), not its
own clock. A throwaway station, `SNKHCC`, under the same throwaway host
[`GAAZD3D4…OV3GRNO5V`](https://stellar.expert/explorer/testnet/account/GAAZD3D4QM3KX32TSMYFUWQ2UNURSB6SCDHJAMPUMSJ4T54OV3GRNO5V),
not in the registry (`REGISTRY_CHECK=false`, the app test with
`FICHA_E2E_UNLISTED=1`): 0.1 XLM per 1-minute ficha, up to 4, unit 15 s,
grace 1080 s (900 + the default 180 s plug timeout). The simulated phone
was unplugged 20 s after the charge was verified. Payer
[`GDLXLJDW…6JPSVCMD`](https://stellar.expert/explorer/testnet/account/GDLXLJDWNDOT2WMKAQVL3SASKGGGQLQCNPCET7BOALR47EUU6JPSVCMD),
session `SNKHCC.FDE6CPHN`.

| Time (UTC) | Step | Transaction | Result |
|---|---|---|---|
| 03:46:02 | the throwaway host registers SNKHCC on this contract | [84776c7b…](https://stellar.expert/explorer/testnet/tx/84776c7b30860d5b8798c061abe3e00b8bd4df88f8f980be7aea9087b4100a9a) | fee 0.1665559 XLM, mostly 60 days of rent |
| 03:47:02 | deposit, 2 fichas | [40b1069d…](https://stellar.expert/explorer/testnet/tx/40b1069dced3dc3534ae5fd01e46ec5c0ce83b4fea55e31b511cd841d866cc84) | 0.2 XLM into the contract, deadline 04:07:02 |
| 03:47:30 | phone unplugged after 20 s of charging | | paused at 03:47:53 (those seconds given back) |
| 03:52:02 | the station ends the session: deadline − 900 s, in ledger time | | end reason `deadline`, receipt v2 `p=120&u=23&…&q=7`, `c=0` (no current before the relay opened: nothing to see drop) |
| | no claim | | |
| 04:07:02 | the deadline passes | | the station drops the last receipt from its waiting screen at that second ("nothing left to claim"); a claim with the receipt's proof now fails at simulation with `Expired`, before anything is signed |
| 04:07:37 | `release`, sent by the payer: anyone may | [1b125087…](https://stellar.expert/explorer/testnet/tx/1b125087b2134d386f12288eaf197c6229c8c620c34b70c128cc85d7ac3a0db7) | all 0.2 XLM to the host; fee 0.0017991 XLM |

- `q` = ceil((120 − 23) / 15) = 7 of 8 units: what the payer could have
  claimed until 04:07:02 (0.175 XLM).
- After the release, a second `release` fails at simulation with
  `NoSession`. Host: + 0.2 XLM exactly. Station log: `seed`, `credited`,
  `delivering`, `consumed`, `finished`, `session` (end reason `deadline`,
  272 s paused, `refund_hint` with 7 units, 0.175 XLM, the refund the payer
  did not claim), `settled` (how `deadline`, `to_payer` 0, `to_host` 0.2,
  `unused_units` 0).

### Also on the second deployment

- The contract's own run with `stellar contract invoke`: a claim, a full
  `host_refund`, another wallet paying a session ID first with a chain of
  its own while the payer's deposit under the same ID still goes through, a
  deposit signed for terms that are no longer the station's
  (`TermsChanged` at simulation), and a release after the deadline by a
  third party.
- The app's other opt-in tests passed against it the same night, and again
  with the app as it then shipped, alongside runs E to G:
  `escrow.testnet.test.ts` (deposit, top-up, refusals before signing,
  `OtherPayer` and `TermsChanged` among them, claim, and a squatter's
  session under the same ID refunded on its own) and `host.testnet.test.ts`
  (register, the host's view, a full refund before the deadline, release
  all and a partial refund after it).

## On the first deployment (retired)

| | |
|---|---|
| Contract | FichaEscrow [`CA4HZBR2GTVE6AQUKELHC3EJ3PVBP3CGU6HC6FTXU4Z74FUQBJUVWH36`](https://stellar.expert/explorer/testnet/contract/CA4HZBR2GTVE6AQUKELHC3EJ3PVBP3CGU6HC6FTXU4Z74FUQBJUVWH36), wasm sha256 `94f3dc49…c5fe`, retired |
| Registry | `registry/stations.json` issued `2026-10-02T00:15:00Z`, signed by the testnet registry key; the same bytes were published at `https://ficha-stellar.vercel.app/registry/stations.json` |
| Demo host | [`GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6`](https://stellar.expert/explorer/testnet/account/GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6) |
| Station | as above |
| Payer | as above, with fresh Friendbot accounts |

### Run A: YX3DGE, the Lisbon demo (deposit, top-up, claim)

`YX3DGE`: 1 XLM per 1-minute ficha, refund unit 15 s, grace 1680 s.
Payer [`GDQYORNM…HBB7TMB`](https://stellar.expert/explorer/testnet/account/GDQYORNMUMGO2APXWRZW3RZMCSBCJUTL2RP5FAJNMMHFH5Y4WHBB7TMB), session `YX3DGE.FNF4P358`.

| Time (UTC) | Step | Transaction | Result |
|---|---|---|---|
| 00:11:57 | the host registers YX3DGE (1 XLM, 60 s, 10 fichas, 15 s, 1680 s) | [a08089fb…](https://stellar.expert/explorer/testnet/tx/a08089fb6408d7b995a71792f437a5557eda2c9bb65736c33fa20bc20229231f) | fee 0.1675893 XLM, mostly 60 days of rent |
| 00:20:27 | deposit, 1 ficha | [103d6781…](https://stellar.expert/explorer/testnet/tx/103d67813a3f8052923303364c8d652921de0d8a2e371cd3e3e8828c47e1afd2) | 1 XLM into the contract; the station credits it in the same second, closes the relay, probes and starts the countdown 7 s later |
| 00:20:37 | top-up, 1 ficha, while charging | [78392799…](https://stellar.expert/explorer/testnet/tx/7839279944f51183f74602425fdfae2d7c665491f8ce9137f20b91a8a10f3b93) | 2 XLM in the session, deadline 28 min after the 2 paid minutes |
| 00:21:14 | ESC after 40 s of charging | | receipt v2: `p=120&u=40&…&q=6&z=LLy56W0J…`, cut confirmed |
| 00:21:22 | claim with `q=6` and `z` | [ec8a4848…](https://stellar.expert/explorer/testnet/tx/ec8a48481e65fdb44778598bbdf0bb967de9d5f0db8d7d066cc79b2099153057) | 1.5 XLM back to the payer, 0.5 XLM to the host |

- `q` = ceil((120 − 40) / 15) = 6 of the 8 units paid; the payer's share
  ceil(2 × 6 / 8) = 1.5 XLM.
- Payer: 10000 → 9999.4611521 XLM = − 2 (deposits) − 0.0388479 (fees of
  three transactions) + 1.5. Host: + 0.5 XLM.
- Station log: `seed`, `credited`, `delivering`, `credited`, `consumed`,
  `finished`, `cut`, `settled` (how `proof`, `to_payer` 1.5, `unused_units`
  6), then the session record with `refund_hint`
  `{"automatic": true, "unused_units": 6, "to_payer": "1.5000000"}`.
- The receipt the app read:
  `https://ficha-stellar.vercel.app/r?v=2&m=YX3DGE.FNF4P358&n=t&h=GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6&a=2&k=XLM&f=2&p=120&u=40&wh=0.134&x=3158&vd=d&c=1&t=1790900474&q=6&z=LLy56W0JvWY-Rn5ZlC3jCputqiSzIwlQefUZnts-o2s`
  (settled: its proof can no longer be used).

### Run B: ERZGCG, the bench (deposit, claim)

`ERZGCG`: 1 XLM per 5-minute ficha, refund unit 30 s, grace 1680 s.
Payer [`GDNISDOK…URRH3WUF`](https://stellar.expert/explorer/testnet/account/GDNISDOKME5XPTAYEENEUJYWU2NECBSLRXEWQ2SSUVRWNK7RUURH3WUF), session `ERZGCG.FQVTGMPJ`.

| Time (UTC) | Step | Transaction | Result |
|---|---|---|---|
| 00:22:02 | deposit, 1 ficha | [5089ebe5…](https://stellar.expert/explorer/testnet/tx/5089ebe5328c2c127d7d06c40751773e7bc1a6cc72ab12da9f26df2becbdfe48) | 1 XLM into the contract |
| 00:22:50 | ESC after 40 s of charging | | receipt v2: `p=300&u=40&…&q=9` |
| 00:22:57 | claim with `q=9` | [a5d55e66…](https://stellar.expert/explorer/testnet/tx/a5d55e66eff0a6adbfbd8d0cfb96cdcc6635c303b3cec448e34b87379f240a1f) | 0.9 XLM back to the payer, 0.1 XLM to the host |

- `q` = ceil((300 − 40) / 30) = 9 of 10 units. Payer: − 1 − 0.0367401
  (fees) + 0.9 XLM. Host: + 0.1 XLM. Station log as in run A, settled by
  proof.

### Run C: the deadline, then release

The station ends a custody session at its deadline minus 900 s at the
latest (§7.5), and after the deadline only `release` (or the host's refund)
can settle it. With the demo stations' grace of 1680 s (900 + the 180 s plug
timeout + the 600 s pause timeout) that end is only a backstop, as those
timeouts end a session first, and the deadline comes 28 minutes after the
paid time. So this run used a throwaway station, `SNKHCC`, under a throwaway host
([`GAAZD3D4…OV3GRNO5V`](https://stellar.expert/explorer/testnet/account/GAAZD3D4QM3KX32TSMYFUWQ2UNURSB6SCDHJAMPUMSJ4T54OV3GRNO5V)),
not in the registry (the station ran with `REGISTRY_CHECK=false`, the app
test with `FICHA_E2E_UNLISTED=1`): 0.1 XLM per 1-minute ficha, up to 4, unit
15 s, and grace 1080 s, the shortest the station accepts with the default
180 s plug timeout (900 + 180). The simulated phone was unplugged after 20 s
of charging, so the countdown paused. Payer
[`GAP4V5PI…5SXFJLQY`](https://stellar.expert/explorer/testnet/account/GAP4V5PIHP6RMJABMLYWAQP4KQQFP4HTUHTR3BSICHPCKFUZ5SXFJLQY),
session `SNKHCC.FJ9HW8HZ`.

| Time (UTC) | Step | Transaction | Result |
|---|---|---|---|
| 00:23:17 | the throwaway host registers SNKHCC | [85324ba1…](https://stellar.expert/explorer/testnet/tx/85324ba1dafad488a47ce22f77c285bc012aecacac93c99fbaf7ce2888fdfc06) | |
| 00:23:47 | deposit, 2 fichas | [c37b5464…](https://stellar.expert/explorer/testnet/tx/c37b5464e57b0921f5bfb5d4fd90aa3f98d29b1905abb47ff878e693065b214e) | 0.2 XLM into the contract, deadline 00:43:47 |
| 00:24:14 | phone unplugged after 20 s of charging | | paused 20 s later (those seconds given back) |
| 00:28:47 | the station ends the session: deadline − 900 s | | end reason `deadline`, receipt v2 `p=120&u=21&…&q=7`, `c=0` (no current before the relay opened: nothing to see drop) |
| | no claim | | |
| 00:43:47 | the deadline passes | | the station drops the last receipt from its waiting screen ("nothing left to claim"); a claim with the receipt's proof now fails at simulation with `Expired`, before anything is signed |
| 00:44:22 | `release`, sent by the payer: anyone may | [58e7aec3…](https://stellar.expert/explorer/testnet/tx/58e7aec3937ef6f784a205440b90e9f25a5f38774d1659273e817165b829d5ce) | all 0.2 XLM to the host; fee 0.0017345 XLM |

- After the release, a second `release` fails at simulation with
  `NoSession`. (`TooEarly` before the deadline is covered by the host-mode
  test, `app/src/custody/host.testnet.test.ts`.)
- Host: + 0.2 XLM exactly. Station log: `seed`, `credited`, `delivering`,
  `consumed`, `finished`, `session` (end reason `deadline`, `refund_hint`
  with 7 units, 0.175 XLM, the refund the payer did not claim), `settled`
  (how `deadline`, `to_payer` 0, `to_host` 0.2, `unused_units` 0).

## Repeat it

From the repo root, a station (any free port; never with the repo's own
`sessions.jsonl` if a real station uses it):

```bash
python main.py   # with .env.lisbon.example copied to .env, or its values in the environment
```

Then, from `app/`, with a funded testnet payer's secret in a file outside
the repo (Friendbot funds a new account):

```bash
FICHA_STATION_E2E=http://127.0.0.1:8000 FICHA_E2E_PAYER=<key file> \
FICHA_E2E_FICHAS=1 FICHA_E2E_TOPUP=1 FICHA_E2E_CHARGE=40 FICHA_E2E_LOG=../sessions.jsonl \
  npx vitest run src/custody/station.testnet.test.ts
```

`FICHA_E2E_END=e` ends the session with the E key, as in runs E, H, I
and J (ESC is the default). The live site serves the registry that names
the current contract (runs J to L read it); should it ever lag behind the
repo's, start the station with `REGISTRY_URL` set to an `https` address
that does not answer (say `https://127.0.0.1:9/registry/stations.json`),
so that it checks the repo copy at startup and at each minute's re-read,
as in runs H and I. Run one claiming test per host at a time: the test
compares the host's `owed` before and after its claim, and another
station's claim under the same host in between fails it (run J's first
attempt). The deadline path: `FICHA_E2E_MODE=keep` with an end key (run L:
`FICHA_E2E_END=e FICHA_E2E_CHARGE=20`), or `FICHA_E2E_END=wait
FICHA_E2E_REASON=deadline FICHA_E2E_MODE=keep` to let the station end it
(run G); no claim, the session goes to `FICHA_E2E_OUT`. Later
`FICHA_E2E_MODE=release FICHA_E2E_IN=<that file>` waits for the deadline
and releases. The test's header lists every setting.

## What this run does not cover

- Real hardware: the relay and the phone were simulated (`MOCK=true`).
  The bench's real relay and meter were verified separately in direct mode.
- The app's screens: the run drives the app's custody modules directly
  (`src/custody`), the same code `/p`, the receipt screen and host mode use;
  those screens were checked by hand in the browser when they were built.
  No deposit or claim has been sent from the published site yet.
- Other assets: custody takes native XLM only (spec, section 7.10).
