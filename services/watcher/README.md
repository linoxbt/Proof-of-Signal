# Election-night watcher (`pos-watcher`, Python 3.12+)

Records when each polling unit's result **first shows** as uploaded on IReV.
Each tick (every 2 minutes) it decides whether a missing upload is explained
by the network, by a system-wide stall, or by neither. It never reads, stores
or forwards result-sheet contents or vote figures. Timelines refuse any field
other than `pu_code`, `uploaded_at` and `cancelled_at`, and the IReV parser
only reads whether a unit lists a document.

The maths reads only `frozen_predictions` for the election's `snapshot_id`
and the frozen `snapshots.config`. It never reads `predictions` or
`coverage_*`. The watcher writes `irev_status`, `stall_events` and `flags`
(including `resolved_at`).

## Layout

| Path | What |
| --- | --- |
| `pos_watcher/engine.py` | Pure maths: best-carrier p, strata, S(t), neighbours (ward or shared registered cell), three-cause posterior, stall detector, classifier, evidence card |
| `pos_watcher/config.py` | Tunables from the frozen config, plus the caveat text |
| `pos_watcher/clock.py` | `RealClock`, `SimClock` (1x-60x), `ManualClock` (tests) |
| `pos_watcher/adapters/replay.py` | `timeline.jsonl` reader and replay adapter |
| `pos_watcher/adapters/irev.py` | Live IReV adapter (see below) |
| `pos_watcher/adapters/synthetic.py` | Synthetic nights: `stall`, `outage`, `holdout`, `demo` |
| `pos_watcher/db.py`, `runner.py`, `control.py`, `app.py`, `cli.py` | Postgres I/O, tick loop, controller, FastAPI, CLI |
| `pos_watcher/setup.py` | Installs a synthetic scenario: units, a synthetic model version, a replay election, then `freeze_snapshot()` |
| `timelines/replay-demo.jsonl` | Demo timeline for the seeded `replay-demo` election |

## Run

```sh
cd services/watcher
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
export DATABASE_URL=$(PGDEV_PORT=54333 ../../scripts/db-dev.sh start | sed 's/^DATABASE_URL=//')

.venv/bin/pos-watcher demo-setup        # 315 synthetic state-99 units + freeze for replay-demo (idempotent)
.venv/bin/pos-watcher replay --election replay-demo --timeline replay-demo --speed 60
.venv/bin/pos-watcher generate-timeline --scenario stall|outage|holdout [--out f.jsonl] [--setup-db] [--meta]
WATCHER_ADMIN_TOKEN=... .venv/bin/pos-watcher serve [--port 8090] [--live-election ID]
.venv/bin/pytest -s                     # tests; DB tests clone pos_dev into a throwaway database
```

Control API (bearer `WATCHER_ADMIN_TOKEN`; an empty token locks every endpoint): `GET /healthz`,
`GET /status`, `POST /replay/start {"election_id","timeline","speed"}` and `POST /replay/stop`.
`timeline` is a name or path inside `WATCHER_TIMELINE_DIRS` (default `timelines/`). Replay only works
on elections with `is_replay = true`. It clears that election's `irev_status`, `stall_events` and
unreviewed flags first. Reviewed flags are never deleted, and the watcher never changes them except
to set `resolved_at`.

### Demo story (`replay-demo`, polls close 14:30Z)

Uploads flow from about 14:55. Everything freezes from 15:50 to 17:00, and the stall opens at
about 16:08. Uploads then resume and the stall closes at about 17:04. *Demo Primary School I*
(`99-01-01-001`: strong, measured) stays dark while its Ward A neighbours upload. It becomes
`UNEXPLAINED_DELAY` once S(t) falls, at about 17:10. The demo adds 315 units to `seed.sql`'s five:
codes `99-0x-xx-xxx` named "Synthetic PU ...", with `location_desc` saying they are not real.
Model version `synthetic-demo-1` is never `is_current`.

## Live IReV adapter: the request shape is unverified

`adapters/irev.py` fetches nothing until an operator sets `IREV_BASE_URL`, `IREV_WARD_URL_TEMPLATE`
(e.g. `{base}/.../{election}/.../{ward}`), `IREV_ELECTION_REF` and `WATCHER_CONTACT_EMAIL`
(used in the User-Agent and `From`). The adapter:

- polls one ward listing every 120-300 s with jitter, and only wards with pending units;
- sends at most 2 requests at a time and makes conditional requests (ETag/Last-Modified);
- caches page hashes, so an unchanged page is not parsed again;
- backs off with tenacity (exponential with jitter, honouring `Retry-After`), then backs the ward
  off for up to 30 minutes.

`parse_ward_page()` is written against **our own** fixture (`tests/fixtures/irev_ward_fixture.json`).
Replace it once the real endpoint shape is known. A Playwright fallback (`playwright_fetch`, extra
`[browser]`) can be passed as `browser_fetch`. Nothing here has been run against INEC systems.

## Deviations from contracts/api.md (follow the intent, noted here)

1. **Stall close.** The contract says a stall closes "when condition 1 stops holding". During a
   long freeze, though, the trailing window empties too, and `0 < 0.1 × 0` is false. Read literally,
   a 2-hour freeze would close after about 50 minutes. Instead, an open stall is judged against the
   strong rate recorded when it opened (`baseline_strong_rate` in `stall_events.evidence`). It also
   closes if the strong backlog drains.
2. **Condition 2** needs both the overall pending share and the strong-stratum pending share to be
   above 0.05. Without the strong-stratum check, a quiet tail where 95% or more of strong units are
   already in opened false stalls in 3 of 20 seeds. Those stalls never closed, and they turned
   held-back units into HELD.
3. **`stall_min_expected` = 10** (not in the frozen config, watcher default). Condition 1 only counts
   when at least 10 strong uploads would have been expected in the recent window at the trailing rate.
4. Evidence: `n_devices` and `n_evenings` are the maximum over carriers, and `n_tests` is the sum.
   `neighbours_uploaded` is the uncapped count, while `m` in the maths is capped at 5. `neighbours`
   lists up to 10 uploaded neighbours, nearest first. `minutes_pending` equals `minutes_since_close`.
5. Units with no frozen prediction get p 0.5, interval [0, 1] and are unmeasured, so they read
   `NOT_MEASURED`. They are left out of the strata.
6. Sensitivity: with q = 0.05, a measured strong unit only reaches p_other ≥ 0.6 when S(t) ≲ 0.035,
   that is, once at least 96.5% of strong units are in. In test (c) the held units sit at
   p_other ≈ 0.63.
