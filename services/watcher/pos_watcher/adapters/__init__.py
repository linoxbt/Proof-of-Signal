"""Sources of 'unit first showed as uploaded' events.

Every adapter yields only (pu_code, uploaded|cancelled, time). None of them
reads, keeps or forwards result-sheet contents or vote figures.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable, Literal, Protocol


@dataclass(frozen=True)
class UploadEvent:
    pu_code: str
    kind: Literal["uploaded", "cancelled"]
    at: datetime
    page_hash: str | None = None


class Adapter(Protocol):
    async def poll(self, now: datetime, pending: Iterable[str]) -> list[UploadEvent]:
        """Events observed up to ``now`` that were not returned before."""
        ...
