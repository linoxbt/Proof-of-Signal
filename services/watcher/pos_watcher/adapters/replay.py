"""Replay adapter: plays a ``timeline.jsonl`` against a clock.

Each line is ``{"pu_code": "...", "uploaded_at": "<RFC 3339>"}`` or
``{"pu_code": "...", "cancelled_at": "..."}``. Any other field is refused, so
a timeline can never smuggle result content into the watcher.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Iterable

from . import UploadEvent

PU_RE = re.compile(r"^\d{2}-\d{2}-\d{2}-\d{3}$")


def parse_time(s: str) -> datetime:
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError(f"timestamp without offset: {s!r}")
    return dt


def parse_timeline(lines: Iterable[str]) -> list[UploadEvent]:
    events: list[UploadEvent] = []
    seen: set[str] = set()
    for n, raw in enumerate(lines, 1):
        raw = raw.strip()
        if not raw or raw.startswith("#"):
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(f"line {n}: not JSON ({e})") from None
        if not isinstance(obj, dict):
            raise ValueError(f"line {n}: expected an object")
        extra = set(obj) - {"pu_code", "uploaded_at", "cancelled_at"}
        if extra:
            raise ValueError(f"line {n}: unexpected fields {sorted(extra)} (timelines carry times only)")
        pu = obj.get("pu_code")
        if not isinstance(pu, str) or not PU_RE.match(pu):
            raise ValueError(f"line {n}: bad pu_code {pu!r}")
        if ("uploaded_at" in obj) == ("cancelled_at" in obj):
            raise ValueError(f"line {n}: need exactly one of uploaded_at / cancelled_at")
        if pu in seen:
            continue  # first sighting wins, as on the night
        seen.add(pu)
        kind = "uploaded" if "uploaded_at" in obj else "cancelled"
        events.append(UploadEvent(pu, kind, parse_time(obj[f"{kind}_at"])))
    events.sort(key=lambda e: (e.at, e.pu_code))
    return events


def load_timeline(path: str | Path) -> list[UploadEvent]:
    with open(path, encoding="utf-8") as f:
        return parse_timeline(f)


def dump_timeline(events: Iterable[UploadEvent]) -> str:
    out = []
    for e in sorted(events, key=lambda e: (e.at, e.pu_code)):
        ts = e.at.isoformat().replace("+00:00", "Z")
        out.append(json.dumps({"pu_code": e.pu_code, f"{e.kind}_at": ts}))
    return "\n".join(out) + "\n"


class ReplayAdapter:
    def __init__(self, events: list[UploadEvent], units: Iterable[str] | None = None):
        known = set(units) if units is not None else None
        self.events = [e for e in events if known is None or e.pu_code in known]
        self.skipped = len(events) - len(self.events)
        self._i = 0

    @property
    def first_at(self) -> datetime | None:
        return self.events[0].at if self.events else None

    @property
    def last_at(self) -> datetime | None:
        return self.events[-1].at if self.events else None

    @property
    def exhausted(self) -> bool:
        return self._i >= len(self.events)

    async def poll(self, now: datetime, pending: Iterable[str] = ()) -> list[UploadEvent]:
        out = []
        while self._i < len(self.events) and self.events[self._i].at <= now:
            out.append(self.events[self._i])
            self._i += 1
        return out
