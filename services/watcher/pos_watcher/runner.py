"""Tick loop: adapter -> irev_status -> engine.evaluate -> stall_events + flags."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

import psycopg

from . import db
from .adapters import Adapter
from .clock import Clock
from .engine import ElectionModel, OpenStall, TickOutcome, evaluate

log = logging.getLogger(__name__)


@dataclass
class TickReport:
    at: datetime
    t_min: float
    new_events: int
    stall_open: bool
    stall_action: str
    flags: dict[str, int]
    outcome: TickOutcome


class Watcher:
    """One election. State in memory mirrors the database and is reloaded on
    start, so a restart resumes where it left off."""

    def __init__(self, conn: psycopg.Connection, model: ElectionModel, adapter: Adapter, clock: Clock):
        self.conn, self.model, self.adapter, self.clock = conn, model, adapter, clock
        self.uploaded: dict[str, datetime] = {}
        self.cancelled: set[str] = set()
        self.open_stall: OpenStall | None = None
        self.last_tick_at: datetime | None = None
        self.ticks = 0

    def load_state(self) -> None:
        db.ensure_irev_rows(self.conn, self.model.election_id, [u.pu_code for u in self.model.units],
                            self.clock.now())
        self.uploaded, self.cancelled = db.read_irev(self.conn, self.model.election_id)
        self.open_stall = db.read_open_stall(self.conn, self.model.election_id)

    @property
    def pending(self) -> set[str]:
        return {u.pu_code for u in self.model.units
                if u.pu_code not in self.uploaded and u.pu_code not in self.cancelled}

    def _apply(self, now: datetime, events) -> tuple[list, TickOutcome, dict]:
        applied = db.record_events(self.conn, self.model.election_id, events, now)
        for ev in applied:
            if ev.kind == "uploaded":
                self.uploaded[ev.pu_code] = ev.at
            else:
                self.cancelled.add(ev.pu_code)
        outcome = evaluate(self.model, now, self.uploaded, self.cancelled, self.open_stall)
        if outcome.metrics is not None:
            self.open_stall = db.apply_stall(self.conn, self.model.election_id, outcome, now, self.open_stall)
        counts = db.apply_flags(self.conn, self.model, outcome) if outcome.results else {}
        return applied, outcome, counts

    async def tick(self) -> TickReport:
        now = self.clock.now()
        events = await self.adapter.poll(now, self.pending)
        applied, outcome, counts = await asyncio.to_thread(self._apply, now, events)
        self.last_tick_at, self.ticks = now, self.ticks + 1
        if outcome.stall_action in ("open", "close"):
            log.info("%s t=%.0f min: stall %s", self.model.election_id, outcome.t_min, outcome.stall_action)
        return TickReport(now, outcome.t_min, len(applied), outcome.stall_open, outcome.stall_action, counts,
                          outcome)

    async def run(self, stop: asyncio.Event, until: datetime | None = None, on_tick=None) -> None:
        """Ticks every ``tick_s`` of clock time, aligned to the start so slow
        ticks do not drift the schedule."""
        step = timedelta(seconds=self.model.cfg.tick_s)
        target = self.clock.now()
        while not stop.is_set():
            report = await self.tick()
            if on_tick is not None:
                on_tick(report)
            if until is not None and report.at >= until:
                break
            target += step
            wait = (target - self.clock.now()).total_seconds()
            if wait > 0:
                sleeper = asyncio.ensure_future(self.clock.sleep(wait))
                stopper = asyncio.ensure_future(stop.wait())
                done, pend = await asyncio.wait({sleeper, stopper}, return_when=asyncio.FIRST_COMPLETED)
                for p in pend:
                    p.cancel()
