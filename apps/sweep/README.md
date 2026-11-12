# Sweep app (Android)

The volunteer app. At a polling unit it takes a precise location, measures the signal on every SIM, uploads a
1.5 MB file over each SIM's mobile data to the probe, signs the result in Android Keystore, and posts it to the
API (or queues it until a connection returns). Contract: [`contracts/api.md`](../../contracts/api.md).

Expo SDK 58 (React Native 0.88, New Architecture, Hermes), TypeScript, **Android only** (iOS cannot read cell
signal metrics). A development build is needed, not Expo Go: the app depends on a local Kotlin module.

## Layout

| Path | What |
| --- | --- |
| `src/protocol/` | Plain TypeScript, no React Native imports: the test-run state machine (`run.ts`), RFC 8785 JCS (`jcs.ts`), SHA-256, signing and request hashes (`sign.ts`), queue + sync (`queue.ts`), registration and erasure (`device.ts`), place check (`geo.ts`), the port interfaces (`ports.ts`) |
| `src/native/` | Real adapters for the ports: `pos-radio`, expo-location, NetInfo, expo-sqlite |
| `src/ui/`, `App.tsx` | Screens: Language & consent, Find your unit, Run test, Result, My tests, About |
| `src/i18n/strings.ts` | English, Hausa, Yoruba, Igbo, Nigerian Pidgin |
| `modules/pos-radio/` | Kotlin Expo module: radio snapshots, cellular binding, probe HTTP, mock check, Keystore key, Play Integrity |
| `plugins/withAbiSplits.js` | Config plugin: per-ABI APKs, no GIF/WebP decoders |
| `__tests__/` | jest (jest-expo) with a fake radio, network, Keystore (real P-256 via `node:crypto`) and API |

Shared types come from `contracts/types.ts` with `import type` (see `src/contracts.ts`).

## Configuration

Set at build time (environment, or `env` in an `eas.json` profile); read in `app.config.ts` into `extra`.

| Variable | Meaning | Default |
| --- | --- | --- |
| `API_BASE` | API root, e.g. `https://<ref>.supabase.co/functions/v1/api` or `https://api.<domain>` | `http://10.0.2.2:54321/functions/v1/api` (emulator → host) |
| `PROBE_BASE` | Probe root, DNS-only host, e.g. `https://probe.<domain>` | `http://10.0.2.2:8080` |
| `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` | Google Cloud project number linked in Play Console. **Empty = dev build**: no Play Integrity call; the token is the marker `dev-build:no-play-integrity`, which the API accepts only with `PLAY_INTEGRITY_MODE=off` and `ALLOW_UNVERIFIED_DEVICES=true`. Must be digits; `production` builds refuse to configure without it. | empty |
| `CONTACT_EMAIL` | About screen contact | `volunteers@example.org` |
| `DPO_CONTACT` | About screen data protection officer (placeholder until appointed) | placeholder text |

The Android package is `ng.proofofsignal.sweep`; the API's `PLAY_PACKAGE_NAME` must match it.
For production set the project number as an EAS environment variable
(`eas env:create --environment production --name PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER --value <n>`).
Release builds block cleartext HTTP, so `API_BASE`/`PROBE_BASE` must be `https://` outside debug builds.

## Run, test, build

```sh
cd apps/sweep
npm ci
npm run typecheck          # tsc --noEmit
npm test                   # jest
npx expo prebuild --platform android --clean --no-install   # generates android/ (git-ignored)
npx expo export --platform android                          # JS bundle only (Hermes bytecode)
npx expo run:android       # dev build on a USB device (needs Android SDK + JDK 17/21)
```

Local release build (needs `ANDROID_HOME` with platform 37, build-tools 37.0.0, NDK 27.1.12297006, CMake 3.22.1):

```sh
cd android && ./gradlew :app:assembleRelease
# -> app/build/outputs/apk/release/app-armeabi-v7a-release.apk, app-arm64-v8a-release.apk
```

EAS (`eas.json`):

| Profile | Output | Notes |
| --- | --- | --- |
| `development` | debug APK with dev client | Play Integrity off, emulator URLs |
| `preview` | release APKs (one per ABI) for sideloading | Staging URLs; Play Integrity off unless set |
| `production` | AAB for Play (`eas build -p android --profile production`) | Needs `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` |

### Size budget (< 15 MB APK)

- R8 minify + resource shrinking (`expo-build-properties`), Hermes bytecode.
- ARM only (`armeabi-v7a`, `arm64-v8a`); no x86. Per-ABI APK splits for sideloading, so each APK holds one copy
  of the native libraries; Play splits AABs itself. `POS_UNIVERSAL_APK=1` disables splitting.
- Native libraries compressed in the APK (`useLegacyPackaging`): smaller download, larger install.
- Measured locally (Expo SDK 58, `assembleRelease`, 12 Nov 2026): `app-arm64-v8a-release.apk` 11.8 MB, `app-armeabi-v7a-release.apk` 11.1 MB.
- No icon font (icons are SVG paths), no GIF/WebP decoders, no map SDK (see below).

The Find screen shows the nearest 5 units as a list plus a tile-free relative plot (you in the centre, units by
bearing and distance). MapLibre was left out deliberately: its native library is several MB per ABI and a tiled
map needs data and RAM that 2 GB phones on metered data do not have. The list is cached for offline use.

## What one run does (`src/protocol/run.ts`)

`idle → locating → place_check → sampling → nonce → (latency → upload)×SIM → sealing → submitting → done`, or `aborted`.

1. Fused location fix ≤ 30 m (expo-location, up to 90 s). A mocked fix aborts (expo-location `mocked` or
   `Location.isMock`/`isFromMockProvider` from `pos-radio`). Outside the payload schema's Nigeria box aborts.
2. Unit with a point: refuse to run beyond 150 m (before spending any data). Unit without a point: the fix is a
   location vote.
3. Five `snapshot()`s 2 s apart, every active subscription (`requestCellInfoUpdate` on API 29+, else
   `getAllCellInfo`, per `createForSubscriptionId`). Registered cell first, then strongest neighbours, max 20 per
   sample so 5 samples fit the schema's 100. Values outside the schema's ranges become `null`. Radio names are
   Android's: `WCDMA` stays `WCDMA` (the API stores it as UMTS). For WCDMA, RSCP goes in `rsrp`, Ec/No in `rsrq`,
   PSC in `pci`, UARFCN in `earfcn`; for GSM, ARFCN in `earfcn`; for NR, NR-ARFCN in `earfcn`, SS-SINR in `rssnr`.
4. `GET /v1/nonce`. No connection (or the request cannot connect) → offline run: `nonce: null`, every SIM
   `upload: {ok: false, err: "no_network"}`, `latency_ms: []`, no probe traffic at all. An API error (e.g.
   `device_quarantined`) aborts instead.
5. Per SIM: `bindCellular` (`requestNetwork` TRANSPORT_CELLULAR + INTERNET with the SIM's subscription
   specifier), 3 × `HEAD {PROBE_BASE}/v1/probe/{nonce}/{slot}`, then `PUT` of 1,572,864 bytes (JPEG SOI/APP0/COM
   header, SecureRandom filler, EOI) through OkHttp bound to that network's socket factory and DNS. Timeout 120 s;
   one retry after 15 s only for transport errors/5xx and only if the nonce's 5-minute window still has room. A
   SIM whose data cannot be brought up (usually: not the data SIM on a single-standby phone) is recorded as
   `ok: false, err: "sim_unbindable"` and is **never** sent over Wi-Fi or the other SIM.
6. Play Integrity token with request hash `base64url(sha256(nonce))` (offline: `device_id + "|" + ts`), then
   `sig` = Keystore `SHA256withECDSA` over UTF-8 JCS of the payload without `sig`.
7. The payload is written to SQLite, then `POST /v1/tests`. Network errors, 5xx and 429 keep it pending; any
   other 4xx marks it failed and it is never resent. Sync runs at start-up, after each run and whenever NetInfo
   reports a connection; the queue key is `payload_sha256`, and the server dedupes on the same hash.

Registration on first launch: Keystore EC P-256 (StrongBox when present, attestation challenge when supported),
`POST /v1/devices` with an integrity token bound to `base64url(sha256(pubkey DER))`. "Delete my data" sends the
signed `DELETE /v1/devices/{id}/data` and clears the local history and queue.

Data cost: about 1.7 MB per SIM per run (1.5 MB upload + HEADs + TLS + API calls).

## Accessibility and languages

48 dp minimum touch targets, an icon and a text label on every action, screen-reader labels and roles, voice
prompts per step (expo-speech; falls back to the English prompt when the phone has no voice for the language),
layouts that wrap and scroll at 200 % font scale. Hausa, Yoruba, Igbo and Pidgin strings are
**machine-drafted and need native-speaker review** before release; the app says so on the consent and About
screens. The methodology text on About is English-only for now.

## Device test matrix

Manual, on real devices with real SIMs (emulators have no cell info). Each row: single and dual SIM, Wi-Fi on
and off, offline (airplane mode, then reconnect to check the queue syncs), 200 % font scale, TalkBack.

| Device class | Example | Android | RAM | Checks |
| --- | --- | --- | --- | --- |
| Entry, Android Go | itel A70 / A05s | 13 Go | 2 GB | 32-bit ARM APK installs; cold start < 5 s; run completes without OOM |
| Entry | Tecno Spark Go / Pop | 12–14 | 2–3 GB | HiOS battery saver does not kill the run; dual-SIM binding |
| Entry | Infinix Smart 7/8 | 12–13 | 2–3 GB | XOS; requestCellInfoUpdate freshness |
| Mid | Samsung Galaxy A05 / A15 | 13–15 | 4 GB | One UI; StrongBox absent path; Play Integrity verdict |
| Old minimum | any API 26–28 phone | 8.0–9 | 2 GB | `getAllCellInfo` path; string network specifier; `isFromMockProvider` |
| Current | Pixel / Samsung on Android 16 | 16 | — | targetSdk 36 behaviour; TelephonyNetworkSpecifier; Location.isMock |

Per device record: APK size installed, peak RAM during upload, whether the non-default-data SIM binds
(DSDA) or reports `sim_unbindable`, and that a mock-location app is rejected.
