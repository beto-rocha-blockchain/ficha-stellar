# Live demo script (3 minutes)

The live demo at the HackMeridian table: the demo station `YX3DGE` on the
real relay, in custody mode on testnet. One person drives the station, one
holds the payer's phone (ours, or the judge's own). Rehearse it timed,
start to finish, until it fits in 3:00 with 15 s to spare.

## The table

| Item | Set up as |
|---|---|
| Laptop | the station running from `.env.mains.example` (plan A), its screen full screen in a browser at `http://127.0.0.1:8000`, keyboard in reach (E and ESC) |
| Relay board | the LCUS CH340 board in the laptop's USB (`RELAY_PORT`) |
| Charger and cable | a USB wall charger in the table's socket; its cable with the red VBUS wire cut through the relay's COM and NO; **5 V only** |
| Measured phone | our moto g54 on a stand, on the cut cable, screen on, USB debugging allowed for this laptop, on the travel router's WiFi (WiFi ADB) |
| Payer's phone | our second phone with the Ficha app (PWA or debug APK) and a wallet holding at least 20 test XLM; or the judge's phone (see below) |
| Second screen or tab | stellar.expert on the contract `CBRNN2W7…HYI6KYC` and on the payer's account |
| Card on the table | the app's address, <https://ficha-stellar.vercel.app>, as text and as a QR, and the repository's address |
| Travel router | its own network for the laptop and the measured phone; uplink the venue's WiFi or a Portuguese SIM |

## Before the judges arrive (10 minutes)

1. Station stopped: `python diag.py meter 10` prints the phone's current;
   `python diag.py relay` clicks three times. (A COM port opens in one
   program only: never with the station running.)
2. Start the station: `python main.py`. The screen shows the pay QR and
   "Scan to buy fichas". The footer reads TESTNET, the registry item is
   green (`ok · site`), the escrow item is green and names `CBRN…6KYC`, and
   there is no clock warning.
3. Payer's phone: unlock the app, check the balance (at least 20 XLM), and
   close any old pay page.
4. Open the stellar.expert tabs.
5. If a judge wants to pay with their own phone: they scan the QR **before**
   the clock starts. The app takes them through creating a wallet (English,
   **Create a new wallet**, 24 words, three typed back, a PIN), activates it
   with test XLM from Friendbot, and returns to the pay page. That takes
   about a minute; the 3 minutes below start once their pay page is open.

## The 3 minutes

| Time | Say | Do | The judges see |
|---|---|---|---|
| 0:00 | "In Portugal, a ficha is a plug. Ficha sells phone charging by the minute, paid on Stellar, and gives you back the minutes you did not use. The station holds no key." | Point at the station screen | The pay QR, "Scan to buy fichas", the TESTNET badge, the footer naming the escrow contract |
| 0:15 | "The QR is a link to the Ficha app. It checks the station in a signed registry and on the contract before anything is signed." | Scan the QR with the payer's phone | The app: "Station checked in the signed registry and on the custody contract.", "1 XLM per ficha · 1 min each" |
| 0:30 | "Two fichas, two minutes. The money goes into a Soroban escrow with no admin, not to us." | Pick 2 fichas, tap **Pay 2 XLM**, confirm with the PIN or fingerprint | Within seconds the station credits the deposit and the relay clicks: "Your time starts only when the station detects the charge." |
| 0:50 | "Paid time counts only while this station is proved to charge the phone. The relay opens for 3 seconds: if the current drops, it is ours." | Nothing: the phone is already on the cable | "Checking the charge…", two clicks, the countdown starts and the current in mA shows |
| 1:10 | "If the phone stops charging here, the clock stops." | Unplug the cable from the measured phone | After 20 s: "Time is not counting.", the countdown frozen |
| 1:35 | "Back on the cable, a new probe, and it counts again." | Plug it back in | "Paused: current detected, checking …", a probe, the countdown runs again |
| 1:55 | "The customer is done early." | Press **E** on the station | FINISHED: the receipt QR, "Done. Thank you.", the paid and used time |
| 2:05 | "The receipt carries a proof: a link of a hash chain whose end the payer deposited under. Only the payer can use it." | Scan the receipt with the payer's phone, tap **Get … XLM back**, confirm | "Refund received", the split: what came back, what went to the venue |
| 2:25 | "One transaction: the unused minutes back to the payer, the rest set aside for the venue. The claim never touches the venue's account, so the venue cannot block it." | Open the claim on stellar.expert | The `owed` event (the venue's share), then the `settle` event: `to_payer`, `to_host`, `how` = `proof` |
| 2:40 | "No key on the station, no admin on the contract, and the refund came from a hash the station revealed. On mainnet a station takes direct SEP-7 payments until the contract is audited." | Point at the card | The app's address and the repository |

The refund depends on the seconds actually charged: with 2 fichas (8 units
of 15 s) and about 40 s charged, 6 units come back, 1.5 XLM, as in run I of
[docs/testnet-e2e.md](../testnet-e2e.md) (2 fichas as a deposit and a
top-up, ended with E, on the station and the app as they ship).
If the countdown ever reaches zero, nothing is unused: press E before 2:00
of counting. If the FINISHED screen has gone (60 s) before the scan, the
receipt waits on the station's waiting screen as a `ficha:` link: scan it
from the app's **Scan QR**, not the phone's camera.

## Questions to expect

| Question | Answer, from what is built |
|---|---|
| What if the payer never scans the receipt? | The venue gets everything at the deadline, as with a direct payment. Until then the station keeps the receipt on its waiting screen, labelled for the previous customer (the app's Scan QR opens it), and the app links back to it from History. |
| How does the venue get its money? | At the deadline, a release pays it at once. A claim keeps the venue's share in the contract, owed to that venue alone, so nothing the venue does to its account can fail the payer's refund; the venue's phone collects everything owed with one `pay_host` (host mode's **Collect** button). Anyone may send it; it pays only the venue. |
| What if the venue alters the station? | It could reveal fewer unused units: the station's measurement is trusted, as any meter is. Nobody else can cut the refund it grants, the venue included. Next: the payer's app as a witness of the probes, then a metered outlet with an attestation key. |
| Why does the station need no key? | Everything it must know is public: deposits are contract events it reads through a Soroban RPC. Its only secret is a random seed per session, which signs nothing. |
| Why not mainnet? | The contract is not audited. On mainnet a station takes direct SEP-7 payments to the venue, which work today with any wallet. |
| Could another wallet steal the session? | A session is its ID plus the anchor. A deposit with another chain is another session the station ignores. A copy of the exact QR can be paid first; the real payer is stopped before signing, and the copier only pays fees. |
| Can it run in euros? | Direct mode takes any Stellar asset today. The escrow moves any asset's SAC, but custody stations use XLM only for now: an asset's issuer could freeze a payer or claw back the escrow's balance, so EURC in custody needs an allowlist of issuers first. EURC and a SEPA anchor are on the roadmap; the MiCA framing of an escrow with no admin is still to be checked. |
| Unit economics? | Not measured yet. The demo prices are testnet placeholders. |

## Fallbacks

Decide in the first minute at the table which plan runs, and do not switch
mid-demo.

**A. Travel router.** The venue's WiFi isolates clients (the laptop cannot
reach the phone): put the laptop and the measured phone on the travel
router, in repeater mode on the venue's WiFi or on a Portuguese SIM's
hotspot. Check with `python diag.py meter`. Turn off any VPN on the laptop
that blocks the local network.

**B. The laptop's own hotspot.** No travel router: turn on Windows' Mobile
hotspot and join the measured phone to it. Whether this laptop's adapter can
share while connected to WiFi is not verified: rehearse it before the trip.

**C. The phone on the laptop's USB** (`.env.usbvbus.example`). No network
between laptop and phone at all: the measured phone hangs off the laptop's
USB port through the cut cable and is read over USB ADB. The station still
needs internet (any WiFi, or a phone's hotspot). It charges slowly (450–600
mA), and ADB drops each time the relay opens: that is how the probes see the
cut. Stop the station, copy the file's values, set `ADB_SERIAL` if two
phones are attached, start again.

**D. No hardware, or no internet.**
- Internet but no hardware: run `.env.lisbon.example` (simulated relay and
  phone, `MOCK=true`, real deposits). The demo is the same, with the relay's
  clicks replaced by the screen, and at 1:10 and 1:35 press **U** on the
  station instead of moving the cable: it unplugs the simulated phone and
  plugs it back in (the header shows the key while charging).
- No internet: play the video, then run the simulated direct-mode station
  (`.env.example`: fake payments with `curl -X POST localhost:8000/debug/pay`,
  [docs/operators.md](../operators.md), section 1). A custody station shows
  no pay QR until it has read the contract. Show the recorded run's
  transactions from offline screenshots.
