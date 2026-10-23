# The station's Wi-Fi router: free emergency minutes (OpenWrt + openNDS)

The router side of [docs/free-minutes.md](../docs/free-minutes.md). A GL.iNet
travel router (OpenWrt) runs **openNDS**, a captive portal:

- every phone that joins is sent to the **station's portal**
  (`http://<station>:8000/portal`, openNDS "FAS" on the station laptop);
- every phone reaches the **payment hosts** at once (the walled garden), so
  paying with Ficha never spends the free minutes;
- a phone that taps "2 min free internet" gets **2 minutes a day** through
  the router's sign-in, decided **here, on the router**, by `binauth.sh`: a
  phone that calls the router's auth URL itself gets no more. That is a
  **courtesy limit, not a hard one**: the walled garden lets a determined
  user out without signing in at all (see
  [The 2 minutes are a courtesy](#the-2-minutes-are-a-courtesy-not-a-hard-limit)).

The free charge is the station's (its relay); see the station doc. No money
moves for a free minute. The station holds no secret of the router's (no
router password, no FAS key: level 0 has none), and these files hold none.

| file | what |
|---|---|
| `setup.sh` | configures the router (idempotent; `--check`, `--remove`) |
| `binauth.sh` | openNDS BinAuth: the per-device daily quota of free internet |
| `custombinauth.sh` | the same decision on openNDS 11+, where `option binauth` is ignored |
| `test-binauth.sh`, `test-setup.sh` | tests, run in WSL/Linux with busybox |

## Setup at the event (about 20 minutes)

You need: the GL.iNet router (firmware 4.x), an uplink for it (the venue's
Wi-Fi, an Ethernet WAN, or a phone's tethering), the station laptop with this
repository, and Git Bash on the laptop (for `ssh`/`scp`).

### 1. Router online, nothing in the way (5 min)

1. Power the router. Connect the laptop to it, by **Ethernet to a LAN port**
   (best) or to its Wi-Fi.
2. Open `http://192.168.8.1` (GL.iNet admin). First boot: set the admin
   password; it is also the SSH password for `root`. Keep it to yourself: the
   station never needs it.
3. **INTERNET**: connect the uplink (Repeater for the venue's Wi-Fi).
   **SYSTEM > Time Zone**: the local one (Europe/Lisbon): the daily allowance
   starts over at the router's local midnight.
4. Turn off what fights a captive portal: **VPN** (a VPN reconnect restarts
   the firewall and openNDS stops catching phones), any **Portal / Captive
   Portal** application, and **IPv6** (NETWORK > IPv6: openNDS filters IPv4).

Verify: the admin panel shows Internet connected; `ping 1.1.1.1` from the
laptop works.

### 2. The station laptop's MAC (2 min)

Windows, with the laptop connected to the router: `ipconfig /all`, the adapter
connected to it, **Physical Address**, e.g. `A4-5E-60-D1-22-01` (the GL.iNet
admin's CLIENTS page lists it too). On Wi-Fi, if "Random hardware addresses"
is on for that network, the address shown while connected is the one that
counts; better, turn it off for this network.

### 3. Copy the files and run setup.sh (5 to 10 min)

From the repository on the laptop (Git Bash):

```bash
scp -O openwrt/setup.sh openwrt/binauth.sh openwrt/custombinauth.sh root@192.168.8.1:/tmp/
ssh root@192.168.8.1
```

(`-O` is the classic scp protocol, for routers without an SFTP server; an
older scp that says "unknown option" does not need it.) Then, on the router:

```sh
cd /tmp && sed -i 's/\r$//' setup.sh binauth.sh custombinauth.sh
STATION_MAC=a4:5e:60:d1:22:01 SSID='Ficha SOS' WIFI_OPEN=1 sh setup.sh
```

It saves the router's configs once (`/etc/ficha/backup`), installs openNDS and
`dnsmasq-full` if missing (the router must be online), installs `binauth.sh`,
writes `/etc/config/opennds`, reserves `STATION_IP` (192.168.8.20) for the
laptop's MAC, makes the laptop trusted (it never sees the portal: it needs
Horizon, Soroban RPC and the registry), adds the midnight cron job, renames the
Wi-Fi and opens it, restarts what changed and checks. Leave out `SSID` and
`WIFI_OPEN` to keep the router's Wi-Fi as it is (then the station's
`WIFI_SSID`, `WIFI_PASSWORD` and `WIFI_SECURITY` must match the router's). A
Wi-Fi change drops a Wi-Fi connection: join `Ficha SOS` again.

Verify: it ends with `ok   openNDS is running` and the summary. The portal
check warns until step 4 is done.

### 4. The station on its fixed address (3 min)

1. Renew the laptop's address (unplug and plug the cable, or
   `ipconfig /release` then `ipconfig /renew`): `ipconfig` shows
   `192.168.8.20`. Mark the network **Private** in Windows.
2. In the station's `.env` (the commented lines of the `.env` examples):
   `WIFI_PORTAL=opennds`, `HOST=0.0.0.0`, `PORT=8000`, `MOCK_PAYMENT=false`,
   `WIFI_SSID='Ficha SOS'`, `WIFI_SECURITY=nopass`, `FREE_CHARGE_SECONDS=120`,
   `FREE_INTERNET_SECONDS=120` (the same as the router's), and
   `EMERGENCY_NUMBERS` (`'Emergency 112'` in Portugal).
3. Start the station. When Windows asks, allow Python on **private**
   networks (or allow inbound TCP 8000).
4. Keep the laptop on the router's network only: its Wi-Fi off while it is
   on Ethernet, or every other network **Public** in Windows (the firewall
   then blocks the portal there). With `HOST=0.0.0.0` the station answers
   on every network the laptop is on. It gives free minutes only to a phone
   on the router's LAN (the request carries the router's sign-in, and the
   gateway, the phone and the station's address it reached share one /24),
   but someone on another Private network could write a gateway of that
   network into the portal's address by hand.

Verify, on the router: `sh /tmp/setup.sh --check` lists everything, and
`wget -O /dev/null http://192.168.8.20:8000/portal` gets an HTTP answer.

### 5. Test with a phone (5 min)

1. Join `Ficha SOS`. The sign-in window opens by itself with the Ficha portal
   (if not, open any `http://` address, e.g. `http://neverssl.com`).
2. **Pay with Ficha**: the app or site loads, shows the balance and pays,
   with no free minutes spent.
3. **2 min free internet**: any site opens. After 2 minutes (at most
   `CHECKINTERVAL`, 10 s, later) the internet stops and the portal is back.
4. Tap it again: refused for today. On the router:
   `logread -e ficha-freewifi` shows `free_grant` then `free_refused ... reason=used_today`.

Router checks at any time:

| check | command | expect |
|---|---|---|
| openNDS up, clients | `ndsctl status` | the client list, states |
| the walled garden (nftables) | `nft list set ip nds_filter walledgarden` | the payment hosts' IPs, once a phone looked them up |
| the walled garden (OpenWrt 21.02, iptables) | `ipset list walledgarden` | the same |
| the DNS that fills it | `nslookup ficha-stellar.vercel.app 192.168.8.1` | an answer |
| the free grants | `logread -e ficha-freewifi` | `free_grant what=internet id=<16 hex> seconds=120` |
| today's state | `ls /tmp/ficha-freewifi/` | `day-YYYY-MM-DD` only |
| settings | `sh /tmp/setup.sh --check` | |

## Roll back

- **Now** (everyone online, no portal): `/etc/init.d/opennds stop`. Back on:
  `/etc/init.d/opennds start`.
- **Undo setup.sh**: `sh /tmp/setup.sh --remove` (copy the files again if the
  router rebooted: `/tmp` is RAM). It stops and disables openNDS, restores
  `/etc/config/opennds` as it was before Ficha, deletes the reservation, the
  cron job and the Ficha files, and prints the command that restores the Wi-Fi
  settings (`cp /etc/ficha/backup/wireless /etc/config/wireless && wifi reload`).
  Packages stay installed.
- **Last resort**: GL.iNet admin, SYSTEM > Reset Firmware.

## setup.sh variables

Give them on the command line (`NAME=value sh setup.sh`); run it again after
a change: it changes only what differs and restarts only what it changed.

| variable | default | |
|---|---|---|
| `STATION_MAC` | (required) | the station laptop's MAC on this network |
| `STATION_IP` | `192.168.8.20` | its fixed address (outside the DHCP pool .100 to .249) |
| `PORT` | `8000` | the station's `PORT` |
| `FASPATH` | `/portal` | the portal's path on the station |
| `GATEWAYNAME` | `Ficha` | openNDS's name for this portal |
| `SSID` | (keep) | the LAN Wi-Fi name, both bands; the guest network is never touched |
| `WIFI_OPEN` | `0` | `1` = open Wi-Fi (station: `WIFI_SECURITY=nopass`); passwords are never set here |
| `FREE_INTERNET_SECONDS` | `120` | free internet per device per day; `0` = payments only |
| `CHECKINTERVAL` | `10` | how often openNDS ends sessions (s) |
| `DEBUGLEVEL` | `0` | openNDS syslog; from `1` it logs client MACs; `2` while debugging |
| `WALLED_GARDEN` | the hosts below | space-separated |
| `WALLED_GARDEN_PORTS` | `443` | never `80` (it breaks the phones' portal detection) |
| `LAN_DEVICE` | `br-lan` | the LAN bridge openNDS guards |

What it sets in `/etc/config/opennds` (section `setup`): `enabled 1`,
`gatewayinterface br-lan`, `gatewayname`, `fasremoteip`, `fasport`,
`faspath`, `fas_secure_enabled 0`, `login_option_enabled 0`,
`dhcp_default_url_enable 0`, `sessiontimeout` (minutes, the fallback),
`checkinterval`, `binauth`, `custombinauth`, `debuglevel`,
`walledgarden_fqdn_list`, `walledgarden_port_list` and `trustedmac` (the
laptop; other trusted MACs are kept).

## The walled garden: the hosts a phone needs to pay

Derived from the app (`app/src/config.ts` and every `fetch`/SDK server in
`app/src`) and from the live site's bundle (2026-10-23). Each is reachable on
port 443 before any sign-in:

| host | used for | where in the app |
|---|---|---|
| `ficha-stellar.vercel.app` | the web app itself (HTML, JS, CSS, the fonts, which are self-hosted, the service worker), the live signed registry and its `.sig`, the pay (`/p`) and receipt (`/r`) links, the Android app's link checks | `app/src/config.ts:73` `SITE_URL`, `:84` `liveRegistryUrl`; `app/src/registry/index.ts:70-71,106`; `app/src/native/deep-links.ts:4-5` |
| `horizon-testnet.stellar.org` | balances, account loading, direct payments, payment history | `app/src/config.ts:80` `horizonUrl`; `app/src/stellar/horizon.ts:15`; `app/src/pay/history.ts:64-66` |
| `soroban-testnet.stellar.org` | custody stations: the FichaEscrow deposit (simulate, send, status), contract reads, events | `app/src/config.ts:91` `rpcUrl`; `app/src/custody/escrow.ts:51` |
| `friendbot.stellar.org` | funding a new testnet wallet (onboarding) | `app/src/config.ts:81`; `app/src/stellar/horizon.ts:150` |
| `testanchor.stellar.org` | buying balance (SEP-1 `stellar.toml`, SEP-10 `/auth`, SEP-24 `/sep24` and its page, all on this host per its `stellar.toml`) | `app/src/config.ts:88` `anchorDomain`; `app/src/buy/anchor.ts:78,87-91` |

No font or script CDN: the fonts come from `@fontsource` inside the bundle
(`app/src/main.tsx:4-10`). Left out on purpose, not needed to pay:
`stellar.expert` (explorer links on receipts, `app/src/config.ts:144`),
`tile.openstreetmap.org` and `www.openstreetmap.org` (the stations map,
`app/src/components/StationsMap.tsx:26-27`), `horizon.stellar.org` (mainnet,
`app/src/config.ts:103`; the app and the station run testnet). Add one with
`WALLED_GARDEN="... stellar.expert" sh setup.sh`. The station laptop itself is
trusted and reaches everything it uses (`config.py`: Horizon, Soroban RPC, the
registry on the Ficha site).

Limits of a walled garden by name:

- dnsmasq adds the addresses a phone's lookups return, so the phone must use
  the router's DNS. Android's Private DNS in **strict** mode (a hostname set)
  cannot resolve before sign-in: the default "Automatic" works.
- The opening is by IP address: Vercel and Cloudflare (Soroban RPC, Friendbot,
  the test anchor) share addresses among many sites, so other HTTPS sites on
  the same addresses open too. Only port 443, only those addresses. What
  that means for the free minutes is the next section.
- A host's name matches its subdomains too (dnsmasq's rule).

## The 2 minutes are a courtesy, not a hard limit

The 2 minutes a day hold for a phone that taps the button. A determined user
gets more, and no setting here prevents it:

- **Shared addresses.** openNDS puts the walled garden's addresses in one
  set for the whole network (`walledgarden`), open on port 443 to every phone
  before any sign-in, until openNDS restarts. Once any phone has looked up a
  payment host, every phone can reach every site behind those addresses. On
  2026-10-23 Ficha's Vercel address answered for any other `*.vercel.app`
  name (Vercel routes by name, not by address), and `soroban-testnet`,
  `friendbot` and `testanchor` shared Cloudflare's `104.18.6.25` and
  `104.18.7.25` with many other sites. A web proxy deployed on Vercel is
  therefore free internet, for as long as one likes, with no sign-in:
  `binauth.sh` never runs.
- **DNS.** Every phone may query the router's DNS before signing in (the
  walled garden by name needs it), so DNS tunnelling works too.
- **New MAC addresses.** A phone that changes its Wi-Fi MAC is a new device
  (Privacy, below).

So never describe the 2 minutes as enforced against a determined user: they
are a courtesy that keeps an ordinary phone online long enough to send a
message or call for help, and the cost of the gap is someone's free internet,
never money (paying works the same either way). A hard cap would need the
pay app and every Stellar endpoint it uses on addresses of their own (or
behind a proxy on the station's LAN), which today's hosting does not give.

## How binauth.sh holds the 2 minutes

openNDS runs it as `binauth.sh <method> <mac> ...` (checked in the openNDS
sources 9.8.0, 10.3.1 and 11.0.0):

- `auth_client <mac> <redir> <useragent> <ip> <token> <custom>`: the
  decision, when a phone opens `http://192.168.8.1:2050/opennds_auth/?tok=...`.
  Allowed: it prints `120 0 0 0 0` (session seconds, then rates and quotas,
  0 = the config's) and exits 0. Refused: it prints **nothing** and exits 0.
  That form is on purpose: openNDS 9.8.0 and 10.3.1 (the OpenWrt packages)
  let the phone in when the script exits non-zero ("BinAuth script failed to
  execute") and refuse only when it prints no number; 11.0.0 refuses on both.
- `client_auth`, `ndsctl_auth`, `preemptive_auth` and every `*_deauth`:
  notices; it exits 0 and changes nothing (an operator's `ndsctl auth` is
  allowed and spends nothing).
- `rotate`: Ficha's own, from cron at 00:00: deletes every day but today.

Rules:

- **One window per device per day**: the whole 120 s is charged when given,
  not paused if the phone leaves. So the sign-in can never give more than
  `FREE_INTERNET_SECONDS` whatever the phone does with the auth URL (the
  walled garden is another way out: the section above). `sessiontimeout` is
  set to the same 2 minutes, so even an openNDS that ignored the script's
  seconds ends it.
- **The day is the router's local date** (midnight reset, like the station's;
  a rolling 24 h would need to link a phone across two daily salts). A reboot
  empties `/tmp` and starts over; an NTP jump of the clock to another date too.
- **Fail closed**: an unreadable count, a broken salt, no `sha256sum`, a
  malformed MAC, `FREE_INTERNET_SECONDS` not a number: refused. Payments
  still work (walled garden).

Privacy: the MAC is never written. The script keeps
`/tmp/ficha-freewifi/day-YYYY-MM-DD/salt` (256 random bits, mode 600) and one
file per device named `sha256(salt|mac)`, holding the seconds given. When the
day changes the whole directory goes, salt included, so hashes cannot be
linked across days or turned back into a MAC. The log line is
`free_grant what=internet id=<first 16 hex> seconds=120`: no MAC, no IP. The
router itself necessarily holds MACs in RAM while it serves a phone (ARP, DHCP
leases, openNDS's client list), and openNDS logs them from `DEBUGLEVEL=1`
(and on openNDS 11, whose own `binauth_log.sh` always runs, in
`/tmp/ndslog`). A phone that changes its Wi-Fi MAC (private or rotating
addresses) counts as a new device: a free minute is a courtesy.

## What the station receives (FAS level 0)

openNDS redirects a new phone to:

```
http://192.168.8.20:8000/portal?authaction=http://192.168.8.1:2050/opennds_auth/?clientip=192.168.8.123&gatewayname=Ficha&tok=5f2a8c1e&redir=http%3a%2f%2fconnectivitycheck.gstatic.com%2fgenerate_204
```

- Level 0 sends **no `clientmac`** (openNDS builds
  `?clientip=..&gatewayname=..&tok=..&redir=..` in every version read). The
  station reads the MAC from its own ARP table: it is on the same LAN, and the
  main Wi-Fi has no client isolation (setup.sh warns if it has).
- The client IP is inside `authaction`'s value; the auth URL is `authaction`
  up to its `?`.
- To open the internet, the **phone's browser** must open
  `<auth URL>?tok=<tok>&redir=<url>` (openNDS knows the client by the
  request's address; a call from the station would be the station's). If
  `binauth.sh` refuses, openNDS sends the phone back to the portal.
- `dhcp_default_url_enable 0`: the RFC 8910 portal URL that openNDS would
  hand out by DHCP leads to `fasurl?clientip=..&tok=..` **without**
  `authaction`, so it is off and phones use the classic probe.
- Level 0 puts the token in clear (plain `http` on the LAN). That is
  accepted: openNDS checks the token against the requesting phone's own
  entry, and the router's quota does not depend on it.

## Tests

In WSL (Ubuntu) as root, after `apt-get install -y busybox` (and optionally
`shellcheck`):

```sh
sh /mnt/c/Users/<you>/Documents/GitHub/Ficha/openwrt/test-binauth.sh
sh /mnt/c/Users/<you>/Documents/GitHub/Ficha/openwrt/test-setup.sh
```

`test-binauth.sh` runs the scripts under busybox ash with busybox applets
only, a fake `date` and `logger`: first grant allowed, the same device again
refused (any spelling of its MAC), other devices independent, the notices
change nothing, the deny form, fail-closed cases, the config file, the next
day allowed with a new salt and yesterday deleted, the cron rotation, no MAC
or IP in any file, file name or log line, and the openNDS 11 adapter.
`test-setup.sh` runs `setup.sh` on a fake router (a fake `uci` that stages
until commit, stubbed packages and services): the settings, a second run that
changes nothing, the Wi-Fi, a new laptop, `--check` and `--remove`, and
the note that the free internet is a courtesy limit. Neither can run
openNDS: step 5 above is the test on the real router.

## Troubleshooting

| symptom | look at |
|---|---|
| no sign-in window | open `http://neverssl.com`; `ndsctl status`; after a VPN or firewall change: `/etc/init.d/opennds restart` |
| the portal does not load | station running with `HOST=0.0.0.0`? laptop at `192.168.8.20`? Windows firewall (private network, TCP 8000)? |
| "Pay with Ficha" cannot load or pay | `nslookup ficha-stellar.vercel.app 192.168.8.1`; `nft list set ip nds_filter walledgarden`; the phone's Private DNS |
| the station is offline (Horizon) | `uci get opennds.setup.trustedmac` has the laptop's MAC? |
| the station cannot read the phone (ADB) | the phone on the main SSID, not the guest network; no client isolation |
| free internet refused at once | `logread -e ficha-freewifi` (`used_today`, `off`, `bad_device`, `free_error`); `cat /etc/ficha/freewifi.conf`; the router's `date` |
| the portal says "not on the station's Wi-Fi" or "from the sign-in page" | the phone opened the station's address itself (use the sign-in page); the router's LAN is not a /24 with the station in it (`uci get network.lan.ipaddr`, `ipconfig`) |
| it ends at the wrong time of day | SYSTEM > Time Zone; `date` on the router |

Restarting openNDS logs every phone out; a phone already given its free
minutes today does not get them again. setup.sh restarts it only when a
setting changed.
