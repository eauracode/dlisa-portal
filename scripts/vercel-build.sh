#!/bin/sh
# Vercel build: apply database migrations (and create the first administrator, if
# configured) before building. Migrations are idempotent: each file is applied once.
# Uses Neon's direct connection for schema changes when it is available.
set -e
MIGRATION_URL="${DATABASE_URL_UNPOOLED:-$DATABASE_URL}"
if [ -n "$MIGRATION_URL" ]; then
  DATABASE_URL="$MIGRATION_URL" npx tsx scripts/migrate.ts
  DATABASE_URL="$MIGRATION_URL" npx tsx scripts/bootstrap-admin.ts
else
  echo "DATABASE_URL is not set; skipping migrations."
fi
npx next build
