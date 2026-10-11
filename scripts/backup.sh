#!/bin/sh
# Logical backup of the Postgres database (contact history + ledger + logs are the crown jewels).
# Usage: DATABASE_URL=postgres://... sh scripts/backup.sh [outdir]
set -eu
OUT="${1:-backups}"; mkdir -p "$OUT"
FILE="$OUT/xom-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner "$DATABASE_URL" > "$FILE"
echo "wrote $FILE ($(du -h "$FILE" | cut -f1))"
# keep the 30 newest
ls -1t "$OUT"/xom-*.dump | tail -n +31 | xargs -r rm --
# Restore:  pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" backups/xom-<stamp>.dump
