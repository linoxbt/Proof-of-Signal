import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from tenacity import wait_none

from pos_watcher.adapters.irev import (
    IrevAdapter, IrevFetcher, IrevSettings, NeedsBrowser, normalise_pu_code, parse_ward_page,
)
from pos_watcher.adapters.replay import ReplayAdapter, dump_timeline, parse_timeline
from pos_watcher.adapters.synthetic import SCENARIOS, scenario_demo

FIXTURE = Path(__file__).parent / "fixtures" / "irev_ward_fixture.json"
NOW = datetime(2026, 12, 12, 16, 0, tzinfo=timezone.utc)


# --- replay ------------------------------------------------------------------

def test_parse_timeline_orders_and_first_sighting_wins():
    ev = parse_timeline([
        '{"pu_code": "99-01-01-002", "uploaded_at": "2026-12-12T15:10:00Z"}',
        '',
        '{"pu_code": "99-01-01-001", "uploaded_at": "2026-12-12T16:10:00+01:00"}',
        '{"pu_code": "99-01-01-002", "uploaded_at": "2026-12-12T15:50:00Z"}',
        '{"pu_code": "99-01-02-001", "cancelled_at": "2026-12-12T15:20:00Z"}',
    ])
    assert [(e.pu_code, e.kind) for e in ev] == [("99-01-01-001", "uploaded"), ("99-01-01-002", "uploaded"),
                                                 ("99-01-02-001", "cancelled")]
    assert ev[0].at == datetime(2026, 12, 12, 15, 10, tzinfo=timezone.utc)


@pytest.mark.parametrize("line", [
    '{"pu_code": "99-01-01-001", "uploaded_at": "2026-12-12T15:10:00Z", "votes": {"A": 1}}',
    '{"pu_code": "99-01-01-001"}',
    '{"pu_code": "991", "uploaded_at": "2026-12-12T15:10:00Z"}',
    '{"pu_code": "99-01-01-001", "uploaded_at": "2026-12-12T15:10:00"}',
])
def test_parse_timeline_refuses_bad_lines(line):
    with pytest.raises(ValueError):
        parse_timeline([line])


async def test_replay_adapter_releases_events_by_time():
    ev = parse_timeline([json.dumps({"pu_code": f"99-01-01-00{i}", "uploaded_at": f"2026-12-12T15:0{i}:00Z"})
                         for i in range(1, 4)])
    a = ReplayAdapter(ev, {"99-01-01-001", "99-01-01-002"})
    assert a.skipped == 1
    assert await a.poll(datetime(2026, 12, 12, 15, 0, tzinfo=timezone.utc)) == []
    assert [e.pu_code for e in await a.poll(datetime(2026, 12, 12, 15, 5, tzinfo=timezone.utc))] == \
        ["99-01-01-001", "99-01-01-002"]
    assert a.exhausted


def test_dump_roundtrip():
    sc = SCENARIOS["outage"]()
    assert parse_timeline(dump_timeline(sc.events).splitlines()) == sorted(sc.events, key=lambda e: (e.at, e.pu_code))


def test_shipped_demo_timeline_matches_generator():
    shipped = Path(__file__).parent.parent / "timelines" / "replay-demo.jsonl"
    assert shipped.read_text() == dump_timeline(scenario_demo().events)
    codes = {e.pu_code for e in parse_timeline(shipped.read_text().splitlines())}
    assert "99-01-01-001" not in codes  # the dark unit
    assert {"99-01-01-002", "99-01-01-003"} <= codes


def test_scenarios_are_synthetic_states_only():
    for name, f in SCENARIOS.items():
        sc = f()
        assert sc.state_code > 37
        assert all(u.pu_code.startswith(f"{sc.state_code:02d}-") for u in sc.units)


# --- IReV: parser ------------------------------------------------------------

def test_parse_ward_fixture():
    obs = parse_ward_page(FIXTURE.read_bytes())
    assert [(o.pu_code, o.state) for o in obs] == [
        ("99-01-01-001", "pending"), ("99-01-01-002", "uploaded"),
        ("99-01-01-003", "uploaded"), ("99-01-01-004", "cancelled")]


def test_parse_refuses_html_and_junk():
    with pytest.raises(NeedsBrowser):
        parse_ward_page(b"<html></html>", "text/html; charset=utf-8")
    with pytest.raises(ValueError):
        parse_ward_page(b"{}")
    with pytest.raises(ValueError):
        parse_ward_page(b"not json")


def test_normalise_pu_code():
    assert normalise_pu_code("28/7/5/12") == "28-07-05-012"
    assert normalise_pu_code("x") is None


# --- IReV: fetching and politeness -------------------------------------------

SETTINGS = IrevSettings(base_url="https://irev.example.invalid", ward_url_template="{base}/e/{election}/w/{ward}",
                        election_ref="E1", contact_email="ops@example.invalid")


def _adapter(handler, wards=None, **kw):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    sleeps = []

    async def fake_sleep(s):
        sleeps.append(s)

    fetcher = IrevFetcher(SETTINGS, client, wait=wait_none(), sleep=fake_sleep)
    wards = wards or {"99-01-01": ["99-01-01-001", "99-01-01-002", "99-01-01-003", "99-01-01-004"]}
    return IrevAdapter(SETTINGS, wards, fetcher=fetcher, rng=random.Random(1), **kw), sleeps


async def _first_round(adapter, pending):
    out = await adapter.poll(NOW, pending)  # schedules the first round
    later = NOW + timedelta(seconds=adapter.interval[0])
    return out + await adapter.poll(later, pending), later


async def test_adapter_reports_first_sighting_with_identifying_headers():
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        return httpx.Response(200, content=FIXTURE.read_bytes(), headers={"content-type": "application/json",
                                                                          "etag": '"v1"'})

    a, _ = _adapter(handler)
    pending = {"99-01-01-001", "99-01-01-002", "99-01-01-003", "99-01-01-004"}
    events, at = await _first_round(a, pending)
    assert [(e.pu_code, e.kind) for e in events] == [("99-01-01-002", "uploaded"), ("99-01-01-003", "uploaded"),
                                                     ("99-01-01-004", "cancelled")]
    assert all(e.at == at and e.page_hash for e in events)
    req = seen[0]
    assert str(req.url) == "https://irev.example.invalid/e/E1/w/99-01-01"
    assert "ops@example.invalid" in req.headers["user-agent"] and "ProofOfSignal" in req.headers["user-agent"]
    # Next poll is 120-300 s later, and is conditional.
    nxt = a.wards["99-01-01"].next_due
    assert timedelta(seconds=120) <= nxt - at <= timedelta(seconds=300)
    assert await a.poll(nxt - timedelta(seconds=1), pending) == []
    assert len(seen) == 1
    events = await a.poll(nxt, pending)
    assert events == [] and seen[1].headers["if-none-match"] == '"v1"'


async def test_unchanged_page_hash_skips_parse():
    calls = {"parse": 0}

    def parser(body, ctype):
        calls["parse"] += 1
        return parse_ward_page(body, ctype)

    a, _ = _adapter(lambda r: httpx.Response(200, content=FIXTURE.read_bytes(),
                                             headers={"content-type": "application/json"}), parser=parser)
    await _first_round(a, {"99-01-01-001"})
    await a.poll(a.wards["99-01-01"].next_due, {"99-01-01-001"})
    assert calls["parse"] == 1


async def test_backoff_honours_retry_after_then_succeeds():
    responses = [httpx.Response(429, headers={"retry-after": "42"}), httpx.Response(503),
                 httpx.Response(200, content=FIXTURE.read_bytes(), headers={"content-type": "application/json"})]
    a, sleeps = _adapter(lambda r: responses.pop(0))
    events, _ = await _first_round(a, {"99-01-01-002"})
    assert [e.pu_code for e in events] == ["99-01-01-002"]
    assert sleeps == [42.0, 0.0]


async def test_persistent_failure_backs_off_ward_and_does_not_raise():
    n = {"calls": 0}

    def handler(r):
        n["calls"] += 1
        return httpx.Response(500)

    a, sleeps = _adapter(handler)
    events, at = await _first_round(a, {"99-01-01-002"})
    assert events == [] and n["calls"] == SETTINGS.max_attempts
    ws = a.wards["99-01-01"]
    assert ws.failures == 1 and ws.next_due - at >= timedelta(seconds=300 * 2 * 0.8)


async def test_only_wards_with_pending_units_are_polled():
    hits = []

    def handler(r):
        hits.append(str(r.url))
        return httpx.Response(200, content=b'{"polling_units": []}', headers={"content-type": "application/json"})

    a, _ = _adapter(handler, wards={"99-01-01": ["99-01-01-001"], "99-01-02": ["99-01-02-001"]})
    await _first_round(a, {"99-01-02-001"})
    assert hits == ["https://irev.example.invalid/e/E1/w/99-01-02"]


async def test_browser_fallback_hook():
    def handler(r):
        return httpx.Response(200, content=b"<html>app shell</html>", headers={"content-type": "text/html"})

    rendered = []

    async def browser(url, ua):
        rendered.append((url, ua))
        return FIXTURE.read_bytes()

    def parser(body, ctype):
        if ctype.startswith("text/html") and b"app shell" in body:
            raise NeedsBrowser()
        return parse_ward_page(body)

    a, _ = _adapter(handler, parser=parser, browser_fetch=browser)
    events, _ = await _first_round(a, {"99-01-01-002"})
    assert [e.pu_code for e in events] == ["99-01-01-002"] and rendered


def test_impolite_interval_refused_and_env_required(monkeypatch):
    with pytest.raises(ValueError):
        IrevAdapter(SETTINGS, {}, poll_interval_s=(30, 60))
    for k in ("IREV_BASE_URL", "IREV_WARD_URL_TEMPLATE", "WATCHER_CONTACT_EMAIL"):
        monkeypatch.delenv(k, raising=False)
    with pytest.raises(RuntimeError):
        IrevSettings.from_env()
