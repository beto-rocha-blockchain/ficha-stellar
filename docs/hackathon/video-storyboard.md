# Video storyboard (about 2:57)

For the submission video: English, under 3 minutes, with burned-in captions
so it works muted. Everything filmed is real and on testnet, and what is
simulated says so on screen (the public safety scene without its router);
the TESTNET badge stays in frame whenever the station's screen or the app
is.

The 2026 rules (<https://www.hackmeridian.com/build>) make the demo video
one of the four things judges review asynchronously, with the pitch deck,
the GitHub repository and the submission answers, due Monday 26 October at
12:00 Lisbon time. They set no length, language or host for it, so the
2025 limit, 3 minutes in English, stays the target.

## What to film

| Source | How |
|---|---|
| The station's screen | screen capture of the laptop (the browser full screen) |
| The payer's phone | Android's own screen recording, plus a hand-held shot of the scan |
| The table | one fixed camera over the shoulder: relay board, cut cable, phone on its stand; the relay's click must be audible |
| The ledger | screen capture of stellar.expert: the contract, the deposit and the claim transactions |
| The diagram scene | the two mermaid diagrams of the README, rendered and animated one step at a time |
| The public safety scene | screen capture of the station screen's emergency band and of the Wi-Fi's page (`/portal`) in a window as narrow as a phone; the relay's click |

Record one continuous take of the whole session (pay, probe, unplug, plug
back, E, claim), then cut it to the scenes below. Keep the transaction
hashes of that take: they go in the description and in the README. The
public safety scene (2:30) is filmed apart and added in the edit
([below](#the-public-safety-scene)): nothing in the paid take changes for
it.

## Scenes

| Time | Picture | Narration (summary) | On-screen caption |
|---|---|---|---|
| 0:00–0:10 | A phone at a low battery, on a café table in Lisbon; the Ficha mark | the hook | **In Portugal, a ficha is a plug.** |
| 0:10–0:25 | The station on the table: laptop, relay board, charger, phone | the problem and the promise | **Pay by the minute. Get back what you don't use.** |
| 0:25–0:50 | Scan the QR; the app checks the registry and the contract; 2 fichas; Pay 2 XLM; the fingerprint | the payment | **Deposit into a Soroban escrow with no admin** · **TESTNET** |
| 0:50–1:15 | The relay clicks, "Checking the charge…", the relay opens 3 s, the countdown starts, the current in mA | the probe | **Time counts only while this station charges the phone** |
| 1:15–1:35 | The cable unplugged: "Time is not counting."; plugged back: a probe, counting again | the honesty test | **No charge here, no time used** |
| 1:35–2:00 | E: the FINISHED screen and its receipt QR; the phone scans it; "Get 1.5 XLM back"; "Refund received" | the refund | **The receipt carries a proof. Only the payer can use it.** |
| 2:00–2:10 | stellar.expert: the claim's `owed` and `settle` events, `to_payer` and `to_host` | one transaction | **Refund and venue's share: one transaction** |
| 2:10–2:30 | The architecture diagram, then the hash chain: c0 → … → anchor | why nobody needs to trust the station's key | **No key on the station. No admin on the contract.** |
| 2:30–2:45 | The station screen's emergency band; the Wi-Fi's page: 112 first, **2 min free charge**, **2 min free internet**, **Pay with Ficha**; a tap on the free charge: the relay clicks, the screen reads "free charge" and counts 2:00 down | public safety | **Free, once a day per phone: 2 min of charge, 2 min of internet** · **Not an emergency service: call 112** |
| 2:45–2:57 | The README's top; the app's address; the repository | what is next, and links | **ficha-stellar.vercel.app** · **Built for HackMeridian 2026, Scale path** |

## Narration

About 380 words, read at an even pace (about 140 a minute). Numbers in brackets are what the
recorded take must show; change them to the take's own if they differ.

> **[0:00]** In Portugal, a ficha is a plug. Ficha turns any plug in a café,
> a coworking space or an event into a phone charger you pay by the minute,
> on Stellar.
>
> **[0:10]** Today, a venue cannot sell a few minutes of electricity: a card
> payment for cents costs more than it brings in, and nobody gives back the
> time you paid for and did not use. Ficha does both.
>
> **[0:25]** The station shows a QR. My phone opens the Ficha app, which
> checks the station in a signed registry and on the contract before
> anything is signed. I buy two one-minute fichas. Two test XLM go into
> FichaEscrow, a Soroban contract with no admin and no upgrade: not to us,
> and not yet to the venue.
>
> **[0:50]** The station saw the deposit on the ledger and closed the relay.
> But time only counts once it proves the phone charges from it: it opens
> the relay for three seconds, and the current drops. Now the clock runs.
>
> **[1:15]** If I unplug the phone, the clock stops. Plug it back in, a new
> probe, and it runs again. You pay for charging, not for waiting.
>
> **[1:35]** I stop early. The receipt QR carries a proof: one link of a
> hash chain whose end I deposited under. My app checks it, and I claim.
> [One and a half XLM] come back to me, and the rest is set aside for the
> venue, in one transaction.
>
> **[2:10]** Here is the trick. The station holds no Stellar key and no
> account: it only reads the ledger. For each session it draws a random seed
> and hashes it forward. The last hash goes in the QR. At the end it reveals
> an earlier link, and the number of hashes back to the anchor is the time I
> did not use. Hashing forward can only prove less, so nobody can shrink my
> refund. If I never claim, the venue gets everything at the deadline, as
> with any payment.
>
> **[2:30]** Some stations go where a dead phone is dangerous. Once a day,
> every phone gets two minutes of charge and two of internet, free,
> emergency numbers first. Paying needs no mobile data.
>
> **[2:45]** Ficha runs on testnet today, with direct SEP-7 payments for
> mainnet. Next: a metered outlet, euros with EURC, and passkey wallets.
> Try it at ficha-stellar.vercel.app.

## The public safety scene

Added in the edit at 2:30, after the paid take, and filmed apart from it:

- On a station whose `.env` has `WIFI_PORTAL=simulate` (every demo `.env`
  example has it), never during a paid session: a free charge is refused
  while one runs, and while a finished session's screen is up.
- Capture the station screen with its emergency band, and the Wi-Fi's page
  at `/portal` on the station's own computer, in a browser window as narrow
  as a phone. Tap **2 min free charge**: the relay clicks, and the screen
  reads "free charge" and counts down. A second of the page in Portuguese
  (`?lang=pt`) makes a good cut-away.
- Without the router, the page and the band say SIMULATED: keep it in frame
  and add the caption "Simulated here: the Wi-Fi router goes live at the
  event". If the router runs at the event before the deadline, film a real
  phone joining the station's Wi-Fi instead, with its sign-in page opening
  by itself, and drop that caption.
- Each take uses up the computer's own free charge for the day: add
  `?clientmac=02:00:00:00:00:21` (then `…:22`, `…:23`) to the page's
  address for each new take. It is a test address, and only the station's
  own computer may give one.

## Captions file

Burn the captions in, and also export them as an `.srt` from the edit, one
line per narration sentence, so the platform can show them too.

## Checklist before upload

- Length under 3:00; English; captions readable on a phone.
- TESTNET visible in every shot of the station or the app.
- No secret, seed words, PIN or private address book on any screen. The
  wallet's 24 words never appear: film the wallet created off camera.
- The public safety scene: SIMULATED in frame if it was filmed without the
  router; no real MAC address on any screen (`?clientmac=` takes a test
  one); "Not an emergency service" in its caption.
- The transaction hashes of the take listed in the description.
- A copy offline (laptop, phone, USB stick) for fallback D of the demo.
