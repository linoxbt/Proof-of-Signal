"""Clocks. Live mode uses wall time; replay runs simulated time at 1x-60x;
tests step a manual clock so a four-hour night runs in seconds."""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone
from typing import Protocol


class Clock(Protocol):
    def now(self) -> datetime: ...
    async def sleep(self, sim_seconds: float) -> None: ...


class RealClock:
    def now(self) -> datetime:
        return datetime.now(timezone.utc)

    async def sleep(self, sim_seconds: float) -> None:
        await asyncio.sleep(sim_seconds)


class SimClock:
    """Simulated time starting at ``start`` and running ``speed`` times faster
    than the wall clock."""

    def __init__(self, start: datetime, speed: float = 1.0, monotonic=time.monotonic):
        if not 1 <= speed <= 60:
            raise ValueError("speed must be between 1 and 60")
        self.start, self.speed, self._mono = start, float(speed), monotonic
        self._t0 = monotonic()

    def now(self) -> datetime:
        return self.start + timedelta(seconds=(self._mono() - self._t0) * self.speed)

    async def sleep(self, sim_seconds: float) -> None:
        await asyncio.sleep(max(0.0, sim_seconds) / self.speed)


class ManualClock:
    def __init__(self, start: datetime):
        self._now = start

    def now(self) -> datetime:
        return self._now

    def advance(self, seconds: float) -> datetime:
        self._now += timedelta(seconds=seconds)
        return self._now

    async def sleep(self, sim_seconds: float) -> None:
        self.advance(sim_seconds)
        await asyncio.sleep(0)
