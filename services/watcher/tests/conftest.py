"""Test database: a throwaway copy of the dev database (all migrations + seed).

Start the dev database first:  PGDEV_PORT=54333 scripts/db-dev.sh start
Tests marked ``db`` are skipped when it is unreachable, unless
WATCHER_REQUIRE_DB=1, in which case they fail.
"""

from __future__ import annotations

import os
import uuid
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest

DEFAULT_URL = "postgresql://postgres@127.0.0.1:54333/pos_dev"


def _with_db(url: str, name: str) -> str:
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, "/" + name, p.query, p.fragment))


@pytest.fixture(scope="session")
def database_url():
    template_url = os.environ.get("WATCHER_TEMPLATE_DATABASE_URL") or os.environ.get("DATABASE_URL") or DEFAULT_URL
    template = urlsplit(template_url).path.lstrip("/")
    admin_url = _with_db(template_url, "postgres")
    name = f"pos_watcher_test_{uuid.uuid4().hex[:8]}"
    try:
        admin = psycopg.connect(admin_url, autocommit=True, connect_timeout=3)
    except psycopg.OperationalError as e:
        if os.environ.get("WATCHER_REQUIRE_DB") == "1":
            raise
        pytest.skip(f"dev database unreachable ({e}); run PGDEV_PORT=54333 scripts/db-dev.sh start")
    with admin:
        admin.execute(f'create database "{name}" template "{template}"')
    try:
        yield _with_db(template_url, name)
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(f'drop database if exists "{name}" with (force)')
