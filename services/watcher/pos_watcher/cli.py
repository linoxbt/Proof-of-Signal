"""pos-watcher command line."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from collections import Counter
from pathlib import Path

from .adapters.replay import dump_timeline
from .adapters.synthetic import SCENARIOS


def _db_url(args) -> str:
    url = args.database_url or os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL is not set (try: PGDEV_PORT=54333 scripts/db-dev.sh start)")
    return url


def cmd_generate(args) -> None:
    sc = SCENARIOS[args.scenario](args.seed) if args.seed is not None else SCENARIOS[args.scenario]()
    text = dump_timeline(sc.events)
    if args.out == "-":
        sys.stdout.write(text)
    else:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"wrote {len(sc.events)} events for {len(sc.units)} units to {args.out}", file=sys.stderr)
    if args.setup_db:
        from . import db
        from .setup import install_scenario
        with db.connect(_db_url(args)) as conn:
            snap = install_scenario(conn, sc)
        print(f"installed election {sc.election_id} (state {sc.state_code}), snapshot {snap}", file=sys.stderr)
    if args.meta:
        print(json.dumps({"election_id": sc.election_id, **sc.meta}), file=sys.stderr)


def cmd_demo_setup(args) -> None:
    from . import db
    from .adapters.synthetic import scenario_demo
    from .setup import install_scenario
    sc = scenario_demo()
    with db.connect(_db_url(args)) as conn:
        snap = install_scenario(conn, sc)
    print(f"replay-demo: {len(sc.units)} units in state 99 ({len(sc.units) - len(sc.existing_units)} synthetic "
          f"added), model {sc.model_version}, snapshot {snap}")
    if args.write_timeline:
        Path(args.write_timeline).write_text(dump_timeline(sc.events), encoding="utf-8")
        print(f"timeline: {args.write_timeline} ({len(sc.events)} events)")


def cmd_replay(args) -> None:
    from .control import Controller, resolve_timeline

    async def main() -> None:
        ctl = Controller(_db_url(args))
        p = Path(args.timeline)
        path = p.resolve() if p.is_file() else resolve_timeline(args.timeline)
        state = {"stall": None}

        def on_tick(r):
            w = ctl.watcher
            if r.stall_open != state["stall"] or w.ticks % args.every == 0:
                classes = Counter(x.flag_class for x in r.outcome.results.values())
                print(f"t={r.t_min:6.0f} min  uploaded={len(w.uploaded):4d}  pending={len(w.pending):4d}  "
                      f"stall={'OPEN' if r.stall_open else '-':4s}  " +
                      " ".join(f"{k}={v}" for k, v in sorted(classes.items())), flush=True)
                state["stall"] = r.stall_open

        info = await ctl.start_replay(args.election, path, args.speed, on_tick)
        print(json.dumps(info), flush=True)
        try:
            await ctl.task
        except KeyboardInterrupt:  # pragma: no cover
            await ctl.stop()
        print(json.dumps({"finished": True, "ticks": ctl.watcher.ticks, "error": ctl.last_error,
                          "stall_active": ctl.watcher.open_stall is not None}))

    asyncio.run(main())


def cmd_serve(args) -> None:
    import uvicorn

    from .app import create_app
    app = create_app(live_election=args.live_election)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser(prog="pos-watcher")
    ap.add_argument("--database-url", help="defaults to $DATABASE_URL")
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate-timeline", help="write a synthetic timeline.jsonl")
    g.add_argument("--scenario", choices=sorted(SCENARIOS), required=True)
    g.add_argument("--out", default="-")
    g.add_argument("--seed", type=int)
    g.add_argument("--setup-db", action="store_true",
                   help="also install the scenario's units, predictions, election and frozen snapshot")
    g.add_argument("--meta", action="store_true", help="print scenario metadata (held units etc.) to stderr")
    g.set_defaults(func=cmd_generate)

    d = sub.add_parser("demo-setup", help="add synthetic state-99 units and freeze a snapshot for replay-demo")
    d.add_argument("--write-timeline", metavar="FILE")
    d.set_defaults(func=cmd_demo_setup)

    r = sub.add_parser("replay", help="replay a timeline against a replay election (foreground)")
    r.add_argument("--election", required=True)
    r.add_argument("--timeline", required=True, help="path, or a name in timelines/")
    r.add_argument("--speed", type=float, default=60)
    r.add_argument("--every", type=int, default=10, help="print every N ticks (and on stall changes)")
    r.set_defaults(func=cmd_replay)

    s = sub.add_parser("serve", help="run the control API")
    s.add_argument("--host", default=os.environ.get("WATCHER_HOST", "127.0.0.1"))
    s.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8090")))
    s.add_argument("--live-election", default=os.environ.get("WATCHER_LIVE_ELECTION"),
                   help="start live IReV polling for this election (needs IREV_* env)")
    s.set_defaults(func=cmd_serve)

    args = ap.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
