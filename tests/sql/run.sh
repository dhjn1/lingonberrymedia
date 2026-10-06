#!/usr/bin/env bash
# Runs the migration plus behaviour tests against a throwaway Postgres database.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres tests/sql/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=lb_test_$$
createdb "$DB"
trap 'dropdb "$DB" >/dev/null 2>&1 || true' EXIT
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f tests/sql/supabase_stubs.sql
for f in supabase/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f tests/sql/schema_test.sql
