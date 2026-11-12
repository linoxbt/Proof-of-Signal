#!/usr/bin/env bash
# Persistent local Postgres + PostGIS with every migration and the seed, for
# developing services against. Each developer/agent picks its own port.
#
#   PGDEV_PORT=54331 scripts/db-dev.sh start   # prints DATABASE_URL
#   PGDEV_PORT=54331 scripts/db-dev.sh reset   # drop, re-apply migrations + seed
#   PGDEV_PORT=54331 scripts/db-dev.sh stop
#
# The URL connects as superuser `postgres` (bypasses RLS, like the service
# role). To test RLS, `set role anon` / `set role authenticated` in a session.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${PGDEV_PORT:-54330}"
BASE="${PGDEV_DIR:-/tmp/pos-pgdev-$PORT}"
URL="postgresql://postgres@127.0.0.1:$PORT/pos_dev"

RUN=()
if [ "$(id -u)" = "0" ]; then RUN=(runuser -u postgres --); fi
PSQL=("$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1)

apply_all() {
  "${PSQL[@]}" -d postgres -c "drop database if exists pos_dev with (force)" >/dev/null
  "${PSQL[@]}" -d postgres -c "create database pos_dev" >/dev/null
  # Roles are cluster-wide: the stub creates them only once per cluster.
  if ! "${PSQL[@]}" -d postgres -tAc "select 1 from pg_roles where rolname='anon'" | grep -q 1; then
    "${PSQL[@]}" -d pos_dev -f "$ROOT/supabase/tests/00_supabase_stub.sql" >/dev/null
  else
    sed '/^create role /d' "$ROOT/supabase/tests/00_supabase_stub.sql" | "${PSQL[@]}" -d pos_dev >/dev/null
  fi
  for f in "$ROOT"/supabase/migrations/*.sql; do "${PSQL[@]}" -d pos_dev -f "$f" >/dev/null 2>&1 || { echo "failed: $f" >&2; "${PSQL[@]}" -d pos_dev -f "$f"; exit 1; }; done
  "${PSQL[@]}" -d pos_dev -f "$ROOT/supabase/seed.sql" >/dev/null
}

case "${1:-start}" in
  start)
    if ! "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1; then
      mkdir -p "$BASE"
      [ "$(id -u)" = "0" ] && chown postgres "$BASE"
      if [ ! -f "$BASE/data/PG_VERSION" ]; then
        "${RUN[@]}" "$PG_BIN/initdb" -D "$BASE/data" -U postgres -A trust --no-sync >/dev/null
      fi
      "${RUN[@]}" "$PG_BIN/pg_ctl" -D "$BASE/data" -l "$BASE/pg.log" -w \
        -o "-p $PORT -c listen_addresses=127.0.0.1 -k $BASE -c TimeZone=UTC" start >/dev/null
      apply_all
    fi
    echo "DATABASE_URL=$URL"
    ;;
  reset)
    apply_all
    echo "DATABASE_URL=$URL"
    ;;
  stop)
    "${RUN[@]}" "$PG_BIN/pg_ctl" -D "$BASE/data" -m fast stop >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 start|reset|stop" >&2; exit 2 ;;
esac
