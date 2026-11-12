"""Live IReV adapter (pluggable; the portal's request shape is UNVERIFIED).

What is known: IReV publishes, per polling unit, an image of the result sheet
once BVAS uploads it. What is NOT known to this code: the URL scheme, whether
ward listings are JSON or HTML, authentication, and how cancelled polls show.
So this module keeps the parts that depend on the portal behind three seams:

* ``IrevSettings.ward_url_template`` - where a ward's listing lives. There is
  no default: nothing is fetched until an operator sets ``IREV_BASE_URL`` and
  ``IREV_WARD_URL_TEMPLATE`` from the real, documented endpoint.
* ``parse_ward_page`` - turns one listing into (pu_code, state) observations.
  It is written against ``tests/fixtures/irev_ward_fixture.json``, a format WE
  defined. **Replace it once the real endpoint shape is known.** It must keep
  the rule: read only whether a unit has a document and nothing about the
  document itself (no image URL is followed, no figures are read).
* ``browser_fetch`` - an optional Playwright hook for a listing that only
  renders in a browser. Off unless explicitly passed.

Politeness: one request per ward every ``poll_interval_s`` (120-300 s) with
jitter, at most ``concurrency`` requests in flight, only wards that still have
pending units, conditional requests (ETag / Last-Modified), a page-hash cache
that skips parsing unchanged pages, exponential backoff with jitter on
429 / 5xx / transport errors (honouring ``Retry-After``), and a User-Agent
that names the project and a contact email (``WATCHER_CONTACT_EMAIL``).
The adapter never probes or crawls anything beyond the configured ward URLs.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Awaitable, Callable, Iterable, Literal, Mapping

import httpx
from tenacity import AsyncRetrying, RetryCallState, retry_if_exception, stop_after_attempt, wait_exponential_jitter

from .. import __version__
from . import UploadEvent

log = logging.getLogger(__name__)


class NeedsBrowser(Exception):
    """The listing did not contain data without running scripts."""


class RetryableStatus(Exception):
    def __init__(self, status: int, retry_after: float | None):
        super().__init__(f"HTTP {status}")
        self.status, self.retry_after = status, retry_after


@dataclass(frozen=True)
class PortalObservation:
    pu_code: str
    state: Literal["pending", "uploaded", "cancelled"]


@dataclass(frozen=True)
class IrevSettings:
    base_url: str
    ward_url_template: str  # e.g. "{base}/elections/{election}/wards/{ward}" (placeholder, unverified)
    election_ref: str
    contact_email: str
    concurrency: int = 2
    timeout_s: float = 20.0
    max_attempts: int = 4
    max_backoff_s: float = 1800.0

    @classmethod
    def from_env(cls, election_ref: str | None = None) -> "IrevSettings":
        missing = [k for k in ("IREV_BASE_URL", "IREV_WARD_URL_TEMPLATE", "WATCHER_CONTACT_EMAIL")
                   if not os.environ.get(k)]
        if missing:
            raise RuntimeError("live IReV polling needs " + ", ".join(missing))
        return cls(
            base_url=os.environ["IREV_BASE_URL"].rstrip("/"),
            ward_url_template=os.environ["IREV_WARD_URL_TEMPLATE"],
            election_ref=election_ref or os.environ.get("IREV_ELECTION_REF", ""),
            contact_email=os.environ["WATCHER_CONTACT_EMAIL"],
            concurrency=int(os.environ.get("IREV_CONCURRENCY", "2")),
        )

    @property
    def user_agent(self) -> str:
        return (f"ProofOfSignal-Watcher/{__version__} (civic election-night monitor; "
                f"upload times only; contact: {self.contact_email})")

    def ward_url(self, ward_ref: str) -> str:
        return self.ward_url_template.format(base=self.base_url, election=self.election_ref, ward=ward_ref)


# ---------------------------------------------------------------------------
# Parsing (isolated; written against OUR fixture format, not the real portal)
# ---------------------------------------------------------------------------

_PU_PARTS = re.compile(r"^\s*(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,3})\s*$")


def normalise_pu_code(raw: str) -> str | None:
    """'28/7/5/12' or '28-07-05-012' -> '28-07-05-012'."""
    m = _PU_PARTS.match(str(raw))
    if not m:
        return None
    s, l, w, u = m.groups()
    return f"{int(s):02d}-{int(l):02d}-{int(w):02d}-{int(u):03d}"


def parse_ward_page(body: bytes, content_type: str = "application/json") -> list[PortalObservation]:
    """Parse one ward listing. NEEDS THE REAL ENDPOINT SHAPE.

    Fixture format (ours)::

        {"ward": "...", "polling_units": [
            {"pu_code": "99-01-01-001", "status": "uploaded" | "pending" | "cancelled",
             "documents": [{"id": "...", "uploaded_at": "..."}]}, ...]}

    A unit counts as uploaded when ``status`` says so or it lists at least one
    document. Only the presence of a document is read; document fields
    (links, images, any figures) are never touched.
    """
    if "html" in content_type.lower():
        raise NeedsBrowser("HTML listing; a parser for the real page is required")
    try:
        doc = json.loads(body)
    except (ValueError, UnicodeDecodeError) as e:
        raise ValueError(f"ward listing is not JSON: {e}") from None
    rows = doc.get("polling_units") if isinstance(doc, dict) else None
    if not isinstance(rows, list):
        raise ValueError("ward listing has no polling_units list")
    out: list[PortalObservation] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        code = normalise_pu_code(row.get("pu_code", ""))
        if code is None:
            continue
        status = str(row.get("status", "")).lower()
        docs = row.get("documents")
        has_doc = isinstance(docs, list) and len(docs) > 0
        if status == "cancelled":
            state = "cancelled"
        elif status == "uploaded" or has_doc:
            state = "uploaded"
        else:
            state = "pending"
        out.append(PortalObservation(code, state))
    return out


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FetchResult:
    status: int
    body: bytes
    content_type: str
    etag: str | None = None
    last_modified: str | None = None


def _retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            dt = parsedate_to_datetime(value)
            return max(0.0, (dt - datetime.now(dt.tzinfo)).total_seconds())
        except (TypeError, ValueError):
            return None


def _retryable(exc: BaseException) -> bool:
    return isinstance(exc, (RetryableStatus, httpx.TransportError))


class IrevFetcher:
    """httpx client with backoff (tenacity) and conditional requests."""

    def __init__(self, settings: IrevSettings, client: httpx.AsyncClient | None = None,
                 wait=None, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep):
        self.settings = settings
        self.client = client or httpx.AsyncClient(timeout=settings.timeout_s, follow_redirects=False)
        self._wait = wait or wait_exponential_jitter(initial=5, max=300, jitter=5)
        self._sleep = sleep

    def _wait_with_retry_after(self, rs: RetryCallState) -> float:
        base = self._wait(rs)
        exc = rs.outcome.exception() if rs.outcome else None
        if isinstance(exc, RetryableStatus) and exc.retry_after is not None:
            return max(base, exc.retry_after)
        return base

    async def fetch(self, url: str, etag: str | None = None, last_modified: str | None = None) -> FetchResult:
        headers = {"User-Agent": self.settings.user_agent, "Accept": "application/json, text/html;q=0.5",
                   "From": self.settings.contact_email}
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        async for attempt in AsyncRetrying(stop=stop_after_attempt(self.settings.max_attempts),
                                           wait=self._wait_with_retry_after, sleep=self._sleep,
                                           retry=retry_if_exception(_retryable), reraise=True):
            with attempt:
                r = await self.client.get(url, headers=headers)
                if r.status_code == 429 or r.status_code >= 500:
                    raise RetryableStatus(r.status_code, _retry_after(r.headers.get("retry-after")))
                return FetchResult(r.status_code, r.content, r.headers.get("content-type", ""),
                                   r.headers.get("etag"), r.headers.get("last-modified"))
        raise AssertionError("unreachable")

    async def aclose(self) -> None:
        await self.client.aclose()


BrowserFetch = Callable[[str, str], Awaitable[bytes]]


async def playwright_fetch(url: str, user_agent: str) -> bytes:
    """Optional fallback: render the listing in headless Chromium and return the
    page HTML. Needs ``pip install pos-watcher[browser]`` and
    ``playwright install chromium``. A matching HTML parser must replace
    ``parse_ward_page`` before this is useful."""
    from playwright.async_api import async_playwright  # lazy, optional

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        try:
            page = await browser.new_page(user_agent=user_agent)
            await page.goto(url, wait_until="networkidle", timeout=60_000)
            return (await page.content()).encode()
        finally:
            await browser.close()


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------

@dataclass
class _WardState:
    ref: str
    units: frozenset[str]
    next_due: datetime | None = None
    failures: int = 0
    page_hash: str | None = None
    etag: str | None = None
    last_modified: str | None = None
    observed: dict[str, str] = field(default_factory=dict)


class IrevAdapter:
    """Polls ward listings that still have pending units and turns the first
    sighting of a document into an ``uploaded`` event (time = when the
    watcher first saw it)."""

    def __init__(self, settings: IrevSettings, wards: Mapping[str, Iterable[str]],
                 poll_interval_s: tuple[float, float] = (120, 300),
                 fetcher: IrevFetcher | None = None,
                 parser: Callable[[bytes, str], list[PortalObservation]] = parse_ward_page,
                 browser_fetch: BrowserFetch | None = None,
                 ward_refs: Mapping[str, str] | None = None,
                 rng: random.Random | None = None):
        lo, hi = poll_interval_s
        if lo < 120:
            raise ValueError("poll interval below 120 s is not polite")
        self.settings, self.interval = settings, (lo, max(lo, hi))
        self.fetcher = fetcher or IrevFetcher(settings)
        self.parser, self.browser_fetch = parser, browser_fetch
        self.rng = rng or random.Random()
        refs = ward_refs or {}
        self.wards = {wk: _WardState(refs.get(wk, wk), frozenset(us)) for wk, us in wards.items()}
        self._reported: set[str] = set()

    def _schedule(self, ws: _WardState, now: datetime) -> None:
        lo, hi = self.interval
        delay = self.rng.uniform(lo, hi)
        if ws.failures:
            delay = min(self.settings.max_backoff_s, hi * 2 ** ws.failures) * self.rng.uniform(0.8, 1.2)
        ws.next_due = now + timedelta(seconds=delay)

    async def _poll_ward(self, ws: _WardState, now: datetime, pending: set[str]) -> list[UploadEvent]:
        url = self.settings.ward_url(ws.ref)
        try:
            res = await self.fetcher.fetch(url, ws.etag, ws.last_modified)
        except Exception as e:  # noqa: BLE001 - one ward failing must not stop the night
            ws.failures += 1
            log.warning("ward %s: fetch failed (%s), backing off", ws.ref, e)
            self._schedule(ws, now)
            return []
        ws.failures = 0
        self._schedule(ws, now)
        if res.status == 304:
            return []
        if res.status != 200:
            log.warning("ward %s: HTTP %s", ws.ref, res.status)
            return []
        ws.etag, ws.last_modified = res.etag, res.last_modified
        body, ctype = res.body, res.content_type
        h = hashlib.sha256(body).hexdigest()
        if h == ws.page_hash:
            return []
        try:
            obs = self.parser(body, ctype)
        except NeedsBrowser:
            if self.browser_fetch is None:
                log.error("ward %s: listing needs a browser and no fallback is configured", ws.ref)
                return []
            body = await self.browser_fetch(url, self.settings.user_agent)
            h = hashlib.sha256(body).hexdigest()
            obs = self.parser(body, "text/html+rendered")
        except ValueError as e:
            log.error("ward %s: unparseable listing (%s)", ws.ref, e)
            return []
        ws.page_hash = h
        events = []
        for o in obs:
            if (o.pu_code not in ws.units or o.pu_code not in pending or o.state == "pending"
                    or o.pu_code in self._reported):
                continue
            self._reported.add(o.pu_code)
            events.append(UploadEvent(o.pu_code, o.state, now, h))
        return events

    async def poll(self, now: datetime, pending: Iterable[str]) -> list[UploadEvent]:
        pending = set(pending)
        for ws in self.wards.values():
            if ws.next_due is None:  # spread the first round over one interval, no burst
                ws.next_due = now + timedelta(seconds=self.rng.uniform(0, self.interval[0]))
        due = [ws for ws in self.wards.values() if ws.units & pending and ws.next_due <= now]
        sem = asyncio.Semaphore(self.settings.concurrency)

        async def run(ws: _WardState) -> list[UploadEvent]:
            async with sem:
                return await self._poll_ward(ws, now, pending)

        out: list[UploadEvent] = []
        for evs in await asyncio.gather(*(run(ws) for ws in due)):
            out.extend(evs)
        return out

    async def aclose(self) -> None:
        await self.fetcher.aclose()
