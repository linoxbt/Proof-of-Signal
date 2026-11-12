#!/usr/bin/env bash
# Applies every Supabase migration to a throwaway local Postgres + PostGIS,
# then runs supabase/tests/*.sql. Needs PostgreSQL 15+ server binaries and
# PostGIS 3 (Debian/Ubuntu: postgresql-16 postgresql-16-postgis-3).
#
#   scripts/db-test.sh            # PG_BIN defaults to /usr/lib/postgresql/16/bin
#   PG_BIN=/path/to/bin scripts/db-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${PGTEST_PORT:-54329}"
WORK="$(mktemp -d)"

# initdb refuses to run as root; drop to the postgres user when we are root.
RUN=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"
  chmod 755 "$WORK"
  RUN=(runuser -u postgres --)
fi

cleanup() {
  "${RUN[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"${RUN[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U postgres -A trust --no-sync >/dev/null
"${RUN[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/pg.log" -w \
  -o "-p $PORT -k $WORK -c listen_addresses='' -c fsync=off -c TimeZone=UTC" start >/dev/null

PSQL=("$PG_BIN/psql" -h "$WORK" -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "create database pos_test" >/dev/null

run() {
  echo "  $(basename "$1")"
  "${PSQL[@]}" -d pos_test -f "$1"
}

echo "stub"
run "$ROOT/supabase/tests/00_supabase_stub.sql"
echo "migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do run "$f"; done
echo "seed"
run "$ROOT/supabase/seed.sql"
echo "tests"
for f in "$ROOT"/supabase/tests/[1-9]*.sql; do run "$f"; done
echo "all database tests passed"
