# Ficha app

The Ficha wallet: an installable PWA (and, through Capacitor, an Android app)
that pays a Ficha station for charging time. Non-custodial: keys are created
and kept only on the phone, encrypted with the user's PIN. The contract with
the station is [`../docs/station-app-contract.md`](../docs/station-app-contract.md).

The visual system: tokens in `src/styles.css`, shadcn/ui new-york components in
`src/components/ui/`.

## Run

```bash
cd app
npm install          # already done; every dependency below is installed
npm run dev          # http://localhost:5173 (predev copies ../registry and the icons)
npm run build        # vite build + tsc --noEmit -> dist/
npm run test         # vitest (SEP-5 vectors, vault, money math, i18n)
npm run preview      # serve dist/
```

`npm run sync-assets` (run automatically by predev/prebuild) copies
`../registry/*` byte for byte into `public/registry/` and builds the icons from
`../brand/` (`ficha-app-icon.svg` and `png/*.png` when present, otherwise the
mark). Those outputs are gitignored.

Optional env: `VITE_HORIZON_TESTNET`, `VITE_HORIZON_PUBLIC` (Horizon overrides),
`VITE_RPC_TESTNET` (Soroban RPC override, custody mode),
`VITE_BASE` (public path; `/` by default, see below).

## Web site (Vercel)

The PWA is published as the Ficha site <https://ficha-stellar.vercel.app/>, at
the root path `/`. The Vercel project `ficha` deploys the private site
repository, which holds only the built site; each push to it deploys. This
repo builds the site and copies it there:

```bash
npm run build:site                              # -> dist-site/ (gitignored), base /
node scripts/publish-site.mjs <site checkout>   # copies dist-site/ into the checkout
cd <site checkout> && git status && git add -A && git commit -m "Site: ..." && git push
```

- `VITE_BASE` sets Vite's `base` (`/` for the site, `npm run build` and the
  Android app); the router `basepath`, the PWA manifest (`id`, `start_url`,
  `scope`), the service worker (`<base>sw.js`, scope `<base>`) and its page
  fallback follow it.
- `site/` holds what only the site carries, copied into `dist-site/`:
  `.well-known/assetlinks.json` (the Android App Link, see Android below)
  and `vercel.json`. Any path that is not a file gets `index.html`, so a hard
  reload of a deep link (`/r?v=1&…`, `/stations/ERZGCG`, `/pay`,
  `/estabelecimentos`) still loads the app, which reads the path from the
  address bar. `/registry/`, `/.well-known/` and `/assets/` are never
  rewritten: a missing file there is a 404, not the app.
  `/registry/*` is served with `Access-Control-Allow-Origin: *` (the Android
  app reads it from `https://localhost`) and `Cache-Control: no-cache`, so a
  new signature is seen at once (`src/site-config.test.ts` checks both).
- The site serves the signed registry at `/registry/stations.json`
  (+ `.sig`; the public network's at `/registry/stations.public.json`),
  byte for byte from `../registry/`. That is the live copy every app fetches
  first (`liveRegistryUrl` in `src/config.ts`). The copy bundled in the
  build is the fallback when the site cannot be reached, the last verified
  live copy is kept for offline use, and the newest verified copy
  (`issued_at`) wins. The Stations screens say which copy is in use and when
  it was issued.
- `publish-site.mjs` never commits or pushes. It removes only the files it
  wrote on the previous run (listed in `.ficha-site-files` there) and adds
  `registry/** -text` to the target's `.gitattributes` when it has none.
  The previous build's `assets/` files stay one more publish (listed in
  `.ficha-site-files-kept`): the first visit after a publish still runs that
  build until it can reload into the new one, and loads its route chunks
  from the site.

## Stack

Vite 7, React 19, TypeScript strict, Tailwind v4, shadcn/ui (new-york),
lucide-react, sonner, zustand, TanStack Router (file routes, SPA),
@stellar/stellar-sdk 17 (Horizon and Soroban RPC), vite-plugin-pwa, @fontsource (Space Grotesk,
JetBrains Mono, Montserrat; no CDN), @scure/bip39 + @noble/hashes, idb-keyval,
qrcode, vitest.

Also installed: `qr-scanner`,
`leaflet` + `react-leaflet` + `@types/leaflet`, `@capacitor/core`,
`@capacitor/cli`, `@capacitor/android`, `@capacitor/app`,
`@capacitor/browser` (SEP-24 interactive popup), `@capacitor/status-bar`,
`fake-indexeddb` (tests). SEP-10 is `WebAuth` in `@stellar/stellar-sdk`.
Battery Status API types: `src/types/battery.d.ts`.

## Structure

```
src/
  main.tsx              router + fonts + styles (no Node polyfills: nothing uses a global Buffer)
  config.ts             networks (testnet default / public): Horizon, passphrase,
                        USDC issuer, registry URL + pinned key, anchor, custody
                        (Soroban RPC, FichaEscrow ID, pinned wasm hash, XLM SAC),
                        WALLET timings
  styles.css            design tokens and utilities (.panel, .label-op, .kpi-num, ...)
  routes/               file routes (routeTree.gen.ts is generated, do not edit)
    __root.tsx          wallet gate + shell + Toaster + first-run language chooser
    index.tsx           Inicio (balances, Friendbot, receive, USDC trustline)
    welcome.tsx         onboarding (create: 24 words + confirm 3; import: words or S...)
    settings.tsx        Ajustes (network, language, show words, lock, remove, host
                        mode on testnet, about)
    pay.tsx scan.tsx history.tsx r.tsx buy.tsx battery.tsx
    p.tsx               custody pay link (/p?v=1&...): checks, deposit, top-up
    host/index.tsx      host mode (testnet): the wallet's stations, open sessions,
                        release (one or all past the deadline), host_refund, and
                        what the contract holds for the host (pay_host)
    host/station.tsx    host mode: register or change a station's terms
    stations/index.tsx  stations map + list, from the signed registry
    stations/$id.tsx    one station: terms, payment mode, the wallet's sessions there
    estabelecimentos.tsx  the page for venues that could host a station
  wallet/               keys: sep5.ts (derivation), vault.ts (encryption + IndexedDB),
                        store.ts (status, in-memory key), autolock.ts, index.ts (API)
  stellar/              shared Stellar module: network, horizon reads, tx builders,
                        submit, money math (stroops/BigInt), error messages
  custody/              custody mode (contract §7): chain.ts (hash chain, units, shares),
                        link.ts (/p link), escrow.ts (FichaEscrow over Soroban RPC),
                        check.ts, pay.ts (deposit, claim), receipt.ts (receipt v2),
                        sessions.ts (History), deposits-store.ts, errors.ts,
                        host.ts (host mode: register, release, host_refund,
                        pay_host, the host's view), host-store.ts (its state,
                        outside the screens)
  i18n/                 one file per feature, auto-merged (see below)
  components/           Brand, AppShell, LanguageGate, LockScreen, UnlockForm,
                        RequireUnlocked, NetworkBadge, PageHeader, Placeholder,
                        QrCode, CopyButton; ui/ = shadcn primitives
  hooks/useAccountSummary.ts   polled balances of the wallet on the active network
  hooks/useHostContext.ts      network + Soroban RPC + host address + registry (host mode)
  lib/                  utils (cn), storage (safe localStorage), format
  store/ui.ts           language + network preference
```

## Routes

| Route | What it does |
|---|---|
| `/pay`, `/scan` | The scanner sends each QR to its route (`src/pay/qr.ts`). `/pay`, direct mode: SEP-0007 QR from the station; amount = fichas x `ficha_price` (`multiplyAmount`), never above `max_session_minutes / ficha_minutes` less the fichas this wallet already paid for the session (`fichasLeft`); check destination, asset and price against the signed registry (`src/pay/check.ts`); `buildPaymentTx` -> `signTransaction` -> `submitTx` inside `<RequireUnlocked>` |
| `/p` | A custody station's pay link `…/p?v=1&n&h&s&x&a` (contract §7.3, §7.4): signed registry (custody, `escrow`), the escrow's wasm hash and the station's terms on the ledger, the open session, and for a new session its events (a session someone already paid is a stale QR); deadlines by the ledger's time, and no top-up once the station has ended the session (900 s before its deadline). On Pay, `recheckDeposit` reads the session (and a new one's events) again, then `prepareDeposit` (simulated, refuses before signing, and checks the deadline it returns) -> balance with the real fee -> `sendDeposit` inside `<RequireUnlocked>`. A session that is over, with a receipt for it kept (its proof leads to the link's anchor), links back to its claim; a second anchor under an ID this wallet holds open is refused. Deposit records are keyed by the session's ID and anchor |
| `/r` | Receipt QR `…/r?v=1&m=…` (contract §3). Public route (works while locked or with no wallet). `v=2` (custody, §7.6): the proof against this wallet's deposit (the one its proof leads to; the receipt with the most unused units is kept with it), then `prepareClaim` -> `sendClaim`. With no wallet, or one that did not pay, `publicReceipt` checks it in public: the session its proof names on the contract, open or settled, with the transactions |
| `/host`, `/host/station` | Host mode, testnet only (Ajustes → Anfitrião): this wallet as a station's host. `loadHostView` (one getEvents filter per host and escrow, then the ledger entries), `releaseSession`/`releaseMany`, `prepareHostRefund` (in full before the deadline, any part after it), `prepareRegister`, and `collectOwed` (pay_host: every claim's host share waits in the contract, owed); deadlines by the ledger's clock (`ledgerClockNow`); all simulated before signing, inside `<RequireUnlocked>` |
| `/history` | The user's own payments (Horizon `join=transactions` for memos), and custody deposits (`src/custody/sessions.ts`: the phone's records, deposit/settle events, `session()`); an open custody session with a kept receipt links to its claim |
| `/stations`, `/stations/$id`, `/estabelecimentos` | Map (react-leaflet) + list from the **signed** registry (`liveRegistryUrl` first, then the bundled `registryUrl`/`registrySigUrl`, `registryKey` in `config.ts`; verify the raw bytes with `Keypair.fromPublicKey(key).verify(bytes, sig)`; reject a `network` mismatch). Public routes |
| `/buy` | SEP-10 (`WebAuth`) + SEP-24 with `anchorDomain` from `config.ts` (testnet: testanchor.stellar.org; public: none yet) |
| `/battery` | `navigator.getBattery` (feature-detect), or the Android plugin below |
| `/welcome` | Onboarding. A `/p` or `/pay` link opened with no wallet is kept (`src/lib/pending-link.ts`) and opened once the wallet exists; on testnet a new wallet is activated with Friendbot right away |

The registry loader is one shared module, `src/registry/`, used by Pay
(destination check), custody (the station's escrow) and Stations (map).

Adding things without touching shared files:

- **Strings**: create `src/i18n/<feature>.ts`:
  ```ts
  import { defineMessages } from "./types";
  export default defineMessages({
    "pt-BR": { title: "Pagar", total: "Total: {amount}" },
    en:      { title: "Pay",   total: "Total: {amount}" },
  });
  ```
  It is picked up automatically (`import.meta.glob`); use `const t = useT("<feature>")`.
  pt-BR is the source; the i18n test fails if pt-BR and en keys differ, or if
  any text says "token" (the user's money is "saldo"; charging time is "fichas").
- **Routes**: add a file under `src/routes/`; the router plugin regenerates
  `routeTree.gen.ts` on `dev`/`build`.
- **Stellar**: `import { useNetwork, buildPaymentTx, submitTx, describeStellarError, multiplyAmount } from "@/stellar"`.
- **Wallet**: `import { useWallet, signTransaction } from "@/wallet"`;
  wrap signing UI in `<RequireUnlocked>`.
- **Logo**: only through `src/components/Brand.tsx` (`<Brand />`, `<BrandMark />`),
  which reads `../brand/ficha-logo.svg` and `../brand/ficha-mark.svg`.

## Custody mode (FichaEscrow)

`src/custody/` holds no key and no UI. Every call goes through
`prepareCall` (build, simulate, check the authorization it asks for, assemble;
a contract error throws `EscrowError` before anything is signed; the time
bounds are the ledger's close time + 60 s, never the phone's clock) and
`sendAndWait` (send once, follow to the result on the ledger's clock;
`unknown_outcome` when there is no answer). The host's calls (`register`,
`release`, `host_refund`, `pay_host`) live in `host.ts` and go the same way,
each with the authorization it may ask for (`register` and `host_refund` the
host's own call alone, `release` and `pay_host` none);
`readEscrow`, `readSessions`, `fetchEscrowEvents` and `loadHostView` read
with no key.

Host mode keeps the host's key on the host's phone, never on the station.
A Soroban transaction carries one contract call and the network queues one
transaction per account, so "release all" sends one release after another,
each simulated, signed and confirmed; a session someone else settled
meanwhile is skipped, anything else stops the batch. Its progress lives in
`host-store.ts`, so it survives the lock screen.

An opt-in test runs a real deposit, top-up and claim on testnet with this
code (throwaway accounts from Friendbot, a throwaway station; about a minute):

```bash
FICHA_TESTNET_E2E=1 npx vitest run src/custody/escrow.testnet.test.ts
```

Another runs host mode the same way: register, refunds before and after
the deadline, release all, pause (about 7 minutes, mostly waiting for a
deadline on the ledger), and a claim whose host share the host then
collects with pay_host (about a minute):

```bash
FICHA_TESTNET_E2E=1 npx vitest run src/custody/host.testnet.test.ts
```

A third drives a RUNNING custody station (say one started with
`../.env.lisbon.example`: simulated relay and phone, real deposits) from
its screen's pay link to the claim, and checks the ledger's balances and
the station's log. The payer's key is read from a file, never printed; the
header of `src/custody/station.testnet.test.ts` lists the settings, and
`../docs/testnet-e2e.md` a recorded run:

```bash
FICHA_STATION_E2E=http://127.0.0.1:8000 FICHA_E2E_PAYER=<file with a funded testnet secret> \
  npx vitest run src/custody/station.testnet.test.ts
```

## Key protection

- **Derivation**: SEP-5 (BIP-39 seed -> SLIP-10 ed25519 -> `m/44'/148'/0'`),
  tested against the official SEP-5 vectors (`src/wallet/sep5.test.ts`).
  New wallets get 24 words; import accepts 12-24 words or an `S...` secret.
- **At rest**: the words (or secret) are encrypted with AES-256-GCM under a key
  from PBKDF2-SHA256 (600 000 iterations, random 16-byte salt) of the user's PIN
  (min 6 characters; a new PIN may not be one repeated character or a straight
  run like 123456), random 12-byte IV, AAD bound to the kind and public key.
  Stored in IndexedDB (`ficha.vault.v1`). Only the public key is stored in
  clear. Nothing secret goes to localStorage, the network, or logs.
- **In use**: unlocking decrypts once and keeps only the `Keypair` in a module
  variable (not React state, not persisted). `lock()`, page hide, 5 min idle or
  1 min in the background drop it.
- **Wrong PIN** fails the GCM tag check. A forgotten PIN is recoverable only
  with the words (remove wallet, import again). Nobody else can recover it.
- **PIN tries** (unlock, show words, remove from Ajustes) share one count kept
  in IndexedDB (`ficha.pinguard.v1`, `src/wallet/pinguard.ts`), so a restart
  does not reset it. After 5 wrong PINs in a row each try waits 30 s, 1 min,
  5 min, 15 min, 1 h, then 4 h; the prompts show the wait. The right PIN
  resets it. "Forgot the PIN?" on the lock screen stays open as the way out.
- **Show words / remove** both require the PIN. Remove deletes the vault from
  this phone only; the balance stays on the ledger.
- **Money**: amounts are decimal strings, math in stroops (`BigInt`); memos are
  refused (never truncated) above 28 bytes; USDC is matched by code **and**
  issuer; on a submit timeout the app polls the tx hash instead of resubmitting.

## Android (debug APK for the test phone)

Capacitor 7 wraps `dist/` in a native app: `app.ficha.wallet`, served inside
the WebView from `https://localhost`. Config: `capacitor.config.ts`; native
project: `android/` (Gradle 8.11, AGP 8.7, Kotlin 2.0, compileSdk/targetSdk 35,
minSdk 23). Tools: JDK 21 and the Android SDK (platform 35, build-tools 34,
platform-tools). `android/local.properties` (gitignored) points at the SDK:

```properties
sdk.dir=<path to the Android SDK>
```

Build (from `app/`, Git Bash; set JAVA_HOME per command, Windows-style path):

```bash
npm run android:sync     # npm run build + npx cap sync android + npm run android:icons
cd android && JAVA_HOME='<path to JDK 21>' ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

Install on the phone over WiFi ADB and start it:

```bash
ADB=<android-sdk>/platform-tools/adb
PHONE=<phone-ip>:5555                    # Developer options > Wireless debugging
$ADB connect $PHONE                      # a VPN on the laptop may block it
$ADB -s $PHONE install -r android/app/build/outputs/apk/debug/app-debug.apk
$ADB -s $PHONE shell am start -n app.ficha.wallet/.MainActivity
$ADB -s $PHONE logcat --pid=$($ADB -s $PHONE shell pidof app.ficha.wallet)
```

`install -r` keeps the wallet (IndexedDB lives in the app's data); uninstalling
deletes it, so only the 24 words bring it back. Debug builds are inspectable
from `chrome://inspect` (WebView debugging is on in debug builds only).

- **Links that open the app** (`AndroidManifest.xml`, `src/native/deep-links.ts`):
  `web+stellar:pay?…` opens Pay, `ficha:/p?…` and
  `https://ficha-stellar.vercel.app/p?…` open a custody pay link, `ficha:/r?…`
  and `https://ficha-stellar.vercel.app/r?…` open the receipt, on a
  cold start and while running (same routing as the scanner, `linkRoute`).
  Another Stellar wallet on the phone may also take `web+stellar:` (Android
  asks which app). The https links (`/r` and `/p`) are verified App Links
  (`android:autoVerify="true"`): the site serves
  `/.well-known/assetlinks.json` (from `site/`) naming `app.ficha.wallet`
  and the SHA-256 fingerprint of the key that signs the APK, so Android
  opens Ficha for it without asking. Today that is the debug key of the
  local builds (`~/.android/debug.keystore`, alias `androiddebugkey`); a
  build signed with another key (a release key, another machine's debug
  key) needs its fingerprint added there and the site published:
  `keytool -list -v -keystore <keystore> -alias <alias>` prints it.
  Android checks the file when the app is installed; see the result with
  `$ADB -s $PHONE shell pm get-app-links app.ficha.wallet`
  (`verified`), and ask again with
  `$ADB -s $PHONE shell pm verify-app-links --re-verify app.ficha.wallet`.
  Check a link with
  `$ADB -s $PHONE shell "am start -a android.intent.action.VIEW -d '<link>' app.ficha.wallet"`
  (a pay link opens the Pay form: do not tap Pay unless you mean to pay).

- **Icons**: `npm run android:icons` (`scripts/android-icons.mjs`) turns
  `../brand/ficha-app-icon.svg` into the adaptive-icon VectorDrawable and
  `../brand/png/ficha-app-icon-512x512.png` into the legacy PNGs, and makes the
  splash (brand navy + icon). Re-run it after the brand files change. It uses
  `pngjs`, installed with `qrcode`.
- **Camera**: `CAMERA` is declared in the manifest; the WebView asks for it the
  first time the QR scanner calls `getUserMedia`.
- **No backups**: `allowBackup="false"`, and `res/xml/data_extraction_rules.xml`
  (Android 12+) and `res/xml/backup_rules.xml` exclude all app data from cloud
  backup and device-to-device transfer, so the encrypted vault never leaves the
  phone. A new phone restores the wallet from the words
  (`src/native/android-backup.test.ts` guards this).
- **Battery plugin** (`FichaBattery`, Kotlin, in
  `android/app/src/main/java/app/ficha/wallet/battery/`, registered in
  `MainActivity.java`): BatteryManager `CURRENT_NOW` normalised like
  `../meter.py` (uA vs mA decided by magnitude and sticky; sign learned from
  the charge status so positive = charging; `Integer.MIN_VALUE` = not
  reported), voltage from `ACTION_BATTERY_CHANGED`, level, status, plug type,
  temperature. `getStatus()` returns one reading; the `battery` event fires
  every second while the app is visible and has a listener, and stops in the
  background. Use it through `src/native/battery.ts`
  (`getBatteryReading()`, `watchBattery(cb)`, `useBatteryReading()`); on the
  web they return null / never call back. The normalisation has a JVM test
  that needs no phone: `cd android && JAVA_HOME=... ./gradlew testDebugUnitTest`
  (`CurrentNormalizerTest.kt`, the results `meter.py` gives for the same input).
