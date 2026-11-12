"""Shared paths and helpers for the download/loader scripts.

Run the scripts with the model service's virtualenv, which has pos_model and
the optional data dependencies installed:

    cd services/model && python3 -m venv .venv && .venv/bin/pip install -e '.[data,dev]'
    services/model/.venv/bin/python data/<script>.py --help
"""

from __future__ import annotations

import os
import shutil
import sys
import urllib.request
from pathlib import Path

DATA = Path(__file__).resolve().parent
RAW = DATA / "raw"        # downloads (gitignored)
SOURCES = DATA / "cache" / "sources"  # processed inputs read by `pos-model features` (gitignored)

try:  # the scripts reuse the model package's parsers and loaders
    import pos_model  # noqa: F401
except ImportError:  # running from a checkout without `pip install -e services/model`
    sys.path.insert(0, str(DATA.parent / "services" / "model"))


def download(url: str, dest: Path, overwrite: bool = False, headers: dict | None = None) -> Path:
    """Stream url to dest (atomic rename). Honours HTTPS_PROXY via urllib."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and not overwrite:
        print(f"exists: {dest}")
        return dest
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "proof-of-signal-data/0.1", **(headers or {})})
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as fh:
        shutil.copyfileobj(r, fh, length=1 << 20)
    os.replace(tmp, dest)
    print(f"downloaded: {dest} ({dest.stat().st_size:,} bytes)")
    return dest


def connect():
    from pos_model.pipeline import connect as _connect

    return _connect(os.environ.get("DATABASE_URL"))
