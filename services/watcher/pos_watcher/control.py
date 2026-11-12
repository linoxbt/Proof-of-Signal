"""Runs at most one watcher (live or replay) and reports its status."""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

from . import db
from .adapters.irev import IrevAdapter, IrevSettings
from .adapters.replay import ReplayAdapter, load_timeline
from .clock import RealClock, SimClock
from .runner import Watcher

log = logging.getLogger(__name__)

DEFAULT_TIMELINE_DIR = Path(__file__).resolve().parent.parent / "timelines"
REPLAY_TAIL = timedelta(minutes=30)


def timeline_dirs() -> list[Path]:
    env = os.environ.get("WATCHER_TIMELINE_DIRS")
    dirs = [Path(p) for p in env.split(os.pathsep) if p] if env else [DEFAULT_TIMELINE_DIR]
    return [d.resolve() for d in dirs]


def resolve_timeline(value: str, dirs: list[Path] | None = None) -> Path:
    """A bare name ('replay-demo') or a path inside one of the timeline
    directories. Anything outside them is refused (the endpoint is remote)."""
    dirs = dirs or timeline_dirs()
    candidates = []
    if "/" not in value and os.sep not in value:
        name = value if value.endswith(".jsonl") else value + ".jsonl"
        candidates = [d / name for d in dirs]
    else:
        candidates = [Path(value).resolve()]
    for c in candidates:
        c = c.resolve()
        if any(c.is_relative_to(d) for d in dirs) and c.is_file():
            return c
    raise FileNotFoundError(f"timeline {value!r} not found in {', '.join(map(str, dirs))}")


class Controller:
    def __init__(self, database_url: str):
        self.database_url = database_url
        self.mode: Literal["live", "replay", "idle"] = "idle"
        self.election_id: str | None = None
        self.speed: float | None = None
        self.watcher: Watcher | None = None
        self.task: asyncio.Task | None = None
        self.stop_event: asyncio.Event | None = None
        self.last_error: str | None = None

    async def _launch(self, watcher: Watcher, mode, speed, until=None, on_tick=None) -> None:
        self.watcher, self.mode, self.speed = watcher, mode, speed
        self.election_id = watcher.model.election_id
        self.stop_event = asyncio.Event()
        self.last_error = None
        self.task = asyncio.create_task(self._run(watcher, self.stop_event, until, on_tick))

    async def _run(self, watcher: Watcher, stop: asyncio.Event, until, on_tick=None) -> None:
        try:
            await watcher.run(stop, until, on_tick)
        except Exception as e:  # noqa: BLE001
            log.exception("watcher stopped on error")
            self.last_error = str(e)
        finally:
            if self.watcher is watcher:
                self.mode = "idle"
            close = getattr(watcher.adapter, "aclose", None)
            if close is not None:
                await close()
            await asyncio.to_thread(watcher.conn.close)

    async def stop(self) -> bool:
        if self.task is None or self.task.done():
            self.mode = "idle"
            return False
        self.stop_event.set()
        await self.task
        self.mode = "idle"
        return True

    async def start_replay(self, election_id: str, timeline: str | Path, speed: float, on_tick=None) -> dict:
        if not 1 <= speed <= 60:
            raise ValueError("speed must be between 1 and 60")
        path = timeline if isinstance(timeline, Path) else resolve_timeline(timeline)
        events = load_timeline(path)
        await self.stop()
        conn = await asyncio.to_thread(db.connect, self.database_url)
        try:
            cleared = await asyncio.to_thread(db.reset_replay, conn, election_id)
            model = await asyncio.to_thread(db.load_model, conn, election_id)
        except Exception:
            conn.close()
            raise
        adapter = ReplayAdapter(events, {u.pu_code for u in model.units})
        close = model.polls_close_at
        start = min(close, adapter.first_at or close).replace(second=0, microsecond=0)
        until = max(close, adapter.last_at or close) + REPLAY_TAIL
        watcher = Watcher(conn, model, adapter, SimClock(start, speed))
        await asyncio.to_thread(watcher.load_state)
        await self._launch(watcher, "replay", speed, until, on_tick)
        return {"election_id": election_id, "timeline": str(path), "speed": speed, "events": len(adapter.events),
                "skipped_unknown_units": adapter.skipped, "cleared": cleared,
                "sim_start": start.isoformat(), "sim_end": until.isoformat()}

    async def start_live(self, election_id: str) -> None:
        await self.stop()
        conn = await asyncio.to_thread(db.connect, self.database_url)
        model = await asyncio.to_thread(db.load_model, conn, election_id)
        wards: dict[str, list[str]] = {}
        for u in model.units:
            wards.setdefault(u.ward_key, []).append(u.pu_code)
        adapter = IrevAdapter(IrevSettings.from_env(), wards, model.cfg.poll_interval_s)
        watcher = Watcher(conn, model, adapter, RealClock())
        await asyncio.to_thread(watcher.load_state)
        await self._launch(watcher, "live", 1.0)

    def status(self) -> dict:
        w = self.watcher
        running = self.task is not None and not self.task.done()
        sim_time: datetime | None = None
        if w is not None:
            sim_time = w.clock.now() if running else w.last_tick_at
        iso = lambda d: d.isoformat().replace("+00:00", "Z") if d else None  # noqa: E731
        return {
            "mode": self.mode if running else "idle",
            "election_id": self.election_id,
            "speed": self.speed,
            "sim_time": iso(sim_time),
            "last_tick_at": iso(w.last_tick_at if w else None),
            "stall_active": bool(w and w.open_stall is not None),
        }
