# Free emergency minutes and the Wi-Fi portal (station side)

Ficha stations also go where people may need to call or message for help:
places with high rates of violence or kidnapping, remote places, or anywhere
a phone with a dead battery or no data plan leaves someone cut off. There,
once a day, **every phone gets 2 minutes of charging and 2 minutes of
internet, free**, through the station's own Wi-Fi, and the local emergency
numbers are on the station screen and first on the Wi-Fi's page. **Paying
with Ficha always works on that Wi-Fi** without spending the free minutes.
No money moves for a free minute: it is a courtesy, like the C key's.

This page is the station's side. The router's side (OpenWrt with openNDS,
the walled garden, the per-MAC quota) is in [`openwrt/`](../openwrt/).

## How it fits together

```
 phone ──joins──> station Wi-Fi (GL.iNet router, OpenWrt + openNDS)
   │                 │  walled garden, open before any sign-in: the Ficha site
   │                 │  and the Stellar endpoints the app uses (port 443)
   │                 │
   │    openNDS sends every new phone to the station's portal (FAS level 0):
   └──> http://<station>:PORT/portal?authaction=http://<gw>:2050/opennds_auth/?clientip=..&gatewayname=..&tok=..&redir=..
             │
             ├─ "2 min free charge"   -> the STATION closes its own relay (the courtesy's path)
             ├─ "2 min free internet" -> the station sends the browser to
             │                           http://<gw>:2050/opennds_auth/?tok=..&redir=..
             │                           and the ROUTER opens the internet; its binauth
             │                           script holds the per-MAC daily quota
             └─ "Pay with Ficha"      -> the pay link of the session on the station screen
```

Who enforces what:

| | enforced by | how |
|---|---|---|
| free charge, once per phone per day | the station | its relay, as a courtesy of `FREE_CHARGE_SECONDS`; the day's ledger (`freeminutes.py`) |
| free internet, once per phone per day | the router | openNDS + `binauth.sh` (per MAC, per local day). The station only records the grant and redirects: a phone that calls the auth URL itself still gets no more through the sign-in. A courtesy limit, not a hard one: the walled garden opens addresses shared with other sites ([openwrt/README.md](../openwrt/README.md#the-2-minutes-are-a-courtesy-not-a-hard-limit)) |
| payments | the walled garden | the Ficha site and Stellar are reachable before any sign-in |

The station holds **no secret**: no Stellar key, no router password, no FAS
key (level 0 needs none). The product rules are unchanged: prepaid, money
only to the host or back to the payer, paid time counts only while charging
is verified.

## Settings (`.env`)

| setting | default | |
|---|---|---|
| `WIFI_PORTAL` | `off` | `off`: no portal, no free minutes, the station exactly as before. `opennds`: the router sends phones to `/portal`. `simulate`: no router, a demo on this computer |
| `FREE_CHARGE_SECONDS` | `0` | seconds of free charge per phone per day (0 to 3600; 120 in the demo files) |
| `FREE_INTERNET_SECONDS` | `0` | seconds of free internet per phone per day (0 to 3600). Shown and recorded by the station; the router's `FREE_INTERNET_SECONDS` (openwrt/) is what is enforced: keep both the same |
| `FREE_RESET` | `midnight` | when the allowance starts over: local midnight, the only choice (below) |
| `EMERGENCY_NUMBERS` | empty | `label number` pairs separated by `;`, at most 6, e.g. `'Emergency 112'` (Portugal, the EU) or `'Polícia 190; SAMU 192; Bombeiros 193'` (Brazil). Required with a portal |

The station refuses to start on: free minutes with `WIFI_PORTAL=off` (a phone
is known only through the portal), a portal without `EMERGENCY_NUMBERS`,
`opennds` on a loopback `HOST` or without `WIFI_SSID`, `opennds` with
`MOCK_PAYMENT=true` (the existing rule: no fake payments from the network),
an entry that does not end in a number, and seconds out of range.

The demo files (`.env.example`, `.env.lisbon.example`, `.env.mains.example`,
`.env.usbvbus.example`) turn it on with `WIFI_PORTAL=simulate`, 120 + 120
seconds and `EMERGENCY_NUMBERS='Emergency 112'`; the router settings are
there, commented.

## The portal

- `GET /portal`: the page. openNDS's FAS level 0 query is as its source
  builds it: `authaction=http://<gw>:<port>/<authdir>/?clientip=<ip>` (the
  client's IP lands inside authaction's value), then `gatewayname`, `tok`
  and `redir`. The page is English or Portuguese (the phone's language,
  `?lang=pt` or `?lang=en`), mobile first, with no script and nothing from
  another host: it opens in the sign-in window phones open by themselves,
  with no internet at all. Order: the emergency numbers (one-tap `tel:`
  links), the two free buttons with what is left today, the pay link, a
  short safety note.
- `POST /portal/charge`: this phone's free charge, if it has not had one
  today, no paid session or other courtesy is running and the relay
  answers. Otherwise the page says why. It runs on the session on screen,
  so its ID and pay QR stay and a payment to them is credited.
- `POST /portal/internet`: this phone's free internet, if it has not had it
  today. `opennds`: the grant is recorded, then `303` to
  `authaction?tok=<tok>&redir=<redir>` (only an `http://` private IPv4
  gateway with one path segment: the station is no open redirect).
  `simulate`: recorded, and the page says "Internet granted (simulated)".
- The pay link is the one the station screen shows, whenever it shows one:
  "Pay with Ficha" while waiting or during a free charge, "Add time to the
  session now charging" during a paid session. In direct mode with
  `APP_URL` set, it is the web app's `APP_URL/pay?uri=<the SEP-7 link>`,
  which any browser opens (a `web+stellar:` link opens nothing in a sign-in
  window). A payment during a free charge carries over into the paid
  session, exactly as from a courtesy.
- Both forms are refused when posted by another site (a browser sends that
  site's Origin) or when not a form; each POST answers with a redirect back
  to the page, so a reload never asks twice.

On the station screen: a band over the notice with the emergency numbers and
what the Wi-Fi gives each phone a day; during a free charge the state reads
"free charge" and the countdown "free charge left". Without these settings
the screen is unchanged.

## How a phone is recognised, and what is kept

openNDS's FAS level 0 does **not** send the phone's MAC address (its query is
`clientip`, `gatewayname`, `tok`, `redir`, plus `authaction`). The station is
on the router's LAN, so each phone reaches the portal directly: the station
reads the phone's MAC from its own neighbour (ARP) table for the address the
request came from (Linux `/proc/net/arp`; Windows and macOS `arp`). A request
whose address is not the `clientip` openNDS reported (the station behind a
NAT, which would see the router's MAC for every phone) is refused, and so is
an address with no neighbour entry. `simulate` also takes a test MAC
(`clientmac=`), from this computer only.

The MAC is never stored:

- The station keeps `HMAC-SHA256(salt, MAC)` (the first 16 hex digits), where
  the salt is 32 random bytes made for the day. Salt and ledger are one file,
  `CURSOR_DIR/.free_minutes.<YYYY-MM-DD>.json`, written whole before a grant
  is given (a restart never gives it twice).
- At local midnight a new salt replaces it and every other day's file is
  deleted: a running station checks every minute, with or without a phone
  on the portal; one that was off at midnight deletes them when it starts.
  Two days' ids cannot be linked to each other, and once its day is over an
  id cannot be traced back to a MAC.
- The session log gets one line per grant, `{"kind": "free_grant", "device":
  "<id of the day>", "what": "charge" | "internet", "seconds": 120, "at": ...}`
  (`"simulated": true` in a demo): no MAC, no IP, no name. A session that had
  a free charge says `"free_charge": true` (`end_reason` `free_charge_only`
  when nobody paid).

**Why midnight and not a rolling 24 hours:** a rolling window would have to
recognise a phone across two daily salts, which is exactly the linking the
daily salt exists to prevent. The router's quota resets at its own local
midnight too.

Honest limits:

- While the day lasts, whoever can read the station's disk could test
  candidate MACs against that day's salt (MAC addresses are few enough to try
  them all). That is why the salt lives no longer than its day.
- A phone that changes its Wi-Fi MAC (private or rotating addresses) counts as
  a new phone. A free minute is a courtesy worth two minutes of power or
  internet; the paid flow does not depend on it.
- The free charge powers whatever is plugged into the station, like the
  courtesy: it is for the person standing there.
- The router's 2 minutes of internet hold for a phone that taps the button,
  not for a determined user: the walled garden's addresses serve other
  sites too, and DNS is open before sign-in
  ([openwrt/README.md](../openwrt/README.md#the-2-minutes-are-a-courtesy-not-a-hard-limit)).
  The gap costs free internet, never money.

## Network and security

- `WIFI_PORTAL=opennds` needs the station on the router's LAN (Ethernet is
  best), at a fixed address, with `HOST=0.0.0.0` (or that address) and the
  router's `fasremoteip`/`fasport`/`faspath` pointing at it
  (`openwrt/setup.sh` does that). On Windows, allow Python on the private
  network when the firewall asks, or open TCP `PORT`.
- With `WIFI_PORTAL=opennds`, only a phone on the router's LAN gets free
  minutes: the request must carry the router's sign-in (`authaction`), and
  the phone and the station's address the request came in on must share
  that gateway's /24. Otherwise the page says so (`no_gateway`, `not_lan`)
  and nothing is used. Keep the station on the router's network only: a
  gateway written into the URL by hand from another private network would
  still pass.
- With any portal on, the station screen (`/`), its socket (`/ws`: ESC, C,
  E) and `/debug` answer **only to this computer** (loopback): every phone on
  the Wi-Fi can reach the station, and none may press its keys. A phone that
  opens the station's address gets the portal. A separate screen on the LAN
  is not possible with the portal on. With `WIFI_PORTAL=off` nothing of this
  changes.
- The Host header rule stays (an IP address, `localhost` or `HOST`): no DNS
  rebinding.

## Try it

Simulated, on this computer (the demo files already have it on):

```bash
python main.py
# station screen: http://127.0.0.1:8000   portal: http://127.0.0.1:8000/portal
```

Tap "2 min free charge" on the portal: the screen shows "free charge" with
2:00 counting down and the relay closes. Pay with `/debug/pay` (or the app)
and it carries over into the paid session. "2 min free internet" says
"Internet granted (simulated)". `?clientmac=02:11:22:33:44:55` plays another
phone. With the router: the commented lines in the `.env` example and
`openwrt/`.

`python smoke_test.py` covers it all: off by default (the station as before),
the refusals, the salt's rotation, no MAC on disk, once per phone per day, the
paid session first, the carry-over, openNDS's redirect, the portal with no
network.
