# The first mainnet run

The first real session of Ficha on the Stellar public network: station
`8DY7RJ`, in direct mode, at HackMeridian 2026 in Lisbon, on 25 October
2026. Real XLM paid straight to the venue's account, a real relay and
charger, a phone charging. Times are UTC, which was also Lisbon's time that
day. Every value here is public: on the ledger, in the signed registry, or
in the station's log. No key, secret or local address is in this record,
and none is needed to check it.

## What ran

| | |
|---|---|
| Station | `8DY7RJ`, "HackMeridian mainnet (direct)": `main.py` on the bench laptop, the relay board switching a USB wall charger's 5 V, the phone's battery current read over WiFi ADB (the `mains` topology: [README, Hardware](../README.md#hardware)) |
| Network | the Stellar public network, through `https://horizon.stellar.org`; direct mode reads Horizon only, with no key and no account |
| Venue (host) account | [`GDVPPO2JSSCMTPAL2CY7WZQSUEONXU45MR4GCUY3CNAFQUTRZ5JK6ZCN`](https://stellar.expert/explorer/public/account/GDVPPO2JSSCMTPAL2CY7WZQSUEONXU45MR4GCUY3CNAFQUTRZ5JK6ZCN); its key is the owner's, and the station knows only this public key |
| Terms | native XLM, 0.5 XLM per 1-minute ficha, up to 10 minutes |
| Registry | [`registry/stations.public.json`](../registry/stations.public.json), issued `2026-10-25T15:50:00Z`, signed by the public registry key `GC2GUQLX6M6LI7ZYWOVROJAFV6EEZFOVSHCODC7TVAUOIBKEE47E3ZFG`, which `config.py`, `app/src/config.ts` and [the spec, section 2](station-app-contract.md#2-station-registry) pin; published with the site at <https://ficha-stellar.vercel.app/registry/stations.public.json> (+ `.sig`), the same bytes |
| Payer | the Ficha app's wallet, [`GDXV6M2HI5HRWNSDMNN6X4AABXCYAMAO2347BIMJT5CFB3UQOL2I627D`](https://stellar.expert/explorer/public/account/GDXV6M2HI5HRWNSDMNN6X4AABXCYAMAO2347BIMJT5CFB3UQOL2I627D), on Mainnet |

## Settings

The station's settings that touch money, and its hardware mode. None is a
secret: the station holds no key, and it refuses to start with an `S…` key
in any key setting. The hardware's own addresses (the relay's port, the
phone's ADB address) are left out.

```ini
STELLAR_NETWORK=public
HORIZON_URL=                 # empty: https://horizon.stellar.org
PAYMENT_MODE=direct
STATION_ID=8DY7RJ
STATION_NAME=HackMeridian mainnet (direct)
HOST_PUBLIC_KEY=GDVPPO2JSSCMTPAL2CY7WZQSUEONXU45MR4GCUY3CNAFQUTRZ5JK6ZCN
PAYMENT_ASSET_CODE=XLM       # with no issuer: native XLM
PAYMENT_ASSET_ISSUER=
FICHA_PRICE=0.5
FICHA_MINUTES=1
MAX_SESSION_MINUTES=10
REGISTRY_CHECK=true
REGISTRY_KEY=                # empty: the pinned public registry key
REGISTRY_URL=                # empty: the site's copy, then the repo's
MOCK=false
MOCK_PAYMENT=false
CHARGE_VERIFY=true
METER_SOURCE=phone
TOPOLOGY=mains
ADB_TRANSPORT=tcp
COURTESY_SECONDS=0
WIFI_PORTAL=off
APP_URL=https://ficha-stellar.vercel.app
```

On the public network the station refuses `MOCK=true`, `MOCK_PAYMENT=true`,
`REGISTRY_CHECK=false`, `CHARGE_VERIFY=false`, custody, the testnet demo's
keys, and a Horizon that is not https or does not say it serves the public
network ([operators guide, section 4](operators.md#4-switching-testnet--public)).
`.env.public.example` has the same settings, with `<...>` for a station's
own values.

## Steps

1. **The keys stay with the owner.** The venue's account and the registry
   key are the owner's; neither secret is in this repository, on the
   station or in the app. The registry key's public half is pinned in the
   station and the app.
2. **The signed entry.** `registry/stations.public.json` lists `8DY7RJ`
   with the host key, the asset and the terms above. It was signed with
   `tools/registry.py sign` on the owner's machine, verified with the
   pinned key, and published with the site byte for byte (the site's build
   and publish refuse a registry whose signature does not verify).
3. **The station starts.** On the public network it starts only when its
   startup check says `registry ok`: its settings match its signed entry,
   checked with the pinned key. It reads payments only from a Horizon that
   says it serves the public network, shows no pay QR while Horizon is
   failing, re-reads the site's registry every minute, and its screen
   carries a MAINNET, real XLM banner. Session `8DY7RJ.FAFXJXBZ` was
   waiting for a payment from 17:45:19. Its pay QR is a SEP-7
   `web+stellar:pay` request to the host with the memo `8DY7RJ.FAFXJXBZ`.
4. **The payment.** The Ficha app, set to Mainnet, paid that QR. On
   Mainnet the app pays only a station the signed registry lists, under
   that station's host key, and never a QR without a station code. It sent
   1 XLM for 2 fichas: transaction
   [`958e7ab6…`](https://stellar.expert/explorer/public/tx/958e7ab6bb01962525bb1171aeb90bc5f74677dda62906fb2c17ea2e9ca49e3a),
   in ledger 65133028, closed at 17:55:23.
5. **The station credited it** from Horizon at 17:55:26, 3 s after the
   ledger closed: 2 fichas, 120 s, no change due. It closed the relay, and
   time counted only once the probe had passed (the relay opens for 3 s
   and the phone's current must drop), at 17:55:31.
6. **Time up** at 17:57:32: 120 s charged of the 120 s paid. The relay
   opened, and 1 s later the phone said its charger was gone, its current
   down from 2 677 mA (charging) to −1 170 mA (on its battery): the cut
   confirmed.

## On the ledger

| | |
|---|---|
| Transaction | [`958e7ab6bb01962525bb1171aeb90bc5f74677dda62906fb2c17ea2e9ca49e3a`](https://stellar.expert/explorer/public/tx/958e7ab6bb01962525bb1171aeb90bc5f74677dda62906fb2c17ea2e9ca49e3a) ([on Horizon](https://horizon.stellar.org/transactions/958e7ab6bb01962525bb1171aeb90bc5f74677dda62906fb2c17ea2e9ca49e3a)) |
| Ledger | [65133028](https://stellar.expert/explorer/public/ledger/65133028), closed 2026-10-25 17:55:23 UTC |
| Operation | one `payment`: 1 XLM (native) from the payer `GDXV6M2H…` to the host `GDVPPO2J…` |
| Memo | text, `8DY7RJ.FAFXJXBZ`: the station's ID and the session's |
| Fee | 100 stroops (0.00001 XLM), paid by the payer |
| The station's part | none on the ledger: it signed nothing and sent nothing, and read the payment from Horizon |

## What the station logged

The station's `sessions.jsonl` (kept outside the repository, as every
session log is) has five lines for this session, in order: `credited`,
`delivering`, `finished`, `cut`, and the closing `session` line. Their
values:

| Field | Value |
|---|---|
| `id`, the memo | `8DY7RJ.FAFXJXBZ` |
| `network`, `host_key` | `public`, `GDVPPO2J…` |
| `payer` | `GDXV6M2HI5HRWNSDMNN6X4AABXCYAMAO2347BIMJT5CFB3UQOL2I627D` |
| `tx_hash`, `op_id`, `source` | `958e7ab6…`, `279744225149546497`, `horizon` |
| `amount`, `fichas`, `paid_seconds` | 1 XLM, 2, 120 |
| `change_due` | 0 |
| `verify_mode`, `verified_at` | `probe`, 17:55:31 |
| `probes` | 1 passed, 0 failed |
| `consumed_seconds`, `unused_seconds`, `capped_seconds` | 120, 0, 0 |
| `end_reason`, `final_state` | `time_up`, `FINISHED` (at 17:57:32) |
| `max_current_ma`, `wh` | 2762, 0.3543 |
| `meter_reads` | 126 ok, 0 failed |
| `verdict` | `delivered` |
| `cut_confirmation` | confirmed by `charger_gone`, 2677 → −1170 mA, 1.0 s after the end |
| `refund_hint` | change 0, capped 0, unused 0 XLM: nothing due |

This session ran before the direct-mode refund flow was committed (from
18:03 UTC the same day), so its lines carry `refund_hint` but no `refunds`;
nothing was due either way.

## Check it yourself

No wallet and no money needed.

1. **The signed registry.** From the repository root, with the station's
   requirements installed ([README, Run it locally](../README.md#run-it-locally)):

   ```bash
   python tools/registry.py verify --file registry/stations.public.json --key GC2GUQLX6M6LI7ZYWOVROJAFV6EEZFOVSHCODC7TVAUOIBKEE47E3ZFG
   # OK: stations.public.json (public, 1 station(s)) signed by GC2GUQLX6M6LI7ZYWOVROJAFV6EEZFOVSHCODC7TVAUOIBKEE47E3ZFG
   ```

   The copy the app reads,
   <https://ficha-stellar.vercel.app/registry/stations.public.json>, is the
   same bytes.
2. **The payment.** On
   [stellar.expert](https://stellar.expert/explorer/public/tx/958e7ab6bb01962525bb1171aeb90bc5f74677dda62906fb2c17ea2e9ca49e3a):
   the destination is the registry's `host_key` for `8DY7RJ`, the memo
   starts with `8DY7RJ.`, and 1 XLM is 2 fichas at 0.5 XLM.
3. **The station's guards**, with no network and no money:
   `python smoke_test.py` runs them, among the station's checks, on a fake
   clock and a fake Horizon.

## Still pending

- **The first live refund on mainnet.** This session owed nothing. The
  direct-mode refund flow is built and tested in simulation (the station's
  checks in `smoke_test.py`, the app's tests in `app/src/refund/`): the
  station shows each refund due on the operator's R key, as a SEP-7 QR and
  a **Refund with Freighter** button that opens the site's `/refund` page,
  which checks the signed registry and the host's payments on the ledger
  before Freighter signs as the host; the station marks the refund paid
  when it sees the host's payment with the memo `refund <REF>`
  ([operators guide, refunds by hand](operators.md#refunds-by-hand-direct-mode),
  [spec, section 3.1](station-app-contract.md#31-refund-uri-direct-mode)).
  No refund has been made on mainnet yet; the first one will be added
  here.
- **Custody on mainnet** waits for an audit of FichaEscrow. Until then the
  station, the registry tool and the app refuse it on the public network,
  and the custody demo (`YX3DGE`) stays on testnet
  ([docs/testnet-e2e.md](testnet-e2e.md)).
