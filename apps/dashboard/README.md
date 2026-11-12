# Dashboard: Excuse Meter and Transmission Risk Register

Next.js (App Router, TypeScript) + Tailwind + shadcn/ui-style components, MapLibre GL JS with a deck.gl overlay
(`ScatterplotLayer`, `H3HexagonLayer`, `IconLayer` via `@deck.gl/mapbox`), Protomaps PMTiles basemap,
next-intl (English, Hausa, Yoruba, Igbo, Nigerian Pidgin), Supabase Auth magic links for reviewers,
client-side PDF export with `@react-pdf/renderer`. Standalone npm project: run everything from this folder.

It builds against [`contracts/api.md`](../../contracts/api.md) and imports the shared types with
`import type` from `contracts/types.ts`.

## Pages

| Path | Who | What |
| --- | --- | --- |
| `/` | public | Coverage map: units as dots or H3 cells coloured by best-network upload chance, measured/predicted filter, per-network filter, PU search, sweep progress by LGA |
| `/night` | public | Election night: upload progress per state, system-stall banner, units by public bucket (icon + word, never red) |
| `/review` | reviewers | Queue of `UNEXPLAINED_DELAY` and `WATCH` flags, full evidence card, confirm / explained (reason required) / dismiss, two-person rule state |
| `/pu/[code]` | public (+ flag for reviewers) | Per-network chance with interval, test history counts, neighbour map |
| `/register` | INEC, telcos, CSOs | Transmission Risk Register: ranked, filterable, CSV (from the API) and PDF (client-side) |
| `/method` | public | Plain-language method, limits, model card, frozen snapshot hashes, daily audit roots |

## Environment variables

All are `NEXT_PUBLIC_*` and inlined at build time.

| Variable | Required | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_API_BASE` | live | API base, e.g. `https://<ref>.supabase.co/functions/v1/api` or `https://api.<domain>` (no trailing `/v1`) |
| `NEXT_PUBLIC_SUPABASE_URL` | reviewers | Supabase project URL, for magic-link sign-in |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | reviewers | Supabase anon (publishable) key |
| `NEXT_PUBLIC_PMTILES_URL` | no | Protomaps `.pmtiles` basemap URL (self-hosted, e.g. R2). Unset: plain background, no tile server at all |
| `NEXT_PUBLIC_BASEMAP_GLYPHS_URL` | no | Self-hosted glyphs (`…/{fontstack}/{range}.pbf`) to enable basemap labels; unset = no labels, no third-party fonts |
| `NEXT_PUBLIC_DEFAULT_STATE` | no | INEC state code to open the coverage map and register on (default 99) |
| `NEXT_PUBLIC_DEMO_MODE` | no | `true` forces demo mode (see below) |

Reviewers sign in with an email magic link (`shouldCreateUser: false`, so accounts must be provisioned). Add
`https://<dashboard-domain>/review` to the Supabase Auth redirect URLs, and set the API's `DASHBOARD_ORIGIN` to the
dashboard origin so `POST /v1/flags/{id}/review` passes CORS.

## Demo mode

| Build | `NEXT_PUBLIC_API_BASE` | `NEXT_PUBLIC_DEMO_MODE` | Mode |
| --- | --- | --- | --- |
| any | any | `true` | demo |
| any | set | not `true` | live |
| `next dev` | unset | not `true` | demo |
| `next build` | unset | not `true` | **unconfigured**: a banner says the API is not set; no synthetic data is shown |

So demo mode is never on in a production build unless explicitly enabled. In demo mode every page carries a
"Synthetic demo data" banner. The data (`src/lib/demo/fixtures.ts`) is generated from a fixed seed for state 99
(which does not exist), includes the five units of `supabase/seed.sql`, and is served by a fake transport that
answers the same URLs with the same JSON shapes as the API (`src/lib/demo/transport.ts`). Extras:

- A night timeline (polls close, +30, +60, +95, +140 min) to step through: the system stall is active at +95,
  and at +140 a measured, strong unit whose ward has uploaded is flagged `UNEXPLAINED_DELAY`. The night classes
  are computed with the watcher maths from the contract. One demo-only deviation: classification starts at
  +62 min (the contract starts at t = 0, which would mark almost every unit "needs review" at polls close).
- A fake reviewer session with two reviewers (A and B) so the two-person rule can be exercised. Reviews live in
  memory in the browser tab.
- `?step=0..4` on `/night` and `/review` jumps to a timeline step.

## Run

```sh
npm install          # also copies the MapLibre worker into public/vendor/
npm run dev          # http://localhost:3100, demo mode
npm run build && npm start
NEXT_PUBLIC_DEMO_MODE=true npm run build   # a production build that shows the demo
```

## Checks

```sh
npm run typecheck    # tsc --noEmit
npm run lint         # eslint (next core-web-vitals + typescript)
npm test             # vitest: API client, demo transport, bucket mapping, formatting, CSV/PDF export, i18n, wording
npm run test:e2e     # Playwright smoke test against the dev server in demo mode (no console errors, review flow)
npm run screenshots  # needs a running server on :3100; writes screenshots/*.png and fails on console errors
```

The wording test fails if the banned accusatory words appear in messages, source or the built output (run it
after `npm run build` to include `.next`). Playwright uses `/opt/pw-browsers/chromium` when it exists, or
`PW_CHROMIUM_PATH`; otherwise Playwright's own browser (`npx playwright install chromium`).

## Deploy to Vercel

1. New project from this repo, **Root Directory** `apps/dashboard`, framework Next.js. Keep "Include files
   outside the root directory" on: `contracts/types.ts` is needed for the type check.
2. Install command `npm ci`, build command `npm run build` (the defaults).
3. Set the environment variables above for Production (and Preview). Leave `NEXT_PUBLIC_DEMO_MODE` unset in
   Production; set it to `true` on a separate demo project if you want a public demo.
4. Add the Vercel domain to the Supabase Auth redirect URLs and to the API's `DASHBOARD_ORIGIN`.

## Design rules enforced in code

- Labels: "network failure plausible", "needs review", "not enough tests". Every bucket has a distinct hue, a
  distinct glyph and a word (`src/lib/buckets.ts`); no red anywhere (unit-tested).
- Every probability is shown with its interval and test count (`formatEstimate`, `<Estimate>`). The
  per-network values in `/v1/map/coverage` carry no interval, so the map shows only their band word and sends
  people to the unit page for the numbers.
- No vote figures anywhere. Public pages never show flag class names (only the public bucket).
- Mobile-first, 48 px touch targets, map always paired with a list (and a text fallback without WebGL).

## Translations

`messages/en.json` is the source. **`ha.json` (Hausa), `yo.json` (Yoruba), `ig.json` (Igbo) and `pcm.json`
(Nigerian Pidgin) are machine-drafted and need native-speaker review** before public use; the footer says so on
every non-English page. Any key missing from a translation falls back to English, and a unit test checks that
every locale has the same keys and ICU placeholders. The PDF export is English-only because the built-in PDF
font (Helvetica) lacks Yoruba and Hausa diacritics.
