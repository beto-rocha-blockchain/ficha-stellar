# Pitch outline

Two versions: a 13-slide deck for the live pitch and the mentors, and a
4-slide PDF in the format the 2025 rules asked for (Solution, PMF, Technical
Workflow, Team). Every number on a slide must come from the repository or
from a cited source; the notes say where.

The 2026 rules are published on the build page
(<https://www.hackmeridian.com/build>) and the FAQ
(<https://www.hackmeridian.com/faq>):

- Judging is an async review of the demo video, the pitch deck, the GitHub
  repository and the submission answers. Submissions close on Monday
  26 October at 12:00 Lisbon time, through the builder portal
  (app.hackmeridian.com/portal/submit), with no late submissions. Live
  pitches are for finalists only, on Wednesday 28 October at Meridian.
- The deck has no set slide count or format: either version can be
  submitted, and the 4-slide PDF stays within the 2025 limit.
- One rubric, each criterion scored 1 to 5: Ecosystem Alignment (Scale)
  20%, User Value & Problem 20%, Technical Execution 15%, Innovation 15%,
  Hackathon Progress 10%, Market & Ecosystem Potential 10%, Product Design
  & UX 10%.
- Scale is also judged on milestone completion against the goals set at
  the pre-event intake, SCF eligibility, production readiness and
  ecosystem impact.

## The 13-slide deck

Slide 10, public safety, was added on 23 October 2026, after the paid
flow's slides: it follows Why Stellar, since paying with no mobile data
rests on the same Stellar pieces, and leads into the markets of slide 11.

### 1. Ficha: phone charging by the minute, on Stellar

- The mark (a coin with the pins of a Schuko plug), the README's two
  badges (Stellar mainnet: direct payments; custody: testnet until
  audited), the app's address.
- Notes: "In Portugal a ficha is a plug; in Brazil, the token for a public
  phone. Ficha is both: a token of charging time at a plug in a public
  place."

### 2. The problem

- A phone at a low battery in a café: ask for a socket, rent a power bank
  through an app with an account, a card and a deposit, or go without.
- A venue cannot sell a few minutes of electricity: a card payment for cents
  costs more than it brings in, and there is no meter or receipt.
- Prepaid time is taken on trust: unused time never comes back.
- Notes: keep it to the experience; no market figures we cannot source.

### 3. The solution

- Scan a QR, pay a few fichas from a wallet on the phone, charge.
- Time counts only while the station has proved the phone charges from it.
- What was not used comes back with one tap on the receipt, before a
  deadline; the venue gets the rest.
- Ficha, the operator, never holds the money. The station holds no key.

### 4. The hardware

- Photo of the table: laptop, the CH340 relay board, the charger, the cut
  cable, the phone on its stand.
- NO contact only: any failure means no power, never free power. 5 V at
  events; the target design switches a certified charger's supply inside a
  closed enclosure.
- Notes: the meter today is the phone's own battery reading over ADB, a demo
  meter. A meter at the outlet is on the roadmap.

### 5. The payment, in one picture

- The sequence diagram of the README: QR with the anchor → deposit into
  FichaEscrow → the station reads the event → probes → receipt with the proof
  → claim → payer's share and venue's share.
- Notes: the station only reads the ledger through a Soroban RPC.

### 6. The trust problem, and the hash chain

- "Who proves the minutes were not delivered, if the station has no key?"
- A random seed per session, hashed forward N times; the last hash (the
  anchor) is in the QR; the receipt reveals the link U steps back.
- Hashing forward only proves fewer units: nobody can shrink a refund, and a
  bigger one would take inverting SHA-256.
- Notes: PayWord-style chains (Rivest and Shamir, 1996), used in reverse: the
  proof is of time *not* delivered. The seed signs nothing and can only
  refund that session's payer.

### 7. The contract: FichaEscrow

- `register`, `deposit`, `claim`, `release`, `host_refund`, `pay_host`; no
  admin, no upgrade, no withdraw.
- Invariants with tests: shares add up for every unit, only the payer
  claims, the venue cannot cut a refund before the deadline, the payer's
  refund never waits on the venue, nothing the venue does to its account
  can fail a claim, the payer signs the terms.
- Smart accounts: the payer can be a contract account. Tested with a
  minimal one whose `__check_auth` checks a secp256r1 signature (the
  passkey curve): it pays, tops up and claims, and nobody else can claim
  its session.
- Testnet ID `CBRNN2W7…HYI6KYC`, wasm sha256 `d4314635…d865`, 37 tests.
- Notes: two deployments were retired after our own reviews. The first
  found three issues (a venue that could hold a refund back, a squattable
  session ID, terms outside the payer's signature); the second, that a
  venue could still fail a claim by changing its account between the
  payer's simulation and the ledger, so a claim now never touches the
  venue's account and keeps its share for `pay_host`. Each fix has a
  regression test (the second one replays the footprint as the ledger
  enforces it), and the current deployment is the one the registry
  names.

### 8. Verified charging: the probe

- The relay opens for 3 s; the current must drop. Current that keeps flowing
  comes from another charger, and the clock stays frozen.
- 20 s without current pauses the clock; a probe every 5 minutes checks
  again; a phone never plugged in gets everything back.
- Notes: show the recorded clicks; the probe seconds are never billed.

### 9. Why Stellar

- Soroban contract with no admin; the SAC moves the asset; Soroban RPC lets a
  keyless station watch; ledger time for deadlines.
- SEP-7 for direct payments with any wallet (the mainnet default); SEP-10
  and SEP-24 to buy balance through an anchor; SEP-5 non-custodial wallet;
  a registry signed with a Stellar key; Friendbot on testnet.
- Notes: without a ledger and a contract, prepaid time needs someone to hold
  the money. Fees measured on testnet on 2 October 2026: a deposit about
  0.036 XLM (mostly rent), a claim about 0.0024 XLM; testnet's resource
  fees then surged (a deposit simulated at 2.23 XLM on 25 October). On
  mainnet, the first direct payment's fee was 100 stroops (0.00001 XLM).

### 10. A charging point that can save a call

- Where a dead phone is dangerous: bus and train stations, airports, remote
  places, neighbourhoods with high rates of violence or kidnapping.
- Once a day, every phone: 2 minutes of charging (the station's relay) and
  2 minutes of internet (the station's Wi-Fi router), free, with the local
  emergency numbers first (112; in Brazil 190, 192 and 193).
- Paying needs no mobile data: on the station's Wi-Fi, the Ficha app and the
  Stellar endpoints it uses are open before any sign-in.
- Privacy: a phone is a salted hash of its Wi-Fi MAC address, with a new
  salt every day; no MAC, IP or name is kept. No money moves for a free
  minute, and the station holds no key and no password, not even the
  router's.
- Picture: the Wi-Fi's page on a phone (the emergency numbers first, the
  two free buttons, Pay with Ficha) next to the station screen's emergency
  band.
- Notes: say plainly that Ficha is not an emergency service and does not
  replace one; that the 2 minutes of internet are a courtesy for an
  ordinary phone, not a hard limit (shared hosting addresses, phones that
  change their MAC address); and that the router's side is tested in WSL,
  on a fake router. Who pays for the free minutes:
  the venue today (a free charge is a fraction of a cent of electricity, an
  estimate); a city, an NGO or a sponsor next; sponsored fichas on the
  ledger are on the roadmap, not built. Sources: `docs/public-safety.md`,
  the `.env` examples (120 + 120 seconds, the numbers).

### 11. Lisbon and the EU

- Price in EURC (Circle states it is MiCA-compliant) and buy it through a
  SEPA anchor: both on the roadmap.
- Portugal pays by phone: MB WAY reports about 7 million users (SIBS, annual
  report 2025); a licensed provider for local methods is on the roadmap.
- Notes: the MiCA framing of an escrow with no admin has not been checked
  yet; say so if asked.

### 12. Built before the event, and at it

- Scale path: the product was built before HackMeridian, from 28
  September 2026. The public repository's first commit is tagged
  `pre-hackmeridian` (23 October); the event's work is in the commits
  after 25 October, 12:00 Lisbon time.
- At the event: the mainnet migration of direct mode, which predates the
  event. Station `8DY7RJ` in a signed public registry; its first real session on 25 October (1 XLM
  for 2 fichas, transaction `958e7ab6…` on stellar.expert); the station's
  and the app's guards for real money; refunds signed by the venue, built
  and tested in simulation, the first live one still to come. Custody
  stays on testnet until an audit.
- Tests: 681 station checks and 385 app tests (26 October), 37 contract
  tests and 61 + 83 checks of the router's scripts (23 October).
- Public safety mode, built on 23 October and off by default.
- Testnet: recorded runs with every transaction linked (deposit, top-up,
  claim, `pay_host`, release, a squatter's session kept apart,
  `TermsChanged` before signing).
- Notes: update the numbers from the suites the day before; never round up.

### 13. Next, and the ask

- Roadmap: strict delivery proof, the payer's app as a witness, a metered
  outlet with an attestation key, EURC and a SEPA anchor, passkey smart
  accounts, a ring of session slots, an audit before custody on mainnet;
  for public safety, sponsored fichas on the ledger.
- The ask: mentors' review of the escrow and the hash-chain design; a venue
  in Lisbon for a pilot; introductions to an EU anchor; a city, a transport
  operator or an NGO for a public safety pilot.
- Team, and the links: the app, the repository, the contract on
  stellar.expert.

## The 4-slide PDF (2025 format)

### 1. Solution

- One line: pay-per-minute phone charging on Stellar, unused minutes back
  with one tap on the receipt, no key on the station.
- Three pictures: the station on the table, the app's pay screen, the
  receipt with "Refund received".
- The two modes: direct SEP-7 to the venue (mainnet default), custody
  through FichaEscrow (testnet demo stations).
- Public safety mode: 2 min of charge and 2 min of internet free per phone
  per day, the emergency numbers first, paying with no mobile data; not an
  emergency service.

### 2. PMF

- Who pays: people whose phone runs low away from home, at cafés,
  coworking spaces, events.
- Who earns: the venue, paid directly, with no terminal and no card fees on
  cents; Ficha never holds the money.
- Why now, in Lisbon: phone payments are everyday (MB WAY, about 7 million
  users per SIBS' 2025 report); EURC is available on Stellar.
- What a pilot would measure: sessions per day, minutes charged against
  minutes paid, refunds claimed, venue revenue.
- Where a phone is a lifeline: transit hubs, remote places, areas with high
  rates of violence or kidnapping; a venue, a city, an NGO or a sponsor
  funds the free emergency minutes.

### 3. Technical Workflow

- The sequence diagram (QR → deposit → event → probes → receipt → claim).
- The hash chain in one line: seed → … → anchor; the receipt reveals the
  link U steps back.
- The contract's guarantees: no admin; payer's refund first (a claim never
  touches the venue's account; the venue collects with `pay_host`); terms
  signed; sessions keyed by anchor; smart-account payers tested.
- Testnet contract ID and the recorded run.

### 4. Team

- Beto Rocha: the station, the contract, the app, the hardware.
- Built with Claude Code, the SDF's Stellar Skills and the OpenZeppelin
  Stellar MCP.
- Links: the app, the repository, the contract.
