"""Watcher tunables.

The election-night maths reads its tunables only from the frozen
``snapshots.config`` (a copy of ``elections.config`` taken by
``freeze_snapshot``). Keys missing from the frozen config fall back to the
defaults below, which match the migration's column default.

``stall_min_expected`` is in the contract and the column default since
migration 20261113000002; ``tick_s`` is a watcher-only setting.

``stall_min_expected``
    Condition 1 of the stall rule only counts when, at the trailing strong
    upload rate, at least this many strong uploads would have been expected in
    the recent window. Without it the natural thin tail of uploads late in the
    night (0 uploads in 20 minutes after 4 in the previous 30) reads as a
    system stall.
``tick_s``
    Seconds of (simulated) time between ticks.
"""

from __future__ import annotations

from dataclasses import dataclass, fields
from typing import Any, Mapping

CAVEAT = (
    "This system cannot see BVAS faults, flat batteries, late starts, insecurity, "
    "cancelled polls, tower power cuts or congestion on the day. A flag is a request "
    "for human review, not a finding."
)

STALL_BANNER = "Uploads paused system-wide: the cause is not field network coverage"


@dataclass(frozen=True)
class WatcherConfig:
    strong_cut: float = 0.8
    weak_cut: float = 0.4
    stall_window_min: float = 20
    stall_trailing_min: float = 30
    stall_rate_frac: float = 0.1
    stall_pending_frac: float = 0.05
    stall_ratio_diff: float = 0.2
    stall_min_expected: float = 10
    not_measured_interval: float = 0.4
    p_network_plausible: float = 0.6
    p_other_flag: float = 0.6
    neighbour_min: int = 3
    neighbour_cap: int = 5
    prior_other_q: float = 0.05
    neighbour_factor_r: float = 0.3
    s_floor: float = 0.001
    poll_interval_s: tuple[float, float] = (120, 300)
    tick_s: float = 120

    @classmethod
    def from_frozen(cls, cfg: Mapping[str, Any] | None) -> "WatcherConfig":
        cfg = dict(cfg or {})
        kwargs: dict[str, Any] = {}
        for f in fields(cls):
            if f.name not in cfg or cfg[f.name] is None:
                continue
            v = cfg[f.name]
            if f.name == "poll_interval_s":
                lo, hi = (v, v) if isinstance(v, (int, float)) else (v[0], v[-1])
                kwargs[f.name] = (float(lo), float(hi))
            elif f.name in ("neighbour_min", "neighbour_cap"):
                kwargs[f.name] = int(v)
            else:
                kwargs[f.name] = float(v)
        return cls(**kwargs)
