#!/usr/bin/env bash
# Apply supabase/migrations to a throwaway Postgres database (with a stub of
# Supabase's auth and storage schemas) and run supabase/tests/rls.test.sql.
#
# Usage:
#   DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres pnpm db:verify
#
# DATABASE_URL must point at a Postgres 15+ server where this user can
# create databases and roles. A new database is created and dropped each run.
# This checks the SQL; it is not a substitute for `supabase db push` against
# the real project.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to an admin connection, e.g. postgresql://postgres@127.0.0.1:5432/postgres}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_NAME="gladrags_verify_$$"

# Swap the database name at the end of the URL for the throwaway one.
BASE_URL="${DATABASE_URL%/*}"
TEST_URL="${BASE_URL}/${DB_NAME}"

cleanup() {
  psql "$DATABASE_URL" -qtAc "drop database if exists ${DB_NAME} with (force)" >/dev/null
}
trap cleanup EXIT

psql "$DATABASE_URL" -qtAc "create database ${DB_NAME}" >/dev/null

echo "Applying Supabase stub..."
psql "$TEST_URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/supabase-stub.sql" >/dev/null

for migration in "$ROOT"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$migration")..."
  psql "$TEST_URL" -q -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
done

echo "Running checks..."
psql "$TEST_URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/rls.test.sql"
