# Ficha operator guide

How to run a Ficha station: simulated on any laptop, on the bench, and on the
relay with a real phone. This was the body of the README; the README is now
the project's overview. The section numbers did not change, so "README,
section N" in the `.env.*.example` files and in the station's messages points
here. Paths are from the repository root.

| Section | |
|---|---|
| [1. Run it simulated](#1-run-it-simulated-start-here) | no board, no phone, no wallet |
| [2. Wiring](#2-wiring) | the relay on its NO contact, the two topologies |
| [3. Offered network](#3-offered-network) | the "Get online" QR; [free emergency minutes](#free-emergency-minutes), public safety mode: the settings, on and off |
| [4. Switching testnet → public](#4-switching-testnet--public) | the checklist |
| [5. How money flows](#5-how-money-flows) | direct mode, the log, the signed registry |
| [6. Time counts only while this station charges the phone](#6-time-counts-only-while-this-station-charges-the-phone) | probes, pauses, timeouts |
| [7. Custody mode (testnet)](#7-custody-mode-testnet) | the FichaEscrow contract from the station's side |

The rules both sides follow are in
[station-app-contract.md](station-app-contract.md); the contract's build and
upkeep in [contracts/escrow/README.md](../contracts/escrow/README.md).

## 1. Run it simulated (start here)

No board, no phone, no wallet needed.

```bash
python -m venv .venv
.venv\Scripts\activate            # Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env            # Linux: cp .env.example .env
python main.py
```

Open http://127.0.0.1:8000 and pay with a fake payment:

```bash
curl -X POST localhost:8000/debug/pay -H "content-type: application/json" -d "{\"amount\": \"2\"}"
```

The screen asks you to plug the phone into this station. The fake phone is
plugged in (`MOCK_PLUG=station`): its current jumps to about 3 000 mA, the
station opens the relay for 3 s to check that the current is its own
("Checking the charge…"), and only then does the countdown start at 10:00
(section 6). More to try:

| what | how |
|---|---|
| phone charging from another socket | `MOCK_PLUG=elsewhere` in `.env`: never verified, nothing consumed, the session ends after 3 min as `not_plugged` with all its time logged for refund |
| no phone at all | `MOCK_PLUG=none` |
| extend (add fichas) | pay again, same command |
| underpaid (not credited, logged) | `{"amount": "0.4"}` |
| orphan, no memo | `{"amount": "1", "memo": null}` |
| orphan, unknown session | `{"amount": "1", "memo": "FNOPE"}` |
| another station's memo (ignored) | `{"amount": "1", "memo": "K7M2QX.F2345678"}` |
| receipt QR | let a paid session end: the FINISHED screen shows it for 20 s |
| courtesy (60 s free, once) | press **C** on the station screen |
| end the session (or courtesy) now, `end_reason` `stopped`: the payer asked to stop, or a demo shows the refund | press **E** on the station screen |
| cut power now (emergency), `end_reason` `emergency_stop` | press **ESC** on the station screen |
| unplug the fake phone mid-session, then plug it back in (the countdown pauses, then a probe resumes it) | press **U** on the station screen while charging (`MOCK=true` only; the header shows it) |
| offer a network ("Get online" QR) | set `WIFI_SSID` and `WIFI_PASSWORD` in `.env` |
| free emergency minutes: 2 min of charge and 2 min of internet per phone per day, the emergency numbers (section 3) | open http://127.0.0.1:8000/portal (`WIFI_PORTAL=simulate` in `.env.example`); `?clientmac=02:11:22:33:44:55` plays another phone |

Every closed session and every uncredited payment lands in `sessions.jsonl`.

Smoke test of the whole flow (courtesy, extension, underpaid, orphans, cap,
ESC, verdicts, both topologies, charge verification, station IDs, registry,
receipts, refund hints, config checks, custody mode, free emergency minutes
and the Wi-Fi portal) on a fake clock:

```bash
python smoke_test.py
```

Each station can carry an ID and a name in `.env`:

- `STATION_ID`: 6 characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ` (no 0, 1,
  I, L, O or U), printed on the hardware and listed in the signed station
  registry (section 5). Payment memos become `<STATION_ID>.<SESSION>`, e.g.
  `K7M2QX.F3H9TXAB`, so several stations can share one host key. Empty keeps
  the bare session memo (`F3H9TXAB`).
- `STATION_NAME`: shown on the screen and in the wallet's payment message,
  "Ficha Test bench · session K7M2QX.F3H9TXAB".
- `APP_URL`: the Ficha app's https address, the start of the receipt QR
  (section 5). Empty makes receipts start with `ficha:`. Suggested:
  `APP_URL=https://ficha-stellar.vercel.app`, so a receipt scanned with the
  phone's camera opens the site, or the Ficha app.

With `STATION_ID` set, the station checks itself against the signed station
registry at startup (section 5) and refuses to start when its entry differs
from `.env`. `REGISTRY_CHECK=false` skips that (development only: the public
network refuses it, section 4).

The station refuses to start on a configuration that cannot work or is unsafe,
and says what to change. Besides the topology and network combinations:
`MOCK_PAYMENT=true` with a `HOST` other than loopback (anyone on the network
could make free payments), a `HORIZON_URL` that is the other network's
Horizon (or, on public, one that is not https), a `FICHA_PRICE` that is not
a positive number with at most 7 decimals, `MIN_CURRENT_MA` below 1,
`HORIZON_POLL_SECONDS` below 0.5, a
`CURSOR_DIR` that does not exist or cannot be written, a `SESSION_LOG` that
cannot be written (or whose directory does not exist), a malformed
`STATION_ID`, an `APP_URL` or `REGISTRY_URL` that is not https, a secret key
in `REGISTRY_KEY`, a station that differs from its signed registry entry,
`METER_SOURCE=outlet` without `MOCK`, probe or pause timings out of range
(section 6), and free emergency minutes that cannot work (section 3: free
minutes without a portal, a portal without `EMERGENCY_NUMBERS`, more than 6
numbers or one that does not end in a number, free seconds outside 0 to
3600, a `FREE_RESET` other than `midnight`, `WIFI_PORTAL=opennds` on a
loopback `HOST` or without `WIFI_SSID`).

On the public network (section 4) it also refuses `MOCK=true`,
`MOCK_PAYMENT=true`, `CHARGE_VERIFY=false`, `PAYMENT_MODE=custody`,
`REGISTRY_CHECK=false`, an empty `STATION_ID`, no registry key (none is
pinned for public yet: set `REGISTRY_KEY`), a `REGISTRY_KEY` other than the
pinned public key once there is one, the testnet demo's host or registry key
as `HOST_PUBLIC_KEY` or `REGISTRY_KEY`, and a registry that could not be
checked at startup (anything but `registry ok`, even offline).

To receive real **testnet** payments, set `HOST_PUBLIC_KEY` to a testnet
account you control (create and fund one in Stellar Laboratory) and pay the
QR from a testnet wallet. The station only ever needs the public key.

`MOCK_PROFILE` picks the fake meter's numbers: `fast` imitates a 45 W charger
(2 500–4 000 mA), `usb` a laptop port (450–600 mA). Empty follows `TOPOLOGY`.
`MOCK_PLUG` says where the fake phone is plugged in: `station` (charges only
while the relay is closed), `elsewhere` (another charger: charges whatever the
relay does) or `none`.

## 2. Wiring

Board: LCUS V4.3 (LC Technology), 1 channel, CH340, USB-A male built in.
It shows up as a COM port on Windows (`RELAY_PORT`). Contacts: 10 A / 250 VAC.

**Both topologies use the NO (normally open) contact, never NC.** Any failure
(board unpowered, process dead, wire loose) must end in "does not charge",
never in "charges for free". The software opens the relay at startup, on any
crash of the main loop, on Ctrl+C and on SIGTERM.

### MAINS (target)

```
 wall outlet ── PHASE ──[COM  relay  NO]── charger (45 W USB-C PD/PPS, certified)
            └─ NEUTRAL ─────────────────── charger
                                             │
                                  USB-C cable, 3 A, up to 1 m
                                             │
                                           phone  ~~~ WiFi ADB ~~~ station
```

The relay switches the **phase** feeding the charger. The USB path is whole,
never cut, so the phone negotiates fast charging with the charger normally.
The cable carries no data to the computer, so the phone is read over WiFi ADB
(`ADB_TRANSPORT=tcp`, `ADB_SERIAL=ip:port`).

> **⚠ Mains voltage can kill.** Build this only if you are qualified to work
> with mains wiring, or have it done by someone who is. Everything goes inside
> a closed, insulated enclosure; every terminal is covered; the board's
> screw terminals are never reachable by a finger; use a fused, earthed
> outlet and a certified charger. Never work on it while it is plugged in.

### USB_VBUS (fallback)

```
 laptop USB 3.0 ── extension (male) ──┬── GND  ────────────── (female) ── phone
                                      ├── D+/D- ────────────
                                      └── VBUS (red) ─[COM relay NO]─
```

A USB male-female extension with the red VBUS wire cut; the two ends go to the
COM and NO terminals. Ground and data stay intact. Power comes from the laptop
port (450–600 mA). The phone is read over USB ADB through the same cable, so
**ADB disappears when the relay opens** and comes back when it closes. That is
expected: the station's probe (section 6) passes when the phone vanishes with
the relay open, and the phone vanishing at the end confirms the cut. With
`CHARGE_VERIFY=false` the station instead waits for the phone
(`ADB_WAIT_TIMEOUT`) before it starts counting.

So usb_vbus needs `ADB_TRANSPORT=usb`; with `tcp` the station refuses to
start (except with `MOCK=true`). A cut VBUS with the phone read over WiFi ADB
(a wall charger instead of the laptop port, say) keeps the phone readable
with the power off, which is how mains behaves: set `TOPOLOGY=mains` for it.

## 3. Offered network

A user with no mobile data cannot pay. The station can offer a WiFi to get
online: set `WIFI_SSID`, `WIFI_PASSWORD` and `WIFI_SECURITY` (`WPA` or
`nopass`) and the screen shows two numbered QR codes side by side while it
waits for a payment: **1. Get online** (joins the network) and **2. Pay**.
With `WIFI_SSID` empty, only the payment QR appears.

The software does **not** create or manage the access point. The network comes
from outside, a router or the operating system's hotspot, and the station only
draws its QR from `.env`. The network is **offered, never required**: nothing
in the station depends on the user being on it.

The network must:

- **reach the internet**, or the wallet cannot send the payment;
- use a **WPA2 password** (or be deliberately open with `nopass`);
- have **no captive portal**: the phone's wallet has to go straight out. The
  one exception is this station's own (`WIFI_PORTAL=opennds`, below), whose
  walled garden lets the Ficha app reach Stellar before any sign-in;
- have **no client isolation**, because the WiFi ADB meter (`mains`) talks to
  the phone across it. The only phone that must be on it is the one being
  measured.

Third-party WiFi (a café's or a hotel's) usually isolates clients, so it is
fine for users paying but useless for the ADB meter. A VPN on the station
computer that blocks the local network (a kill switch without "allow LAN")
breaks the meter the same way. In production, the access point is the
station itself.

### Free emergency minutes

Public safety mode (why, privacy, limits, who can fund it:
[public-safety.md](public-safety.md)). Where people may need to call or
message for help, the station's own Wi-Fi (a travel router running OpenWrt
and openNDS, [`openwrt/`](../openwrt/)) gives every phone, once a day,
`FREE_CHARGE_SECONDS` of charging and `FREE_INTERNET_SECONDS` of internet,
free, and shows the `EMERGENCY_NUMBERS` first on the page the Wi-Fi opens
(the portal, `/portal`) and on the station screen. Paying with Ficha works on
that Wi-Fi without spending them. No money moves for a free minute. A phone
is its Wi-Fi MAC address, kept only as a hash whose salt changes every day.

| setting | default | what |
|---|---|---|
| `WIFI_PORTAL` | `off` | `off`: no portal, no free minutes, the station exactly as before. `simulate`: no router; the portal on this computer, free internet written down but not given. `opennds`: the router sends each phone that joins to this station's `/portal` |
| `FREE_CHARGE_SECONDS` | `0` | free charge per phone per day, 0 to 3600 (120 in the demo files): this station's relay, on the courtesy's path |
| `FREE_INTERNET_SECONDS` | `0` | free internet per phone per day, 0 to 3600 (120 in the demo files): shown and written down here, given and limited by the router. Set the router's `FREE_INTERNET_SECONDS` to the same |
| `FREE_RESET` | `midnight` | the allowance starts over at local midnight, the only choice (a rolling 24 h would have to link a phone across two daily salts) |
| `EMERGENCY_NUMBERS` | empty | `label number` pairs separated by `;`, at most 6; required with a portal. `'Emergency 112'` (Portugal, the EU); `'Polícia 190; SAMU 192; Bombeiros 193'` (Brazil) |

With `WIFI_PORTAL=opennds` the station also needs `HOST=0.0.0.0` (or its
address on the router's network), `WIFI_SSID` with `WIFI_SECURITY` and
`WIFI_PASSWORD` as the router has them (the screen's join QR), and
`MOCK_PAYMENT=false` (fake payments are refused off loopback).

**The `.env` examples.** All four (`.env.example`, `.env.lisbon.example`,
`.env.mains.example`, `.env.usbvbus.example`) turn the mode on, simulated:
`WIFI_PORTAL=simulate`, 120 and 120 seconds, `EMERGENCY_NUMBERS='Emergency 112'`.
Each has the Brazil numbers and the router's lines in comments;
`.env.example` explains every setting. `.env` itself is yours: copy the
lines you want.

**On, simulated** (no router: a demo, a rehearsal). The settings of the
examples; start the station and open http://127.0.0.1:8000/portal on the
station's computer. `?lang=pt` shows it in Portuguese, and
`?clientmac=02:11:22:33:44:55` plays another phone (from this computer only:
each phone has one free charge a day, this computer's own included).

**On, with the router** (at the event, about 20 minutes;
[openwrt/README.md](../openwrt/README.md) has each step and how to check it):

1. The router online, its time zone the local one (its day must be the
   station's), its VPN, any other portal and IPv6 off.
2. `setup.sh` on the router with the station computer's MAC address, e.g.
   `STATION_MAC=a4:5e:60:d1:22:01 SSID='Ficha SOS' WIFI_OPEN=1 sh setup.sh`:
   openNDS, the walled garden, the once-a-day script, the station's fixed
   address (`192.168.8.20`), the station trusted (it never sees the portal).
3. The station computer on the router's network only, at that address, the
   network marked Private in Windows (any other network off or Public).
4. In `.env`: `WIFI_PORTAL=opennds`, `HOST=0.0.0.0`, `PORT=8000` (the
   `PORT` given to setup.sh), `MOCK_PAYMENT=false`, `WIFI_SSID='Ficha SOS'`,
   `WIFI_SECURITY=nopass`, both seconds settings as the router's, and
   `EMERGENCY_NUMBERS`. Start the station; allow Python on private networks
   when Windows asks.
5. A phone joins `Ficha SOS`: the sign-in page opens with the portal. Pay
   with Ficha; take the free internet; take it again: refused for today.

**Off.** `WIFI_PORTAL=off` and both seconds settings `0` (free seconds without
a portal stop the start). On the router, `/etc/init.d/opennds stop` (everyone
online, no portal) or `sh /tmp/setup.sh --remove` (back to the router's own
settings).

**What changes on the station while it is on.** The station screen, its
socket (ESC, C, E) and `/debug` answer only to the station's own computer;
a phone that opens the station's address gets the portal, so a second screen
elsewhere on the network is not possible. The screen shows a band with the
emergency numbers and the free minutes (with SIMULATED and "no internet is
given" without a router); a free charge reads "free charge" and counts down.
Each grant is one `free_grant` line in `sessions.jsonl` with the phone's id
of the day, never its MAC or IP; a session that had a free charge says
`"free_charge": true` (`end_reason` `free_charge_only` when nobody paid).
The day's salt and ledger are a file in `CURSOR_DIR`
(`.free_minutes.<YYYY-MM-DD>.json`), deleted within a minute of the next local
midnight (by a station that was off then, when it starts).

The portal's query, how a phone is recognised, the network and security
rules: [free-minutes.md](free-minutes.md).

## 4. Switching testnet → public

1. `STELLAR_NETWORK=public` (Horizon URL follows; `HORIZON_URL` only overrides,
   must be https, and the testnet Horizon is refused on public). On any
   network, payments are read only once Horizon's root says it serves that
   network (its `network_passphrase`); until then the footer says
   `horizon error · not the public network` and, on public, no pay QR shows.
2. `HOST_PUBLIC_KEY` = the host's **mainnet** public key (G…). Never a secret.
3. Asset: empty `PAYMENT_ASSET_CODE` means USDC from Circle's issuer
   `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`. **Confirm the
   issuer on stellar.expert** before going live, and make sure the host
   account has a trustline to it.
4. `FICHA_PRICE` in the new asset (e.g. `0.25` USDC).
5. `MOCK_PAYMENT=false` and `MOCK=false`: the station refuses to start with
   either on public (free energy, or real payments for a simulated relay and
   phone). `CHARGE_VERIFY=false` and `PAYMENT_MODE=custody` are refused too:
   public is direct mode only.
6. Cursor: nothing to do. The cursor file is named per network and account,
   so the new pair starts at the last payment made before the station
   started and never replays history.
7. Registry: list the station (same `STATION_ID`, the mainnet host key, asset
   and price) in `registry/stations.public.json`, sign it and verify it with
   the pinned public registry key (section 5). The app warns loudly before
   paying a station it cannot find there, or whose host key differs. Set
   `REGISTRY_KEY` to that key: none is pinned for public yet, and the station
   refuses to start without it (once one is pinned, any other is refused).
   On public the station also refuses to start without `STATION_ID`, with
   `REGISTRY_CHECK=false`, and unless the startup check says `registry ok`:
   with no copy of the registry readable (offline and no
   `registry/stations.public.json`) it does not start, where testnet starts
   unchecked.
8. Keys: the testnet demo's host key (`GCJC2PFI…3XTN6`, in the `.env`
   examples) and the testnet registry key are refused on public, as either
   `HOST_PUBLIC_KEY` or `REGISTRY_KEY`: the same key is a valid mainnet
   account, and real payments would go to the demo's.
9. The footer badge must read **MAINNET**.

On public, the screen also shows out of service, with no pay QR, until
Horizon first answers and whenever it has not answered for 10 s (or for
three polls, with a `HORIZON_POLL_SECONDS` above 3.3): a real payment made
then would not be seen until it does. A payment made just before is credited
when Horizon answers again. On testnet a failing Horizon only shows in the
footer.

## 5. How money flows

- **The recipient is the host.** Payments go straight from the user's wallet
  to `HOST_PUBLIC_KEY`, the venue owner's account.
- **The operator never holds user money.** The station knows only the host's
  public key. It never holds a secret key, never signs, never debits anyone.
- **Prepaid.** The user pushes a payment; `floor(amount / FICHA_PRICE)` becomes
  fichas for that session. The QR asks for 1 ficha; paying 2×, 3×… the price
  buys more. Billing is by time; watt-hours are measured and shown, never
  billed.
- **Time counts only while this station charges the phone.** Paid time is
  consumed only while the station has verified that the phone is charging
  from it (section 6): not before the phone is plugged in, not while it
  charges from another socket, not while paused. What was not consumed is
  logged for a manual refund.
- **Fichas die with the session.** They do not transfer, redeem or carry over.
- **Refunds are manual, from the log** (direct mode; custody mode refunds by
  the receipt's proof, section 7). Every paid session ends with a delivery
  verdict and the payer's address in `sessions.jsonl`:
  - `delivered`: the meter saw at least `MIN_CURRENT_MA` while this station
    was verified to be charging the phone
  - `no_current`: meter healthy, but no current verified as this station's
    (never plugged in here, or charging from another socket)
  - `unverified`: meter unavailable the whole session

  Payments that were not credited (no valid memo, memo of a closed session,
  below 1 ficha) are logged as `orphan` or `underpaid` with payer, hash and
  amount. A payment with the current memo while the relay is not answering
  (screen: out of service) is not credited either: it is logged as `refused`,
  reason `station out of service`. A payment in another asset than the
  station's (USDC at an XLM station, or USDC from another issuer) whose memo
  is this station's is logged as `refused`, reason `wrong asset`, with the
  code and issuer actually paid. The host refunds these in full.

  Money that was credited but bought no energy is spelled out in each
  session record:
  - `change_due`: paid beyond whole fichas (3.7 at a price of 1 buys 3
    fichas; 0.7 is change). Each `credited` line carries its own.
  - `capped_seconds`: paid time beyond `MAX_SESSION_MINUTES`.
  - `consumed_seconds`: paid time the countdown consumed, that is the time
    the station was verified to be charging the phone.
  - `unused_seconds`: `paid - capped - consumed`: time left when E, ESC (or
    a shutdown) stopped the session, all of it when the phone never charged
    here (`end_reason` `not_plugged`), the rest after a pause too long
    (`paused_too_long`).
  - `verify_mode` (`probe`, `outlet` or `off`), `verified`, `verified_at`,
    `paused_seconds` (verified, countdown standing still: pauses, probes and
    the phone charging again after them) and `probes`
    (`{"passed": n, "failed": n}`) say how the time was checked.
  - `refund_hint`: change, capped and unused as amounts in the asset, 7
    decimals, the seconds converted at the station's price:
    `{"change": "0.7000000", "capped": "1.0000000", "unused": "0.0000000", "asset": "XLM"}`.
    It is a hint for the host, who decides and pays the refund by hand; an
    `interrupted` session has only `change` (the rest is unknown).
- **Receipt.** When a paid session ends, the FINISHED screen shows a receipt
  QR for `FINISHED_SECONDS` (20 s) instead of the pay QR: memo, network,
  host key, amount, fichas, paid seconds, seconds charged here (`u`, the
  record's `consumed_seconds`), measured Wh, peak current, verdict, cut
  confirmation and time (`<APP_URL>/r?v=1&m=…`, see
  `docs/station-app-contract.md`). It is unsigned, since the station holds no
  key: the Ficha app treats it as the station's statement and checks it
  against the user's own payment on the ledger.
- **Several stations, one host.** With `STATION_ID` set, memos read
  `<STATION_ID>.<SESSION>`. A station ignores a payment whose memo names
  another station (that station logs it) and never logs it as an orphan.
- **Nothing is lost if the station dies.** Each payment is written as a
  `credited` line the moment it is credited, before the relay closes. If the
  station is killed or loses power mid-session, the next start closes that
  session as `interrupted`, with its payers and `verify_mode`, and verdict
  `delivered` if current had already been seen, `unverified` otherwise (its
  peak current is unknown: `max_current_ma` is null, and `first_delivering_ma`
  is the reading that made it `delivered`). If `sessions.jsonl`
  cannot be written when a session closes (disk full, say), the record waits
  in memory, is retried every second and the footer shows **log error**.
  While the log cannot be written the screen shows out of service and hides
  the pay QR: a payment that still arrives is neither credited nor logged,
  and Horizon hands it over again until it can be.
  The first run on a network and host key starts at the last payment made
  before the station started, so a payment made while Horizon was still
  unreachable is not skipped. A cursor file that cannot be saved stays in
  memory and shows as a Horizon error.
- **A payment counts once.** Horizon may hand the same payment over again
  (a restart, a cursor that could not be saved). The station remembers every
  payment it has credited or logged, from the log itself, and ignores repeats.

### The station registry

The Ficha app learns which stations exist, and which host key each one pays,
from a public signed registry: `registry/stations.json` (testnet) and its
signature `registry/stations.json.sig`. The app pins the registry public key
(`docs/station-app-contract.md`) and warns loudly before paying a memo whose
station is missing or whose host key does not match. The registry SECRET key
never lives in the repo, on a station, or in the app.

```bash
python tools/registry.py new-key        # once: prints a keypair; store the secret offline
python tools/registry.py new-id         # a random station ID not used yet
# edit registry/stations.json (and issued_at), then:
python tools/registry.py sign --key-file /path/offline/registry.secret   # or REGISTRY_SECRET=S...
python tools/registry.py verify --key G...the-pinned-registry-key
```

`sign` checks the file first (IDs, host keys, asset, price, minutes) and
signs its exact bytes, so sign after the last edit. `registry/` is marked
`-text` in `.gitattributes`: git must not rewrite its line endings.

**Each station checks itself against it.** With `STATION_ID` set, the station
reads the registry at startup: first the copy published with the site
(`REGISTRY_URL`, default
`https://ficha-stellar.vercel.app/registry/stations.json`, 3 s timeout), then the copy in the repo (`REGISTRY_FILE`, default
`registry/stations.json`), and verifies its signature with the pinned public
key (`REGISTRY_KEY`, default the testnet key; the station holds no secret).
Its entry must be active and match `.env`: network, `HOST_PUBLIC_KEY`, asset,
`FICHA_PRICE` (as a number: `1.0` matches `"1"`), `FICHA_MINUTES`,
`MAX_SESSION_MINUTES` and the payment mode (`PAYMENT_MODE`, and the custody
terms, section 7). Otherwise the station does not start and lists every
difference, station value against registry value:

```
Configuration error: STATION_ID=ERZGCG does not match its entry in the signed station registry (registry/stations.json). The app shows and charges what the registry says:
  - FICHA_MINUTES=1 here, ficha_minutes 5 in the registry
Change .env to the registry's values. If the registry is what is wrong, edit registry/stations.json, re-sign it (python tools/registry.py sign) and publish it with the site. REGISTRY_CHECK=false skips this check (development only).
```

A copy whose signature does not verify also stops the start; a page that is
not the registry at all (a WiFi login page) only makes it try the local copy.
With no copy readable a testnet station starts anyway, since it must work
offline, and says so in the log and on the footer (**registry unchecked**); a
station on the public network does not start (section 4). The footer
shows `registry ok · site` or `ok · local copy` when the check passed, and
`off` without `STATION_ID` or with `REGISTRY_CHECK=false`. A custody station,
and any station on public, also reads it again every minute while it runs
(a direct one on testnet does not), and goes out of service
(`registry mismatch` in red, no pay QR) when its entry no longer matches
(section 7).

**Publishing it.** The Ficha site <https://ficha-stellar.vercel.app/> is the
Vercel project `ficha`, deployed on each push from the private site
repository, which holds only the built site. After
signing, from `app/`: `npm run build:site`, then
`node scripts/publish-site.mjs <checkout of the site repository>`, and commit
and push there. `/registry/` is served with `Cache-Control: no-cache`, so
stations and apps see the new signature at once. Details in
`app/README.md` and `docs/station-app-contract.md` (section 6).

## 6. Time counts only while this station charges the phone

The meter reads the phone's own battery current over ADB. That reading
cannot tell this station's outlet from any other charger: a user who paid and
went home would see the countdown run while charging from their own socket.
So paid time is consumed only while the station has **verified** that the
current is its own (`CHARGE_VERIFY=true`, the default).

**The probe.** The only proof that the current comes from this station is
that it stops when the relay opens. A probe opens the relay for
`PROBE_SECONDS` (3), reads the meter and closes it again. It passes when the
current falls clearly (mains): every reading with the relay open, but the
first (it may predate the opening), is below `MIN_CURRENT_MA` and at least
`MIN_CURRENT_MA` under the reading that started the probe. On usb_vbus it
passes when the phone vanishes (ADB rides the cut cable). It fails when the
current keeps flowing: the phone is charging from somewhere else. A probe's
seconds are never consumed, nor are those the phone takes to charge again
after it (the charger restarting; on usb_vbus, the phone reappearing).

**A paid session**, inside CHARGING:

1. **Waiting.** The relay closes on payment as always, but the countdown does
   not start. The screen says "Plug your phone into this station". When the
   meter shows at least `MIN_CURRENT_MA`, a probe runs ("Checking the
   charge…"); a failed one says "This phone is charging from another
   source" and is retried every 30 s; current back before then (the phone
   moved here) shows "Current detected: checking in N s". Not verified within
   `PLUG_TIMEOUT_SECONDS` (180): the relay opens and the session ends as
   `not_plugged`, with all of its paid time in `refund_hint.unused`. Current
   flowing when that time is up (the phone moved here after the last probe,
   the next one due later) gets one last probe first, which decides; the
   screen counts down to it.
2. **Counting.** From the first charging reading after the passing probe
   (`verified_at` is the probe). On mains, if the current comes back only
   after 3 or more readings below `MIN_CURRENT_MA` (the phone may have been
   unplugged during the probe and moved to another charger, where it stays
   readable), one more probe checks it before anything counts. That probe's
   own wait is not checked again: a phone slow to charge again after a probe
   costs one extra probe each time, not a loop. A probe again every `PROBE_EVERY_SECONDS` (300), and when
   the current comes back after a dip of at least 3 readings
   below `MIN_CURRENT_MA` (the phone may have been moved to another charger),
   at most every 30 s.
3. **Paused.** No current (below `MIN_CURRENT_MA`, or the phone unreadable)
   for more than `PAUSE_GRACE_SECONDS` (20) pauses the countdown, from when
   the current went away: the grace seconds are given back. A failed probe
   pauses it too ("this phone is not charging from this station"), and so
   does a passing probe the current does not come back after within
   `PAUSE_GRACE_SECONDS`, from the probe's end. The screen shows why, with
   the countdown frozen, and counts down to the next probe once current is
   back. A passing probe, once current is back (at most one
   every 30 s), resumes it. `PAUSE_TIMEOUT_SECONDS` (600) standing still,
   whatever probes passed in between, ends the session as `paused_too_long`,
   with the time left in `refund_hint.unused`; current flowing then gets one
   last probe first, as in 1.

The relay stays closed while waiting and paused (only a probe opens it, for
`PROBE_SECONDS`): the phone could not be seen coming back otherwise. ESC, a
shutdown and a crash open it as before. `MAX_SESSION_MINUTES` caps consumed
time, not time on the wall. Courtesy is free and never probes. Peak current,
energy and the `delivered` verdict count only readings taken while verified.

Limits: a phone moved to another charger with no dip the meter could see is
caught by the next periodic probe, so up to `PROBE_EVERY_SECONDS` may count.
So is one moved during that extra probe, or within `PAUSE_GRACE_SECONDS`
after it.
A phone that draws less than `MIN_CURRENT_MA` here (full, or using more than
it gets) is not charged for: its time is logged for refund.

`METER_SOURCE=outlet` is for a future meter on the station's own output: the
current it sees is the station's by construction, so there are no probes,
only the same waiting and pauses (today only `MOCK=true` simulates one).
`CHARGE_VERIFY=false` restores the old behaviour, a countdown from the
payment whatever the phone does, for bench tests; the public network refuses
it. The settings and their limits are in `.env.example`.

## 7. Custody mode (testnet)

In custody mode the payer deposits into the FichaEscrow contract instead of
paying the host, and the time not charged here comes back to the payer with
one tap on the receipt, before a deadline: the receipt carries a proof that
only the payer can use. A session nobody claims goes to the host in full
after it, as a direct payment does. The station still holds no Stellar key and no account, signs nothing
and pays no fee: it only reads the contract through a Soroban RPC. The
contract, its build and its upkeep are in `contracts/escrow/README.md`; the
rules both sides follow, in `docs/station-app-contract.md`, section 7.
Direct mode stays the default, and the only mode on the public network.

The contract pays the payer's refund first, whatever the host does with its
account: a claim never touches the host's account and keeps the host's
share for it, owed to that host alone, until anyone sends `pay_host` (the
host collects every claim's share in a token with one call: the Collect
button under "Held for you in the contract" in the Ficha app's host mode,
or the CLI in `contracts/escrow/README.md`, "Collect what the host is
owed"). A release
pays the host at once. A session there is its ID and its anchor, so paying
a QR's ID with another chain takes nothing from the station; and the payer
signs the terms it pays under, so terms changed after the app's check fail
the deposit.

| setting | what |
|---|---|
| `PAYMENT_MODE` | `direct` (empty) or `custody`. Custody needs `STATION_ID`, `HOST_PUBLIC_KEY`, `CHARGE_VERIFY=true`, `STELLAR_NETWORK=testnet` and native XLM (empty `PAYMENT_ASSET_CODE`: an issued asset's issuer could freeze a payer or claw back the escrow's balance) |
| `ESCROW_CONTRACT` | the contract ID, `C…`. Testnet: `CBRNN2W726PIWP7DLLCAOW663I2TBSMR6N7J7S4CGGUIWIXK4HYI6KYC` |
| `RPC_URL` | the Soroban RPC, read only. Empty = `https://soroban-testnet.stellar.org` |
| `REFUND_UNIT_SECONDS` | the refund unit (30): divides `FICHA_MINUTES × 60`, at most 256 units in a session |
| `ESCROW_GRACE_SECONDS` | from the end of the paid time to the deadline (1680 = 180 to plug in + 600 of pause + 900 to claim); at least 900 + `PLUG_TIMEOUT_SECONDS` |
| `FINISHED_SECONDS` | 60 by default in custody mode |

The station's terms on the contract (asset, price, ficha length, session
cap, unit, grace) are set by the host with `register`, signed with the
host's key on the host's own device, never on the station. At startup the
station checks its signed registry entry (`mode`, `escrow`, `unit_seconds`,
`grace_seconds`, as in section 5) and then its terms on the contract, read
with no key; a difference refuses the start and lists each one. An RPC it
cannot reach starts it with **escrow unchecked** in the footer, next to the
escrow events' health.

**While it runs** the station reads both again every minute, and the
contract at once after a deposit under terms that are not its own. If the
registry now names another `escrow`, other terms or the station as
inactive, or the host registered other terms on the contract, the station
goes **out of service**: the pay QR is hidden, the footer's registry or
escrow item turns red with the difference, and the log says what to
change. It comes back only when a read matches again, in practice once
`.env` is updated and the station restarted. A read that cannot reach the
site or the RPC changes nothing, and one that matches turns **escrow
unchecked** into ok.

So, to move a running station to another contract (a redeploy, the testnet
reset) or to other terms: **stop the station, publish the re-signed
registry, update `.env`, start it.** The app pays the contract the newest
registry names: published with the station still running on the old one,
the app would pay where the station never looks, for up to a minute before
it goes out of service.

What the station does differently:

- **The pay QR** is a link the Ficha app opens,
  `https://…/p?v=1&n=t&h=<host>&s=<STATION_ID>&x=<session>&a=<anchor>`; the
  payer picks the fichas in the app. Each session draws a random seed whose
  hash chain ends in the anchor; it is written to `sessions.jsonl` (a `seed`
  line) before its QR shows. It signs nothing and can only refund that
  session's payer.
- **Deposits** come from the contract's events (`getEvents`; cursor
  `.escrow_cursor.<network>.<STATION_ID>.<digest>` in `CURSOR_DIR`).
  Credited as today, with `source` `escrow`, the payer and the transaction.
  A deposit under the session's ID with another anchor (someone else's
  chain) is another session on the contract: logged `refused`
  (`anchor mismatch`), and the session on screen, its QR and its payer carry
  on. Out of service, an amount that is not fichas × price, or terms on the
  contract that are not this station's: logged `refused`, and the receipt
  carries the seed itself as the proof (`q` = N). That refunds all of it
  whenever the session's paid units are at most this station's N, which its
  own terms ensure; a deposit under larger terms (more fichas, a longer
  ficha or a shorter unit than the station's) gets N of its paid units back
  by proof, and the rest only by `host_refund` from the log. Terms that are
  not the station's also put it out of service at once (above). A classic
  payment with this station's memo buys nothing here: logged `refused` for a
  refund by hand.
- **Ledger time, not the station's clock.** Each `getEvents` read also
  gives the latest ledger's close time; every deadline decision (a
  session's end, a receipt's expiry) is in that time. A station clock more
  than 60 s off only shows as a warning on the footer's escrow item. Until
  the first read, and after 30 s without one, the station is out of service
  (no pay QR): a deposit made then would not be seen in time.
- **A session ends**, at the latest, 15 minutes before its deadline on the
  contract (`end_reason` `deadline`), so the payer can always claim.
- **The receipt** is `v=2`: the unused units (`q`, rounded up in the payer's
  favour, from the consumed seconds rounded down) and the proof (`z`).
  FINISHED shows it for 60 s; then it waits until the payer claims it (a
  `settled` line, with both shares) or its deadline passes, and a smaller
  copy stays on the waiting screen, labelled "Previous customer" (or "Not
  served" for a full refund). That copy is a `ficha:/r?…` link: a phone
  camera pointed at the pay QR beside it does not open it, the Ficha app's
  **Scan QR** does. When a served customer's receipt and an unserved full
  refund both wait, the screen shows them in turn every 8 s ("1/2", "2/2");
  a receipt that gives nothing back is never shown, nor does it push
  another off. The session record's `refund_hint` is
  `{"automatic": true, "unused_units": …, "to_payer": …}`.
- **While charging** the consumed time goes to the log every 30 s
  (`consumed` lines): a session cut short by a crash is closed at restart
  from the last one, in the payer's favour, and its receipt comes back on the
  waiting screen. A deposit made with a QR the station showed but never
  served (it restarted meanwhile) is refunded in full the same way; that
  full-refund receipt is logged (`unserved`), so a restart shows it again.
  A session the payer or the host already settled (a claim on the
  FINISHED screen, a `host_refund` while charging) never shows its receipt
  again, and a later deposit under its ID and anchor (its old pay link,
  then or any time later) is logged `refused` or `orphan` (`session already
  settled`) with a full refund. At a restart the receipts come back in the
  order they were made; whether a deadline has passed waits for the first
  read of the ledger, whatever the station's clock says.
- **Nobody claims by the deadline:** the host, or anyone, sends `release`,
  and everything goes to the host. The station never sends anything. The
  Ficha app's host mode (testnet, on the host's own phone) lists the
  sessions past their deadline by the ledger's clock and releases one or
  all, refunds a session with `host_refund`, and collects what claims kept
  for the host.

The two testnet demo stations in the signed registry are custody stations
on the contract above, under the same demo host: `ERZGCG`, the bench (5-minute
fichas, 30 s refund unit), and `YX3DGE`, the HackMeridian demo in Lisbon
(1 XLM per 1-minute ficha, up to 10, 15 s refund unit). Ready-made settings
for `YX3DGE`, with no secret in them (copy one to `.env`):

| file | hardware |
|---|---|
| `.env.lisbon.example` | none: simulated relay and phone, REAL testnet deposits from the Ficha app. Rehearsals, and the fallback at the table |
| `.env.mains.example` | the relay, a wall charger and the cut cable, the phone read over WiFi ADB (fill `ADB_SERIAL`) |
| `.env.usbvbus.example` | the relay, the phone on the laptop's USB through the cut cable: when the venue WiFi keeps laptop and phone apart |

`docs/testnet-e2e.md` records runs on testnet, every transaction linked: on
this contract (runs H to N: the demo's flow at `YX3DGE`, deposit, top-up,
charge, E, receipt, claim and `pay_host`; ESC at `ERZGCG`; the deadline in
ledger time, then a release; the latest, M and N, on 23 October 2026, after
the testnet RPC moved to Stellar RPC 30), on the two retired deployments,
and how to repeat them with the app's opt-in test.

Try it with simulated deposits too: in `.env`, `PAYMENT_MODE=custody`,
`STATION_ID=ERZGCG`,
`HOST_PUBLIC_KEY=GCJC2PFILBFQCYFBIDEQG3RZFNOA2ID7ULAEZJUZ5ULZX6BM3ME3XTN6`,
`ESCROW_CONTRACT` as above, `REFUND_UNIT_SECONDS=30`, `MOCK_PAYMENT=true`
and `APP_URL=https://ficha-stellar.vercel.app`. It still reads the testnet
contract, read only; the deposits are simulated:

```bash
curl -X POST localhost:8000/debug/pay -H "content-type: application/json" -d "{\"fichas\": 2}"
curl -X POST localhost:8000/debug/pay -H "content-type: application/json" -d "{\"fichas\": 1, \"anchor\": \"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}"
curl -X POST localhost:8000/debug/settle -H "content-type: application/json" -d "{}"
```

`/debug/settle` settles the receipt on screen (add `"memo": "<STATION_ID>.<SESSION>"`
for another one waiting). With `MOCK=true`, **U** unplugs the simulated
phone and plugs it back in.

The first is the app's deposit, the second one made with a chain of
someone else's (refused, and the session carries on), the third the payer
claiming the receipt on screen (`{"how": "deadline"}` is a release).
