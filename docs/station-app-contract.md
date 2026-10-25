# Station ↔ app contract

The station and the Ficha app never talk to each other directly. They meet in
three places: the Stellar ledger, a signed station registry, and QR codes.
This file is the contract between them. Change it first, then both sides.

A station sells in one of two payment modes, set per station in the registry
(section 2): **direct** (the default), where the payer pays the host's
account with a classic payment and a memo (sections 1 to 6), and **custody**,
where the payer deposits into the FichaEscrow contract and claims the unused
time back, before a deadline, with the proof the receipt carries
(section 7). Sections 1 to 6
describe direct mode and what both modes share; section 7 says what custody
mode changes.

## 1. Station ID and memo

- `STATION_ID` (station `.env`): 6 characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ`
  (no 0/1/I/L/O/U). Printed on the hardware; unique worldwide. Empty = legacy.
- Session memo (MEMO_TEXT, max 28 bytes):
  - with a station ID: `<STATION_ID>.<SESSION>`, e.g. `K7M2QX.F3H9TXAB` (15 bytes)
  - legacy (no ID): `<SESSION>`, e.g. `F3H9TXAB`
  - `SESSION` = `F` + 7 characters from the same alphabet.
- A station that sees a payment to its host key whose memo carries ANOTHER
  station's prefix (`^[2-9A-HJKMNP-TV-Z]{6}\.F[2-9A-HJKMNP-TV-Z]{7}$` with a
  different prefix) ignores it: that station logs it. This lets several
  stations share one host key.
- SEP-0007 `msg`: `Ficha <STATION_NAME or "charging"> · session <memo>` (≤ 300 chars).
- SEP-0007 `network_passphrase`: set on every network except public. SEP-0007
  reads a pay URI without it as a public-network request; the app blocks a QR
  for another network than its own.
- Custody mode (section 7) has no memo: a transaction that calls a contract
  cannot carry one. The station ID and the bare session ID (`F3H9TXAB`, not
  `K7M2QX.F3H9TXAB`) are the contract's `station` and `session` arguments,
  as Soroban Symbols. `<STATION_ID>.<SESSION>` stays the session's id in the
  station's log and in the receipt (`m`). A custody station must have a
  `STATION_ID`.

## 2. Station registry

Public, signed, no database. Lives in `registry/stations.json` with a detached
signature in `registry/stations.json.sig`.

```json
{
  "format": "ficha-registry/1",
  "issued_at": "2026-09-30T00:00:00Z",
  "network": "testnet",
  "stations": [
    {
      "id": "K7M2QX",
      "name": "Test bench",
      "host_key": "G...",
      "asset": { "code": "XLM", "issuer": null },
      "ficha_price": "1",
      "ficha_minutes": 5,
      "max_session_minutes": 60,
      "location": { "lat": -22.9068, "lng": -43.1729, "address": "…", "city": "Rio de Janeiro", "country": "BR" },
      "hours": "Mon–Fri 08:00–20:00",
      "active": true
    }
  ]
}
```

- `network` is `testnet` or `public`; one registry file per network
  (`stations.json` = testnet; `stations.public.json` = public).
- `ficha_price` is a decimal string in the asset, above zero: digits,
  optionally a dot and 1 to 7 decimals (`"1"`, `"0.25"`; not `".5"`, `"1."`
  or `"1e1"`). `asset.issuer` is required; null = native XLM. The app drops
  an entry it cannot read, so `tools/registry.py` refuses to sign one.
- `location` and `hours` are optional. `hours` and the location's `address`,
  `city` and `country` are plain text (one string, not an object per weekday);
  the app leaves out any that is not, and `tools/registry.py` refuses it.
- Payment mode, per station (section 7). A custody entry adds four fields:

  ```json
  "mode": "custody",
  "escrow": "CBRNN2W726PIWP7DLLCAOW663I2TBSMR6N7J7S4CGGUIWIXK4HYI6KYC",
  "unit_seconds": 30,
  "grace_seconds": 1680
  ```

  - `mode`: `"direct"` or `"custody"`; absent means `"direct"`. Any other
    value: `tools/registry.py` refuses it and the app drops the entry.
  - `escrow`: the FichaEscrow contract ID (`C…`, a valid contract StrKey) on
    the registry's network. Required with custody; not allowed with direct.
    The app calls only the contract named here, never one from a QR.
  - `unit_seconds`: the refund unit (section 7.7). Required with custody, not
    allowed with direct. A whole number above zero that divides
    `ficha_minutes × 60`, with the chain length
    `floor(max_session_minutes / ficha_minutes) × ficha_minutes × 60 / unit_seconds`
    at most 256.
  - `grace_seconds`: from the end of the paid time to the deadline
    (section 7.7). Required with custody, not allowed with direct. A whole
    number from 300 to 86400; 1680 recommended. The station itself needs at
    least 900 (the payer's time to claim) + its `PLUG_TIMEOUT_SECONDS`
    (180 by default: 1080) and refuses to start with less (section 7.5), a
    station rule the contract does not know: `tools/registry.py` signs such
    an entry with a note, and the app's host form warns.
  - Custody entries only in the testnet registry: custody is testnet only
    until the contract is audited (section 7), and `tools/registry.py`
    refuses one in `stations.public.json`.
  - A custody entry's asset is native XLM (`issuer` null): the contract
    trusts the token's issuer, which could freeze a payer before the claim
    or claw back what the escrow holds (section 7.10). `tools/registry.py`
    and the station refuse an issued asset with custody, and the app
    refuses to pay such a station; direct entries keep any asset.
  - With custody, `floor(max_session_minutes / ficha_minutes) × ficha_minutes × 60`
    is at most 86400 (a day). These are the contract's own bounds
    (section 7.1, `register`): an entry outside them can never match it.
  - A custody entry must equal the station's terms on the contract
    (`station(host_key, id)`, section 7.4 step 3). `tools/registry.py` checks
    the formats above; it does not read the ledger.
- Signature file:
  `{"format": "ficha-registry-sig/1", "key": "G…registry public key", "sig": "<base64 ed25519 signature of the exact bytes of stations.json>"}`
- The app pins the registry public key in its build config and rejects a
  registry whose signature does not verify. The registry SECRET key never
  lives in the repo, on a station, or in the app; `tools/registry.py` signs on
  the operator's machine from a key file or the `REGISTRY_SECRET` variable.
- Registry key (testnet): GBC2MDBTM4MX3XJKRX5QM3YXUR2AISCOJGJ74MXLPIZHZDIDHOLFAASA
- Registry key (public): GC2GUQLX6M6LI7ZYWOVROJAFV6EEZFOVSHCODC7TVAUOIBKEE47E3ZFG
- Check a registry from the repo root:
  `python tools/registry.py verify --key <the pinned key>`.
- `registry/` is marked `-text` in `.gitattributes`: git must not rewrite its
  line endings, or the bytes would no longer match the signature.
- Published with the Ficha site (section 6) at
  `https://ficha-stellar.vercel.app/registry/stations.json` (+ `.sig`), and
  the public one at `…/registry/stations.public.json` (+ `.sig`), byte for
  byte as committed, with `Access-Control-Allow-Origin: *` and
  `Cache-Control: no-cache`, so a new signature is seen at once.
- The app fetches that published copy first (`liveRegistryUrl` in
  `app/src/config.ts`, one per network) and verifies it with the network's
  pinned key. When the site cannot be reached it uses the copy bundled in
  its build, or the last verified published copy kept on the phone. A copy
  that fails verification is never used, and of the verified copies it holds
  the newest `issued_at` wins, so a replayed older registry does not come
  back. The Stations screens say which copy is in use and its `issued_at`.
- The station checks itself against it at startup when `STATION_ID` is set
  (`registry_check.py`): the published copy first (`REGISTRY_URL`, short
  timeout), then the repo copy (`REGISTRY_FILE`), signature verified with the
  pinned public key (`REGISTRY_KEY`, default the network's key above; on the
  public network no other key is accepted). Its
  entry must be `active` and match the station's `STELLAR_NETWORK` (the
  registry's `network`), `HOST_PUBLIC_KEY` (`host_key`), asset (`asset`),
  `FICHA_PRICE` (`ficha_price`, compared as a number), `FICHA_MINUTES` and
  `MAX_SESSION_MINUTES`, and its payment mode: `PAYMENT_MODE` (`mode`,
  absent = direct) and, in custody mode, `ESCROW_CONTRACT` (`escrow`),
  `REFUND_UNIT_SECONDS` (`unit_seconds`) and `ESCROW_GRACE_SECONDS`
  (`grace_seconds`); otherwise, or on a bad signature, it refuses to
  start and lists each difference. With no copy readable a testnet station
  starts and shows "registry unchecked"; on the public network it does not
  start until the check passes. `REGISTRY_CHECK=false` skips it (development
  only; refused on the public network).
  So what the app shows and charges is what the station sells. A custody
  station then checks the contract too (section 7.5).
- A custody station, and any station on the public network, runs the same
  check again every minute while it runs, in the same order and quietly. A
  difference (a registry published with another `escrow`, other terms, the
  station made inactive) or a copy that
  does not verify puts it out of service, its pay QR hidden and the
  registry item red with the difference, until a read matches again: in
  practice until it is restarted with the new values. With no copy readable
  nothing changes; a direct station on public reads only the site's copy (the
  one the app reads), so a stale local copy changes nothing either. The app
  pays the contract the newest registry names, so without this a station
  still watching the old contract would take deposits it never sees, and a public station re-signed with other terms
  (`ficha_minutes` 5 -> 10 at the same price) would sell the old ones. To
  change a running station's entry: stop the station, publish the registry,
  update its `.env`, start it. Direct stations on testnet are not re-read.

## 3. Receipt QR

Shown on the station's FINISHED screen for FINISHED_SECONDS (default 20 s;
60 s in custody mode), for paid sessions only. Unsigned (the station holds no
key): the app treats it as the station's statement and cross-checks it
against the user's own on-chain payment. This is the direct-mode receipt,
`v=1`; a custody session's receipt is `v=2` and adds the refund proof
(section 7.6).

```
<APP_URL>/r?v=1&m=<memo>&n=<t|p>&h=<host_key>&a=<amount>&k=<asset code>&f=<fichas>&p=<paid_s>&u=<used_s>&wh=<wh>&x=<max_ma>&vd=<d|n|u>&c=<1|0>&t=<finished unix s>
```

- `APP_URL` (station `.env`, optional, https). Empty = `ficha:` so the
  payload starts `ficha:/r?v=1&…`; the app's scanner accepts both.
- The Ficha site (section 6) is `APP_URL=https://ficha-stellar.vercel.app`:
  a phone camera opens the receipt as a link, in the browser (the web app's
  `/r`; the site serves the app for any path that is not a file, so it
  survives a hard reload) or in the Android app. The app also opens
  `ficha:/r?…` receipts and a station's `web+stellar:pay?…` link (intent
  filters, cold start or running). The https filter is exactly `/r` (and
  `/p`, the custody pay link, section 7.3) and is a verified App Link:
  Android opens Ficha for it without asking, in a build signed with a key
  the site's `assetlinks.json` lists. Another Stellar wallet may also offer
  to open `web+stellar:`.
- The app confirms a receipt ("Conferido na blockchain") when the payments on
  the ledger to `h` with memo `m` that the station credits (its asset, at
  least one ficha each, closed by `t`; path payments count by what arrived)
  add up to `a`: the user's own, or, when several wallets paid the session,
  every wallet's, read from the host's payments. It then shows the user's
  share ("sua parte: X de Y"); History counts only the user's own payments.
  A payment that closed after `t` was not credited (orphan, refund by hand).
- `n` network (t testnet, p public); `vd` verdict (d delivered, n no_current,
  u unverified); `c` cut confirmed; `wh` with 3 decimals; amounts as decimal
  strings; values URL-encoded.
- `u` is the session record's `consumed_seconds`: the seconds of paid time
  the countdown consumed, that is the time the station was verified to be
  charging the phone (section 5). Waiting for the phone, probes and pauses
  are not in it. `p - u` is paid time not delivered (capped or unused), which
  the station logs for a manual refund. The app calls `u` "tempo carregando
  na estação" (en: "time charging at the station").
- `vd=d` means current of at least `MIN_CURRENT_MA` was seen while the
  station was verified to be charging the phone; `n` includes a phone that
  never charged from this station (end reason `not_plugged`), even if it
  was charging from another socket; `wh` and `x` count only verified
  readings.

### 3.1 Refund URI (direct mode)

A direct-mode station holds no key and cannot refund: the host refunds from
its own wallet. For each refund due the station shows its operator a
SEP-0007 pay request, paid by the HOST to the PAYER, as a QR (for the
host's mobile wallet) and as a button to the Ficha site:

```
web+stellar:pay?destination=<payer G…>&amount=<amount>&memo=<URL-encoded "refund <REF>">&memo_type=MEMO_TEXT&msg=<URL-encoded "Ficha refund · <REF>">
```

- `destination`: the payer the station's log has for that payment, never
  an address from a wallet's history (address poisoning: a look-alike
  address sends the host a tiny payment so it is copied by mistake).
- `amount`: at most 7 decimals, no trailing zeros needed.
- `asset_code` and `asset_issuer` follow `amount`, for an issued asset
  only: a refund goes back in the asset that was paid.
- `network_passphrase` comes before `msg` on every network except public:
  a URI without it is a public-network request, as for the pay QR
  (section 1).
- `memo` and `msg` are URL-encoded. `<REF>` is the session ID
  `<STATION_ID>.<SESSION>` for a session's refund (`refund 8DY7RJ.FAFXJXBZ`
  is 22 bytes; a text memo holds 28). For an uncredited payment (orphan,
  refused, underpaid) whose memo names none of the station's sessions it
  is `<STATION_ID>.tx<first 8 hex of the transaction hash>` when that fits
  in 28 bytes, else `tx<first 12 hex>` (a station without `STATION_ID`).
- The operator's button opens
  `<APP_URL>/refund?uri=<encodeURIComponent(the URI)>`
  (`APP_URL=https://ficha-stellar.vercel.app` on the demo stations). The
  app finds the host by the station ID in `<REF>`: it resolves that ID in
  the signed registry of the URI's network and requires the signing
  account to be that station's `host_key`.
- What is due, in `sessions.jsonl`: a paid session's line carries
  `refunds`, one per payer,
  `{"payer", "amount", "asset", "asset_issuer" (issued assets only), "ref", "memo", "uri"}`:
  the payer's change plus its share of the capped and unused time's value
  (`refund_hint`), split by what each payer credited and rounded down to
  the stroop, so the sum never exceeds what is due (an interrupted
  session: the change only). Each `orphan`, `refused` and `underpaid` line
  carries one for its whole amount; `dust` never. Lines logged before
  `refunds` existed have none.
- When Horizon lists a payment the host sent whose memo is `refund <REF>`
  of a refund still due, to that refund's payer and in its asset, the
  station logs

  ```json
  {"kind": "refunded", "ref": "8DY7RJ.FAFXJXBZ", "payer": "G…", "amount": "0.95", "asset": "XLM",
   "tx_hash": "…", "op_id": "…", "at": "2026-10-25T18:00:00Z", "due": "0.95", "left": "0"}
  ```

  (with `asset_issuer` for an issued asset, `network`, `host_key`, `memo`
  and `source`, and `excess` when it paid more than was due). `left` stays
  due, and the screen asks for it. A payment the host sends never credits
  a session, whatever its memo; one with any other memo, destination or
  asset is the host's own business and is ignored.
- Custody mode has none of this: the receipt's proof refunds (section 7).

## 4. Money rules the app must keep

- Direct mode: pay only by the station's SEP-0007 QR: destination =
  `host_key`, memo = the session memo, asset = the station's asset.
  Custody mode: pay only by `deposit` into the registry's `escrow`, from the
  station's pay link (section 7.4).
- The user picks a number of fichas; amount = fichas × `ficha_price`, never a
  free amount, and never more fichas than `max_session_minutes / ficha_minutes`.
  (In direct mode the station still logs any remainder or capped time for
  manual refund; in custody mode the contract takes exact amounts only.)
- Before signing, the app checks the destination against the registry entry
  for the memo's station ID and warns loudly on a mismatch or unknown station.
  In custody mode it refuses instead (section 7.4).
- Keys never leave the phone. The app never custodies, never swaps on the
  user's behalf for a fee, never holds a secret for anyone else.
- "Fichas" are charging time and die with the session. What the user buys
  with PIX is USDC (or XLM on testnet), called "saldo" in the UI, never "token".
- After paying, the app says that the time starts counting only once the
  phone is plugged into this station and the station detects the charge,
  and that it pauses if the phone stops charging there (section 5). Any end
  time it shows is an estimate on that condition.

## 5. Paid time and charge verification

The station's meter (ADB) reads the phone's own battery, which cannot tell
the station's outlet from another charger. So paid time counts only while
the station has verified that it is charging the phone (`CHARGE_VERIFY=true`,
the default; `false` is for bench tests and refused on the public network):

- After a payment the relay closes, but the countdown starts only when the
  meter shows at least `MIN_CURRENT_MA` and a **probe** passes: the relay
  opens for `PROBE_SECONDS` (3) and the current must fall clearly (mains:
  every reading but the first below `MIN_CURRENT_MA`, and at least
  `MIN_CURRENT_MA` under the reading before) or the phone vanish (usb_vbus).
  The countdown starts at the first charging reading after it (on mains,
  current back only after 3 or more low readings is checked by one more
  probe first: the phone may have been moved meanwhile). Current that keeps
  flowing comes from another charger: the probe fails and nothing is
  consumed. Not verified within `PLUG_TIMEOUT_SECONDS` (180): the session ends
  as `not_plugged`, all its paid time unused. Current flowing when that time
  is up (the phone moved here after the last probe) gets one last probe
  first, which decides.
- While counting: a probe every `PROBE_EVERY_SECONDS` (300) and after a dip in
  the current; a failed one pauses the countdown. No current for more than
  `PAUSE_GRACE_SECONDS` (20) pauses it too, from when the current went away.
  A passing probe resumes it. A pause of `PAUSE_TIMEOUT_SECONDS` (600) ends
  the session as `paused_too_long` (with current flowing, after one last
  probe that does not pass). Probe seconds, and those until the phone
  charges again after a probe, are never consumed.
- The operator can end a session at any time: key E ends it as `stopped`
  (the payer asked to stop, or a demo shows the refund), ESC as
  `emergency_stop` (cut the power now). Either way, as at any end, the paid
  time not consumed is the payer's.
- `METER_SOURCE=outlet` (a meter on the station's own output, not built
  yet) needs no probes: the current it sees is the station's.
- Session records carry `verify_mode` (`probe`, `outlet`, `off`), `verified`,
  `verified_at`, `consumed_seconds`, `paused_seconds` and
  `probes {passed, failed}`; `refund_hint.unused` = paid − consumed − capped,
  in the asset. In custody mode (which requires `CHARGE_VERIFY=true`) the
  refund is by proof: `consumed_seconds` decides the proof the receipt
  carries, which the payer claims with (section 7.5).

## 6. The Ficha site

`https://ficha-stellar.vercel.app/` serves what both sides point at: the
live signed registry (section 2), the receipt links (section 3), the host's
refund page (`/refund`, section 3.1), the custody pay links (section 7.3) and
the web app itself, at the root path.

- Hosting: the Vercel project `ficha`, which deploys the private site
  repository on each push. That repository holds only the built site;
  nothing is built there.
- Publishing, from `app/` in this repo, after signing the registry when it
  changed: `npm run build:site` (-> `app/dist-site/`), then
  `node scripts/publish-site.mjs <checkout of the site repository>`; review
  `git status` there, commit and push. The push deploys.
- `vercel.json` (from `app/site/`): a path that is not a file serves the
  app's `index.html`, so `/r?…`, `/p?…`, `/stations/<id>` and the other pages
  survive a hard reload. `/registry/`, `/.well-known/` and `/assets/` are
  never rewritten: a missing file there is a 404, never the app.
  `/registry/*` gets `Access-Control-Allow-Origin: *` (the Android app reads
  it from `https://localhost`) and `Cache-Control: no-cache`.
- `/.well-known/assetlinks.json` (from `app/site/`) makes
  `https://ficha-stellar.vercel.app/r` a verified Android App Link of
  `app.ficha.wallet` for the signing keys it lists by SHA-256 fingerprint:
  today the debug key of the local builds. A build signed with another key
  needs its fingerprint added and the site published. The app's https intent
  filter covers exactly `/r` and `/p` (section 7.3): the same verification
  covers both paths, as `assetlinks.json` names the app, not a path.

## 7. Custody mode

The payer deposits into FichaEscrow, a Soroban contract, instead of paying
the host. The money then leaves it only to the host or back to the payer.
For each session the station puts the tip of a hash chain (the **anchor**)
in the pay link; when the session ends, the receipt reveals a link of that
chain that proves how many units of paid time were **not** delivered, and
the payer claims them back with it; the rest is the host's, kept for it in
the contract until anyone pays it out (`pay_host`). A session nobody claims
goes to the host in full after its deadline, which is what a direct payment
does today. The
station still holds no Stellar key and no account, signs nothing and pays no
fee: it only reads the ledger. Custody is for the testnet demo stations;
direct stays the default, and the only mode on the public network until the
contract is audited.

### 7.1 The contract

Source, and the build, test and deploy commands: `contracts/escrow/` and its
README. No admin, no upgrade, no withdraw, no constructor: whoever deploys
it has no power over it. It cannot be changed: a new version is a new
contract ID, which the registry's `escrow` then names; sessions open on the
old one still settle there.

| Testnet | |
|---|---|
| Contract ID | `CBRNN2W726PIWP7DLLCAOW663I2TBSMR6N7J7S4CGGUIWIXK4HYI6KYC` |
| Wasm sha256 | `d4314635246e3a17b65d154bd8bae208a94a2594741ed12f3a24198d1e9bd865` (20 437 bytes), the contract's wasm hash on the ledger; `stellar contract build` in `contracts/escrow` (soroban-sdk 28.0.0, rustc 1.98.1, stellar-cli 28.1.0) gives the same bytes |
| Retired | `CDC7XU5PNLVM7AJ6SPDDTPUGC67BJ72KKIZOFHG2GGLIL277BIZZGL4K` (wasm `01871cc7…96cb`), the second deployment, before a second review found that a host could still fail a claim by changing its account between the payer's simulation and the ledger (that claim paid the host directly), and that its `settle` docs put the `owed` event after the settle. Same interface and events as today: only where a claim's host share goes, and when, changed. `CA4HZBR2GTVE6AQUKELHC3EJ3PVBP3CGU6HC6FTXU4Z74FUQBJUVWH36` (wasm `94f3dc49…c5fe`), the first deployment, before a review found that a host could hold refunds back, that a session ID could be squatted, and that the payer's signature did not cover the terms (section 7.10); its interface was an older one. The registry names neither, the app pins neither's code, and their station entries lapse with their TTL. Both were left as they are; sessions open on them still settle there |
| RPC | `https://soroban-testnet.stellar.org`, the default on both sides (configurable) |
| XLM | the SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`: `Asset.native().contractId(Networks.TESTNET)` in JS, `Asset.native().contract_id(Network.TESTNET_NETWORK_PASSPHRASE)` in Python |
| Stations | host `GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6`, token = XLM's SAC, price 10000000 (1 XLM), grace_secs 1680, active, both in the registry: `ERZGCG` (the bench), ficha_secs 300, max_fichas 12, unit_secs 30 (N = 120); `YX3DGE` (the Lisbon demo), ficha_secs 60, max_fichas 10, unit_secs 15 (N = 40) |

**Arguments.** Every function takes Soroban values; the XDR type is in
brackets.

- `host`, `payer`: Address [`SCV_ADDRESS`]. `host` is the registry's
  `host_key` (`G…`); `payer` the paying wallet (`G…`, or `C…` for a contract
  account).
- `station`: Symbol [`SCV_SYMBOL`], the 6-character `STATION_ID` (`ERZGCG`).
- `session`: Symbol [`SCV_SYMBOL`], the bare session ID, `F` + 7 characters
  (`F3H9TXAB`; never the memo form `ERZGCG.F3H9TXAB`).
- `fichas`, `unused_units`, `units`: u32 [`SCV_U32`].
- `anchor`, `proof`: BytesN<32> [`SCV_BYTES`, exactly 32 bytes]. A session
  on the contract is (host, station, session, anchor): every call on a
  session names its anchor, and the same session ID with another anchor is
  another session.
- `terms`: `Terms` [`SCV_MAP`], below.
- `token`: Address [`SCV_ADDRESS`], the asset's SAC.
- Amounts: i128 [`SCV_I128`], in the token's smallest unit (stroops).
- `grace_secs`, `opened`, `deadline`: u64 [`SCV_U64`]; `opened` and
  `deadline` are ledger time, unix seconds. Other times are u32 seconds.
- JS SDK 17: `new Address(g).toScVal()`, `nativeToScVal(id, { type: "symbol" })`,
  `nativeToScVal(n, { type: "u32" })`, `xdr.ScVal.scvBytes(Buffer.from(bytes))`.
  Python stellar-sdk 16: `scval.to_address(g)`, `scval.to_symbol(id)`,
  `scval.to_uint32(n)`, `scval.to_bytes(b)`.

**Types.** Both are maps with Symbol keys (`SCV_MAP`), which
`scValToNative` and `scval.to_native` turn into an object or a dict.

- `StationCfg`: `token` Address (the asset's SAC), `price` i128 (one
  ficha), `ficha_secs` u32, `max_fichas` u32 (most fichas one session
  holds), `unit_secs` u32 (the refund unit; divides `ficha_secs`),
  `grace_secs` u64, `active` bool.
- `Terms`: the same fields but `active`: `token`, `price`, `ficha_secs`,
  `max_fichas`, `unit_secs`, `grace_secs`. What a deposit is made under, so
  what the payer signs.
- `Session`: `payer` Address; the station's terms at the first deposit,
  frozen for the session: `token`, `price`, `ficha_secs`, `unit_secs`,
  `max_fichas`, `grace_secs`; `chain_len` u32 (N, section 7.3); `anchor`
  BytesN<32>; `fichas` u32 and `amount` i128 (totals over the first deposit
  and its top-ups); `opened` u64; `deadline` u64.

**Functions.**

| Function | Signed by | Returns |
|---|---|---|
| `register(host, station, cfg: StationCfg)` | the host | nothing |
| `station(host, station)` | read only | `Option<StationCfg>` (void when none) |
| `session(host, station, session, anchor)` | read only | `Option<Session>` (void when none is open) |
| `owed(host, token)` | read only | i128: what is owed to the host in that token (0 when nothing) |
| `deposit(payer, host, station, session, fichas, anchor, terms)` | the payer | u64: the session's deadline |
| `claim(host, station, session, anchor, unused_units, proof)` | the session's payer | i128: the payer's share |
| `release(host, station, session, anchor)` | nobody | i128: the host's share (all of it) |
| `host_refund(host, station, session, anchor, units)` | the host | i128: the payer's share |
| `pay_host(host, token)` | nobody | i128: the amount paid to the host |

The checks run in the order given; the first that fails is the error.
"Paid units" are the session's `fichas × ficha_secs / unit_secs`.

- `register`: the host's signature. `BadConfig` unless `price` > 0;
  `ficha_secs`, `unit_secs` and `max_fichas` > 0; `ficha_secs % unit_secs`
  = 0; 300 ≤ `grace_secs` ≤ 86400; `max_fichas × ficha_secs` ≤ 86400; and
  N = `max_fichas × ficha_secs / unit_secs` ≤ 256. `Overflow` when
  `price × max_fichas × (N + 1)` does not fit an i128. Sets or replaces the
  terms under (host, station), so nobody can list a station under another
  host's key, and extends that entry's TTL. Open sessions keep their terms.
  Emits `station`.
- `deposit`: the payer's signature, which covers every argument, `terms`
  included, and the token transfer below. `UnknownStation` with no terms
  under (host, station); `Inactive` when not `active` (top-ups included).
  When a session is open under (host, station, session, anchor):
  `OtherPayer` if `payer` is not its payer; `Expired` if ledger time is past
  its deadline; `TermsChanged` if `terms` are not the session's own;
  otherwise this is a top-up, at the session's own terms. When none is open:
  `TermsChanged` if `terms` are not the station's current ones (all but
  `active`); otherwise a new session with those terms and `opened` = ledger
  time. Then `BadFichas` if `fichas` = 0 or more than `max_fichas` minus the
  fichas already in the session. Then `price × fichas` moves from the payer
  to the contract (the token's `transfer(payer, contract, amount)`), the
  totals grow, and the deadline becomes
  `opened + total fichas × ficha_secs + grace_secs`. Emits `deposit`;
  returns the deadline. A register that lands between the app's read and
  the deposit therefore fails the deposit before any money moves.
- `claim`: `NoSession` when none is open under (host, station, session,
  anchor); then the session payer's signature (anyone else fails on
  authorization, not with a contract error; a contract-account payer's own
  `__check_auth` decides for it); `Expired` if ledger time is past the
  deadline; `BadProof` if `unused_units` > 256 (the longest chain a station
  may use), or if SHA-256 applied `unused_units` times to `proof` is not
  the anchor. A proof longer than the session's own N is accepted (it can
  only be the station's, from a chain longer than the session's terms give:
  going past c[0] would take inverting SHA-256). Then
  U' = min(`unused_units`, paid units), the payer's share =
  ceil(amount × U' / paid units) and the host's = amount minus the payer's
  (section 7.7). Settles with how = `proof`; the host's share is always
  kept as owed (below).
- `release`: `NoSession`; `TooEarly` unless ledger time is past the
  deadline. Everything to the host; how = `deadline`, `unused_units` 0.
  Anyone may send it; it needs no signature.
- `host_refund`: the host's signature; `NoSession`; `TooEarly` if ledger
  time is not past the deadline and `units` < paid units (until the
  deadline, only a full refund). Then the same split as `claim` with
  U' = min(`units`, paid units); how = `host`.
- Settling deletes the session first (it settles once), then transfers the
  payer's share to the payer (a zero share is not transferred), then deals
  with the host's share, then emits `settle`. The payer's refund never waits
  on the host:
  - `claim` never touches the host's account. The ledger entries a Soroban
    transaction may touch (its footprint) are fixed when the payer
    simulates it, so a transfer to the host would bind the claim to the
    host's account, trustline or balance as they stood then, and a host
    that changed them before the claim applied (merged away, no trustline,
    frozen, or back again) would fail the whole claim. The host's share is
    added to what the contract owes it (`owed(host, token)`, an `owed`
    event), the same entry whatever the host's state, and `pay_host` pays
    it out.
  - `release` and `host_refund` try the host's transfer, and when the
    host's account cannot take it now that share is kept as owed in the
    same way instead of failing the settlement. A failure there would only
    delay the host's own money.

  A payer whose own account cannot take its share fails only its own claim,
  and nothing changes. The contract keeps nothing of a settled session: a
  later deposit under the same session ID and anchor opens a new session
  (section 7.4 says why the app never does that).
- `pay_host`: `NothingOwed` when nothing is owed to the host in that token.
  Otherwise the whole amount owed goes to the host, and only to the host;
  emits `payout`. Anyone may send it (as a rule the host, once its account
  can take the token); while the host's account cannot, it fails and the
  amount stays owed. The owed entry stays, at 0, and `pay_host` extends its
  TTL at the sender's cost (to 60 days when under 30): a claim then always
  updates an entry that exists, so a `pay_host` landing just before a claim
  cannot make that claim create the entry and pay rent it was not simulated
  with. The app's host mode reads `owed(host, token)` for each of the
  host's escrows and assets with the rest of its view, and its Collect
  button sends `pay_host` from the host's wallet: simulated first, with no
  authorization asked, so `NothingOwed` shows before anything is signed.
- Fees: the payer pays for `deposit` and `claim`, the host for `register`
  and `host_refund`, whoever sends `release` or `pay_host` for it. Measured
  on testnet: a deposit about 0.036 XLM (mostly rent for the new session
  entry), a top-up 0.0024 XLM, a claim 0.0024 XLM (0.0116 XLM when it
  creates the host's owed entry, at the first claim for that host and
  token), a full-refund claim 0.0019 XLM, a `host_refund` 0.0019 XLM, a
  `release` 0.0018 XLM, a `pay_host` 0.0017 XLM, or 0.07 XLM when it
  extends the owed entry (mostly 60 days of rent), a `register` 0.16 XLM
  (60 days of rent for the station entry).

**Errors**, as `Error(Contract, #n)` from the escrow's contract ID, in
simulation or in the transaction result:

| # | Name | From | Meaning |
|---|---|---|---|
| 1 | `BadConfig` | register | terms out of bounds |
| 2 | `UnknownStation` | deposit | no such station under this host on this contract |
| 3 | `Inactive` | deposit | the station takes no payments |
| 4 | `BadFichas` | deposit | 0 fichas, or more than the session may still hold |
| 5 | `NoSession` | claim, release, host_refund | nothing open: never paid, or already settled |
| 6 | `OtherPayer` | deposit | another wallet already paid this session (its ID and this anchor): ask the station for a new QR |
| 7 | | | retired (`AnchorMismatch` of the first deployment): another anchor is another session now |
| 8 | `Expired` | deposit, claim | the deadline has passed: the host gets everything at release |
| 9 | `TooEarly` | release, host_refund | the deadline has not passed (before it, host_refund only refunds in full) |
| 10 | `BadProof` | claim | the proof does not lead to the session's anchor |
| 11 | `Overflow` | register, deposit | arithmetic out of range (unreachable with terms that register accepts) |
| 12 | `TermsChanged` | deposit | `terms` are not the station's (a new session) or the session's (a top-up): they changed after the payer read them; nothing was charged |
| 13 | `NothingOwed` | pay_host | nothing is owed to this host in this token |

A missing or wrong signature fails with an authorization error
(`Error(Auth, …)`), not one of these, and only when the transaction is sent:
simulation records signatures, it does not check them. A payer short of
balance fails inside the token contract, with an error from the SAC's
contract ID: the app checks the balance first (section 7.4). A SAC error
in a claim is always about the payer's own account (a claim never touches
the host's): #6 or #14 no account (or, for XLM, a refund too small to
create it), #11 not authorized by the issuer, #13 no trustline.

### 7.2 Events, and reading the ledger without a key

Every event comes from the escrow's contract ID, with type `contract`. The
first topic is a Symbol naming the event. The data is a map with Symbol
keys, sorted as listed, except `station`'s, which is the `StationCfg` map
itself.

| Event | Topics | Data |
|---|---|---|
| `station` (register) | `"station"`, host Address, station Symbol | `StationCfg`: `active` bool, `ficha_secs` u32, `grace_secs` u64, `max_fichas` u32, `price` i128, `token` Address, `unit_secs` u32 |
| `deposit` | `"deposit"`, host Address, station Symbol, session Symbol | `amount` i128 (this deposit), `anchor` 32 bytes, `deadline` u64 (the session's, after this deposit), `fichas` u32 (this deposit), `payer` Address, `terms` (the session's `Terms`, frozen at its first deposit: `ficha_secs`, `grace_secs`, `max_fichas`, `price`, `token`, `unit_secs`), `total_amount` i128 and `total_fichas` u32 (the session's totals after it) |
| `settle` (claim, release, host_refund) | `"settle"`, host Address, station Symbol, session Symbol | `anchor` 32 bytes (with the ID, which session), `how` Symbol (`proof`, `deadline` or `host`), `payer` Address, `to_host` i128, `to_payer` i128, `unused_units` u32 (the units refunded, at most the units paid) |
| `owed` (every claim with a host share; a release or host_refund whose host share the host's account could not take) | `"owed"`, host Address, token Address | `amount` i128 (this settlement's host share), `total` i128 (all now owed to the host in the token) |
| `payout` (pay_host) | `"payout"`, host Address, token Address | `amount` i128 |

`to_host + to_payer` is the session's total amount; `to_host` is the host's
share whether it was paid or, with an `owed` event just before the
`settle`, kept for the host (always, in a claim). An `owed` event belongs
to the `settle` that follows it in the same transaction, never to a later
one: pair them by transaction hash and event order (the `settle` field
docs of the first two deployments said the opposite). Two sessions may
share an ID (another wallet
paid it with a chain of its own): their events differ by `anchor`, so a
reader matches a `settle` to its `deposit` by (session, anchor). The
token's own `transfer` events in the same transactions add nothing.

Read them with the RPC's `getEvents`: filter `type` `contract`,
`contractIds` `[escrow]`, `topics` `[["deposit", host, station, "*"]]` (and
the same with `"settle"`), where each segment is the base64 XDR of the
ScVal and `"*"` matches any one topic. The RPC keeps only a recent window
(about 7 days on the testnet RPC; each response's `oldestLedger` says);
beyond it, `session()` still shows a session that is open, and a settled one
is gone. Since Stellar RPC 30 (on the testnet RPC since about 20 October
2026) the records carry no `inSuccessfulContractCall`: getEvents returns
only the events of successful calls (since protocol 23), so a reader must
not require the field. Python stellar-sdk 16.1.1 or later reads such pages;
16.1.0 rejects every page that has events. Both recipes below were checked
against testnet:

```python
from stellar_sdk import SorobanServer, scval
from stellar_sdk.soroban_rpc import EventFilter, EventFilterType

topics = [scval.to_symbol("deposit").to_xdr(), scval.to_address(host).to_xdr(),
          scval.to_symbol(station_id).to_xdr(), "*"]
resp = SorobanServer(rpc_url).get_events(
    start_ledger=first,  # later calls: cursor=resp.cursor and no start_ledger
    filters=[EventFilter(type=EventFilterType.CONTRACT, contractIds=[escrow], topics=[topics])],
    limit=100)
for e in resp.events:  # also e.transaction_hash, e.ledger, e.id
    _, host_, station_, session_ = [scval.to_native(t) for t in e.topic]
    data = scval.to_native(e.value)
    # a dict with str keys: int (u32, u64, i128), bytes (anchor), str (Symbol),
    # stellar_sdk.Address (payer, host_: .address is the "G…" string)
```

```ts
const b64 = (v: xdr.ScVal) => v.toXDR("base64");
const res = await new rpc.Server(rpcUrl).getEvents({
  startLedger, // later calls: cursor: res.cursor
  filters: [{ type: "contract", contractIds: [escrow], topics: [[
    b64(nativeToScVal("deposit", { type: "symbol" })), b64(new Address(host).toScVal()),
    b64(nativeToScVal(stationId, { type: "symbol" })), "*"]] }],
  limit: 100,
});
for (const e of res.events) { // also e.txHash, e.ledger, e.id
  const [, hostKey, station, session] = e.topic.map(scValToNative);
  const d = scValToNative(e.value);
  // i128 and u64 -> bigint, u32 -> number, bytes -> Uint8Array,
  // Address -> "G…" or "C…" string, Symbol -> string
}
```

A station's terms, an open session or the contract's code, with no key,
either way:

- Simulate a call to `station(host, station)` or
  `session(host, station, session, anchor)` from any source account (say
  `new Account(host, "0")`), and never sign or send it. The return value is
  the map, or void.
- `getLedgerEntries` on the persistent contract-data key
  `Vec[Symbol("Station"), host, station]` or
  `Vec[Symbol("Session"), host, station, session, Bytes(anchor)]`; its value
  is the map, and no entry means none. What is owed to a host:
  `Vec[Symbol("Owed"), host, token]`, an i128. Python:
  `server.get_contract_data(escrow, scval.to_vec([...]))`, then
  `LedgerEntryData.from_xdr(entry.xdr).contract_data.val`. The contract's
  instance is the persistent key `LedgerKeyContractInstance`; its value's
  `instance.executable.wasmHash` is the wasm sha256 (section 7.1). One
  `getLedgerEntries` call takes all three keys.

### 7.3 The hash chain and the pay link

- For each session the station draws a seed, c[0]: 32 bytes from a
  cryptographic random source (`secrets.token_bytes(32)`), new for every
  session, never reused, never derived from anything.
- c[i+1] = SHA-256(c[i]), over the 32 raw bytes, up to c[N], where
  N = `max_fichas × ficha_secs / unit_secs` of the station's terms (ERZGCG:
  12 × 300 / 30 = 120). The **anchor** is c[N].
- The proof that U units were not delivered is c[N−U]: SHA-256 applied U
  times to it gives the anchor. Hashing forward only ever proves fewer
  units; proving more would take inverting SHA-256.
- The anchor also names the session on the contract, with the session ID
  (section 7.1): a deposit with another chain under the same ID is another
  session, which this station's session, QR and next payer never meet.
- In links, 32 bytes are base64url (RFC 4648 section 5: `A–Z a–z 0–9 - _`)
  with no padding: always 43 characters. A reader rejects any value that
  does not decode to exactly 32 bytes.
- `contracts/escrow/test-vectors.json` (`chains`, in hex and base64url) is
  checked by the contract's tests; the station's and the app's tests check
  the same file.
- The seed is a secret until the station reveals a proof, and a small one:
  it can only refund that session's payer, since only the payer can claim
  and a session settles once. The station keeps it on disk from before it
  shows the pay link until the session settles or its deadline passes, so a
  restart can still make the receipt. It is shown only as a full-refund
  proof (section 7.5) and sent nowhere.

The **pay link**, custody mode's pay QR (it replaces the SEP-0007 QR on the
AWAITING_PAYMENT screen):

```
<APP_URL>/p?v=1&n=<t|p>&h=<host_key>&s=<STATION_ID>&x=<SESSION>&a=<anchor>
```

- In that order (the app accepts any order): `v` 1; `n` `t` (testnet) or
  `p` (public); `h` the host's `G…`; `s` the station ID and `x` the session
  ID (section 1); `a` the anchor, base64url, 43 characters. No value needs
  URL-escaping.
- With `APP_URL` empty: `ficha:/p?v=1&…`, which the app's scanner and
  intent filters take like `ficha:/r`.
- Neither an amount nor a contract ID: the user picks fichas in the app,
  and the contract is the registry's.
- Example: `pay_link` in the test vectors.

### 7.4 Paying: what the app does with a pay link

1. Parse it, and refuse a malformed one. `n` must be the app's network.
2. The verified registry (section 2) must list `s` with `host_key` = `h`,
   `active`, `mode` `custody`, native XLM as its asset (section 7.10) and an
   `escrow`: the only contract the app calls. Otherwise refuse (unknown
   station, another host, not custody, an issued asset).
   The app also reads that contract's instance (section 7.2) and refuses
   unless its wasm hash is one its build pins (`app/src/config.ts`, the
   wasm sha256 of section 7.1): the registry may name a new deployment of
   the same code (after a testnet reset, say), never other code.
3. Read `station(h, s)` (section 7.2) and refuse unless it exists, is
   active and matches the registry entry: `token` = the SAC of `asset` on
   the network; `price` = `ficha_price` × 10^7; `ficha_secs` =
   `ficha_minutes` × 60; `max_fichas` =
   floor(`max_session_minutes` / `ficha_minutes`); `unit_secs` =
   `unit_seconds`; `grace_secs` = `grace_seconds`.
4. Read `session(h, s, x, a)`:
   - none open: a new session; the user picks 1 to `max_fichas` fichas at
     `price`. First the app reads the session ID's `deposit` and `settle`
     events (section 7.2, those the RPC still keeps): one with this link's
     anchor means the session was already paid, and settled since, so the
     QR is stale and the app refuses it before anything is signed. Events
     under the same ID with another anchor are another session and do not
     count. A read that fails blocks the payment until it is retried;
   - payer = this wallet: a top-up of 1 to `max_fichas − fichas`, at the
     session's own `price`, until 930 s before the deadline. The station
     ends every custody session 900 s before its deadline and credits
     nothing after (section 7.5), so from 900 s + 30 s of margin before it
     the app offers no top-up and points at the receipt, or the station's
     current QR;
   - another payer (someone paid with a copy of this QR): refuse ("this
     session was paid by another wallet: ask the station for a new QR"). The
     deposit would fail with `OtherPayer` anyway. A deposit under `x` with
     another anchor is another session and does not show here.
   - Never deposit into a session this wallet holds a receipt for, or has
     seen settle: that QR is stale, and the contract would open a new
     session under the old ID that no station serves (the host would refund
     it by hand). A kept receipt counts only if its proof leads to this
     link's anchor: a crafted `/r` link with the session's public ID and a
     random proof does not end a running session.
   - Never deposit under an ID this wallet holds open with another anchor:
     a station never gives one session ID a second chain, so one of the two
     links is not the station's.

   The deadlines that decide what the app offers, here, on a receipt
   (section 7.6) and in host mode, are judged by the latest ledger's close
   time (host mode runs it forward on the phone's monotonic clock), never
   by the phone's own date and time.
5. Check that the balance covers the amount plus fees (section 7.1).
6. Right before building the deposit, read step 4 again: the session, and
   for a new one its events, whose scan must reach the latest ledger. A
   new session paid (or paid and settled) since the page was read, or a
   top-up whose session has ended or settled since (another payer at the
   table, the station's E key, a claim from another tab), refuses the
   payment, and a scan that falls short blocks it until it is retried;
   nothing is signed either way. A top-up takes the session as read again.
   Then build
   `deposit(payer, h, s, x, fichas, anchor, terms)` with `payer` =
   this wallet and `terms` = the terms checked in step 3 for a new session,
   or the open session's own (read in step 4) for a top-up, valid until the
   latest ledger's close time + 60 s (its time bounds, so a phone whose
   clock is off is not refused). Simulate it
   (`prepareTransaction`) and check the authorization it asks for: exactly
   this call, with one sub-invocation, the SAC's
   `transfer(payer, escrow, fichas × price)`, and the deadline it returns:
   for a top-up the open session's, moved by `fichas × ficha_secs`; for a
   new session ledger time + paid time + `grace_secs`, within a few
   ledgers. Otherwise refuse. Sign on the phone (biometrics
   as today), send, and poll `getTransaction` until it succeeds; the return
   value is the deadline. The signature covers the terms and the transfer's
   amount: terms the host changed after the app's read fail the deposit
   (`TermsChanged`) instead of applying, and nothing is charged.
7. Keep, on the phone, under the session's ID and anchor (two sessions
   under one ID are two records): network, `escrow`, `h`, `s`, `x`, the anchor, the
   session's terms (`price`, `ficha_secs`, `unit_secs`, `chain_len`: the
   ones the deposit signed, so the session's), its fichas, amount and
   deadline, and the deposit's transaction hash. A proof is checked against
   this anchor, never against one a receipt brings.
8. Say, as today (section 4), that time counts only while this station
   charges the phone, and that the unused time comes back by scanning the
   receipt before the deadline (shown as a time of day).

### 7.5 The station in custody mode

Settings (`.env`):

- `PAYMENT_MODE`: `direct` (the default) or `custody`.
- `custody` requires `STATION_ID`, `ESCROW_CONTRACT` (`C…`),
  `CHARGE_VERIFY=true`, `STELLAR_NETWORK=testnet` and native XLM (empty
  `PAYMENT_ASSET_CODE`, section 7.10); it is refused on the public network
  until the contract is audited.
- `RPC_URL`: default `https://soroban-testnet.stellar.org` on testnet; no
  default on the public network.
- `REFUND_UNIT_SECONDS` = `unit_secs`; `ESCROW_GRACE_SECONDS` =
  `grace_secs`, at least 900 + `PLUG_TIMEOUT_SECONDS` (1080 with the
  defaults): with less, a phone plugged in at the last moment could never
  use its paid time before the session ends, so the station refuses to
  start, although the contract and the registry accept from 300.
- At startup, after the registry check (section 2), the station reads
  `station(HOST_PUBLIC_KEY, STATION_ID)` with no key (section 7.2) and
  compares it with its own settings as the app does (section 7.4, step 3).
  A difference, or no such station, refuses to start and lists each
  difference; an RPC it cannot reach lets it start with "escrow unchecked"
  on screen. While it runs it reads `station()` again every minute, and at
  once after a deposit under terms that are not its own: a difference (the
  host registered the station again) puts it out of service, the escrow
  item red with the difference, until a read matches again; a read that
  fails changes nothing, and a read that matches turns "unchecked" into ok.

Watching: `getEvents` only, for `deposit` and `settle` on (host,
`STATION_ID`) (section 7.2), with its cursor kept on disk per network,
contract, host and station. The Horizon watcher of direct mode keeps
running: a classic payment to the host with this station's memo is logged
as today (`orphan` or `refused`) for a refund by hand.

Ledger time: each `getEvents` page also gives the latest ledger's close
time (`latestLedgerCloseTime`), which the station moves on with its own
monotonic clock until the next page. Every deadline decision below (a
session's end, a receipt's expiry) is in that ledger time, never in the
station's clock, which only shows as a warning on screen when it is more
than 60 s off. Until the first page is read, and after 30 s without one,
the station is out of service: no pay QR, as with a relay that does not
answer, since a deposit made then would not be seen until later, its
payer maybe gone.

Each session:

- AWAITING_PAYMENT: a new session ID, a new seed (section 7.3), the pay link
  as its QR. The seed is on disk before the QR shows.
- A `deposit` event is credited only when its session topic is the session
  the station is awaiting or serving, `anchor` is that session's anchor,
  `terms` are the station's own (its startup check's, section 7.4 step 3),
  `amount` = `fichas` × the price in stroops, and `total_fichas` is at most
  `MAX_SESSION_MINUTES / FICHA_MINUTES` (rounded down). It credits
  `fichas × ficha_secs` seconds:
  there is no change and no capped time, since the contract takes exact
  amounts and caps the fichas. The payment's `source` is `escrow`, its
  `tx_hash` the event's transaction and its `payer` the event's.
- The current session's ID with another anchor (someone paid it with a
  chain of their own): not credited, logged `refused` (`anchor mismatch`).
  On the contract that is another session, which that depositor refunds
  with its own chain; the station keeps its session, seed and QR, and its
  payer pays them as usual. Nothing else changes.
- Its own session with `terms` that are not the station's (the host changed
  them on the contract after the startup check, and the payer signed those):
  refused like an amount that is not `fichas × price`, with the full-refund
  receipt below, its share counted in the session's own units (in full
  only up to the station's N: section 7.10). The next payer would sign the
  same terms, so the station goes out of service at once, until the
  contract is read again and matches (above).
- Any other session (a stale QR, or a top-up after the session ended): not
  credited as time, logged `orphan`. While that session's receipt waits to
  be claimed the station recomputes `q` and `z` for the new paid total, so
  the claim returns the late top-up too; a stale QR of a session never
  served, or of a served session that has settled since (the deposit opens
  it again on the contract), gets the full refund below (`session not
  served`, `session already settled`); otherwise the host refunds it by
  hand with `host_refund`.
- A custody session ends, at the latest, at its deadline minus 900 s (the
  latest `deposit` event's `deadline`) in ledger time, with the new end
  reason `deadline`: the payer always has 15 minutes to claim. The other
  end reasons are as today (section 5).
- At the end: U by the rule in section 7.7, from the session's
  `consumed_seconds`, and never more than N; the receipt is v2
  (section 7.6), with `q` = U and `z` = c[N−U]. A session holding more
  fichas than the station's terms allow (section 7.10) is refunded by proof
  up to N, the rest by `host_refund`.
- A paid session the station cannot serve at all (out of service, a fault
  before charging): the receipt carries `q` = N and `z` = c[0], a full
  refund whatever was paid, top-ups included. Its other fields: `u` 0,
  `wh` 0.000, `x` 0, `vd` `u`, `c` 0, `t` when the station refused it. Its
  proof is in the log line (`refused` or `orphan`), and the receipt itself
  is logged (`unserved`), so a restart shows it again. It waits to be
  claimed as any receipt (below), and never in place of a served session's
  receipt (anyone can pay a stale QR): the two take turns. The station's
  notice points at the receipt when it is (or, after the session on screen,
  will be) shown; otherwise (its deadline already passed: the deposit was
  seen late) it says to ask the operator, who refunds by `host_refund` from
  the log.
- A `settle` of the session the station is serving (a `host_refund` while
  charging, a claim on the FINISHED screen): logged as any settle; the
  time already credited runs out as paid, and its receipt is never offered
  as the last receipt. A later deposit under the same ID and anchor, which
  opens a new session on the contract, is never credited: it is logged
  `refused` (`orphan` on the FINISHED screen), reason `session already
  settled`, with the full refund above. Revealing c[0] is safe then: the
  session it also proves has settled for good.
- `FINISHED_SECONDS` defaults to 60 in custody mode. After it the receipt
  waits to be claimed until the `settle` event for that session (ID and
  anchor) or its deadline in ledger time, whatever comes after it. The
  AWAITING_PAYMENT screen shows a smaller "last receipt" QR, labelled as
  the previous customer's (or "Not served"), not a pay QR, with the minutes
  left to claim (never a time of day: the station's clock or time zone may
  not be the payer's phone's). It shows the newest served receipt that
  refunds something and the newest unserved full refund, taking turns every
  8 s with "1/2" and "2/2" when there are both. A receipt that refunds
  nothing (all its paid time charged) or whose deadline has passed is never
  shown and never takes another's place; it still waits, since a top-up can
  make it refund. That QR is `ficha:/r?v=2&…`, the same receipt as the
  FINISHED screen's `<APP_URL>/r?…`: a phone camera pointed at the pay QR
  beside it does not open it, the Ficha app's Scan QR (and on Android its
  `ficha:` link) does.
- At a restart the receipts are offered again in the order they were made,
  by these rules. A `settle` line settles a receipt of the same ID and
  anchor whose session was opened before it (a served one at its first
  `credited` line), never one opened after it under the same ID and anchor.
  Deadlines wait for the first read of the ledger: the station's own clock,
  unchecked until then, could drop a receipt the contract still pays.
- On a `settle` event: log `settled` with the session's id, `anchor`,
  `to_host`, `to_payer`, `unused_units`, `how` and the transaction hash. A
  settle whose anchor is not the one this station gave that session ID is
  someone else's session: logged with `"foreign": true`, and the station's
  receipt and state do not change. The session record's `refund_hint` says
  the refund is automatic, with U and the payer's share:
  `{"automatic": true, "unused_units": U, "to_payer": "<amount, 7 decimals>", "asset": …}`.
- After missed events (section 7.2: the RPC's window), the sessions the
  station still tracks are read with `session(h, s, x, anchor)`.
- The station never sends `release` or anything else: it has no key. The
  host (or anyone) releases sessions past their deadline.

### 7.6 Receipt v2 and the claim

```
<APP_URL>/r?v=2&m=&n=&h=&a=&k=&f=&p=&u=&wh=&x=&vd=&c=&t=&q=<U>&z=<proof>
```

- In that order. `v` 2. `m` = `<STATION_ID>.<SESSION>`: no memo exists on
  the ledger, it names the session. The rest as in v1 (section 3), with `a`
  the session's total deposit (a decimal string in the asset), `f` its total
  fichas, `p` = `f × ficha_secs` and `u` its `consumed_seconds`.
- `q`: U, a whole number from 0 to N. `z`: c[N−q], base64url, 43
  characters.
- Example: `receipt_v2` in the test vectors. Direct-mode receipts stay
  `v=1`, unchanged.
- Showing the proof in public is safe: only the session's payer can use
  it, once.

The app, with a v2 receipt:

1. Parse it, and find its own deposit for (`n`, `h`, `s`, `x`), with `s`
   and `x` from `m`: of the records under that ID, the one whose anchor the
   proof leads to. None on the phone: the anchor SHA-256 applied `q` times
   to `z` gives (q at most 256) names the session to read on the ledger; if
   it is open and this wallet's, that is the deposit. Otherwise not this
   wallet's session: shown read-only, no claim, with the public check
   below.
2. Check, offline, that SHA-256 applied `q` times to `z` gives the anchor
   it deposited, with `q` at most 256 (the contract's bound). If not: "the
   station's proof does not match", no claim.
3. Check `q` against `p`, `u` and the session's `unit_secs` (section 7.7).
   A different `q` is shown as a station error, and the app still offers
   the claim with `q`: it is the only proof it has. With `u` = 0, any `q`
   from the paid units up to 256 is not one: it is the full refund of a
   deposit the station could not serve (section 7.5), whose proof is c[0]
   of the station's chain, so `q` is the station's N, which differs from
   the session's when the deposit was made under other terms (section
   7.10).
4. Read `session(h, s, x, anchor)`. None open: already settled (find its
   `settle` event, by session and anchor, to show it). Ledger time past the
   deadline: "the deadline passed; the host was paid in full", no claim.
5. Show "X back, Y to the host", X = ceil(amount × min(`q`, paid units) /
   paid units) and Y = amount − X, and claim with biometrics:
   `claim(h, s, x, anchor, q, z)`, signed by the payer. The return value is
   X, paid to the payer in this transaction whatever the host does with its
   account; Y is kept for the host (an `owed` event, then the `settle`).
6. "Conferido na blockchain", on a v2 receipt, means: this wallet's deposit
   for the session exists, `a`, `f` and `k` match it, and the proof leads to
   its anchor.

A deposit record whose ledger is more than 1000 ledgers past the network's
latest ledger was made before a testnet reset (the ledger starts over from
1): the app settles it as `reset`, with no claim, in History, on `/p` and on
`/r`.

**The public check.** Anyone with a v2 receipt link, with no wallet and
nothing signed, can see what it proves (everything in section 7.2 is
public): the registry must list `s` under `h` in custody, the named
contract must run code the app pins, and the anchor the proof leads to
(`q` at most 256) names the session. Then `session(h, s, x, anchor)` open:
what a claim with `q` would pay each side, and the deadline. Not open: the
session ID's events with that anchor, a `settle` showing how it settled
(`proof`, `deadline` or `host`, both shares) with links to the deposit and
settle transactions, or only deposits when the settle is past the RPC's
window. Nothing found (an older link, past the window too, or a proof that
leads nowhere): no public check is shown, only the station's statement.

### 7.7 Units, rounding and deadlines

- Paid units = total fichas × `ficha_secs` / `unit_secs`; N =
  `max_fichas × ficha_secs / unit_secs`, never fewer.
- U (the station): U = min(paid units, ceil(max(0, paid_seconds −
  consumed_seconds) / `unit_secs`)), where paid_seconds = total fichas ×
  `ficha_secs`. Rounded up, in the payer's favour; `consumed_seconds` is
  whole seconds rounded down for the same reason (E or ESC can land between
  two ticks, and so can the consumed-time checkpoints).
- The payer's share (the contract): ceil(amount × U' / paid units) with
  U' = min(U, paid units); in integers `(amount × U' + paid − 1) // paid`.
  The host's share is the amount minus that. They always add up to the
  amount; U = 0 pays the host in full, U ≥ paid units refunds in full.
- Deadline = opened + total fichas × `ficha_secs` + `grace_secs`, where
  opened is the ledger time of the first deposit; a top-up moves it by its
  own `fichas × ficha_secs`.
- At ledger time = deadline, `claim` and top-ups still work, while
  `release` and a partial `host_refund` do not; from one second later, only
  `release` and `host_refund` (any units).
- `grace_secs`, recommended: `PLUG_TIMEOUT_SECONDS` 180 +
  `PAUSE_TIMEOUT_SECONDS` 600 + a 900 s claim window = 1680.
- Vectors: `unused_units`, `payer_share` and `deadline` in the test vectors.

### 7.8 Who can do what

| Who | Can | Cannot |
|---|---|---|
| Whoever deployed it | nothing | there is no admin, upgrade or withdraw |
| The host (its key, on its own device, never the station's) | register and change its stations (open sessions keep their terms; a deposit signed for the old ones fails); refund its sessions (in full until the deadline, any part after it); receive the host's share (at once on release and host_refund; a claim's through `pay_host`) | claim; cut a refund before the deadline; hold a refund back or fail a claim by changing its account, before the payer simulates or after (a claim never touches it); touch another host's stations |
| The payer (a `G…` account, or a contract account `C…` such as a passkey wallet: the contract only calls `require_auth`) | deposit under the terms it read; top up its own session; claim it with the station's proof until the deadline | claim more units than the proof shows; pay into a session another wallet holds |
| Anyone | release a session after its deadline (all to the host); pay a host what it is owed (`pay_host`, to the host only); read | anything else; take a station's session by paying its QR's ID with another chain (that is a session of its own) |
| The station | read the ledger | sign anything: it has no key and no account, and pays no fee |

### 7.9 Rules that change in custody mode

| Rule | Direct mode | Custody mode |
|---|---|---|
| Where the money goes | the host's account, at once | the contract, then only to the host or back to the payer: the payer's share at the claim (the host's share is then kept for the host until `pay_host`), or all to the host after the deadline (the paid time + 28 min with the recommended grace) |
| The operator never custodies | no custody | kept: no admin, no upgrade; the deployer has no power over the contract |
| The station holds no secret key | no secret at all | it signs nothing, has no account and pays no fee; new: a random one-use seed per session, which can only refund that session's payer |
| Refunds | by hand, from `sessions.jsonl` | the payer's claim with the station's proof, one tap on the receipt before the deadline; by hand becomes `host_refund` |
| Prepaid, billed by time, fichas die with the session | yes | kept: a session settles once |
| A session paid by several wallets | allowed | one payer per session (`OtherPayer`, seen at simulation) |
| Rounding | floor; change and capped time refunded by hand | exact amounts only; unused time rounded up, for the payer |
| Pay out only if current flowed (roadmap) | no | in part: paid by default, unless the station proves time not delivered |

### 7.10 Limits

- The station's measurement is trusted as today: a station whose software
  the host altered could reveal fewer units. The proof stops everyone else,
  the host included, from cutting a refund the station grants.
- A payer who never scans the receipt gets nothing back: the host is paid in
  full after the deadline, as with a direct payment.
- Refunds trust the asset's issuer: an issuer can freeze a payer's balance
  before the claim (the claim fails, and release later pays the host) or
  claw back what the escrow holds. So custody takes native XLM only, which
  has no issuer, in the registry (section 2) and at the station (section
  7.5). An issued asset would come later with an allowlist of issuers, never
  one that is the station's host.
- The payer's signature covers all of the session's terms (`deposit`'s
  `terms`) and the transfer's amount: a register that lands after the app's
  read fails the deposit with `TermsChanged`. An open session's terms never
  change. A host that changes its terms on the contract and in the registry
  while a station still runs with the old settings gets its deposits refused
  by that station (section 7.5), with full refunds by proof as far as the
  station's chain reaches (q at most its N); the rest, if any, is for
  `host_refund`. The station goes out of service within a minute (at once
  after the first such deposit) until it is restarted with the new terms.
- A host whose account cannot take its share when a session settles
  (merged away, no trustline, its balance frozen by the issuer) holds
  nothing back: the payer is paid, and the host's share waits in the
  contract as owed until `pay_host`. It can never go to anyone but that host.
  Nor can a host fail a claim by changing its account between the payer's
  simulation and the ledger, either way: a claim never touches the host's
  account and always keeps its share as owed. The cost is one more
  transaction for the host: `pay_host` collects all its claims' shares in a
  token at once.
- Anyone who copies a station's pay link exactly (the same ID and anchor)
  can pay that session first. The real payer's deposit then fails with
  `OtherPayer` at simulation, before signing, and the station serves the
  copier's deposit as its own: whoever is at the station charges on the
  copier's money, or, with no phone plugged in, the session ends
  (`not_plugged`, the plug timeout plus `FINISHED_SECONDS`, about 4 min) and
  its receipt refunds the copier. The copier pays the fees each time and
  gains nothing; a deposit with a chain of its own changes nothing at the
  station at all.
- Upkeep on the ledger (TTL extension, the testnet reset): see
  `contracts/escrow/README.md`. After a reset the ledger starts over from 1:
  the station drops by itself a saved cursor (Horizon's or the escrow's)
  more than 1000 ledgers past the network's latest ledger, and reads on as
  on a first run.
