#!/usr/bin/env bash
# Restore the Ledgr database from a dump made by the `backup` service.
#
#   ./scripts/restore.sh /path/to/backups/ledgr-20261117-030000.dump
#
# Run it from the folder that holds docker-compose.yml. It:
#   1. asks you to type RESTORE (this replaces the current database),
#   2. stops the app,
#   3. saves the CURRENT database next to the dump as pre-restore-<time>.dump,
#   4. restores the dump in one transaction (all or nothing),
#   5. starts the app again, which re-applies any newer migrations.
#
# Environment (all optional):
#   COMPOSE      compose command, default "docker compose" (e.g. "docker compose -p ledgr-host2")
#   APP_SERVICE  app service name, default "app"; set empty to leave the app alone
#   DB_SERVICE   database service name, default "db"
#   ASSUME_YES   set to 1 to skip the typed confirmation (for tests)
#
# This restores the database only. Bank tokens in it are encrypted with the key in
# the `appdata` volume; restoring onto a server with a different key leaves them unreadable.
set -euo pipefail

DUMP="${1:-}"
[ -n "$DUMP" ] || { echo "usage: $0 /path/to/ledgr-YYYYMMDD-HHMMSS.dump" >&2; exit 2; }
[ -f "$DUMP" ] || { echo "No such file: $DUMP" >&2; exit 2; }

COMPOSE="${COMPOSE:-docker compose}"
APP_SERVICE="${APP_SERVICE-app}"
DB_SERVICE="${DB_SERVICE:-db}"
SAFETY="$(dirname "$DUMP")/pre-restore-$(date -u +%Y%m%d-%H%M%S).dump"

# Refuse to wipe the database with a file pg_restore cannot even read.
if ! $COMPOSE exec -T "$DB_SERVICE" pg_restore --list >/dev/null < "$DUMP"; then
  echo "$DUMP is not a readable pg_dump custom-format file. Nothing was changed." >&2
  exit 1
fi

if [ "${ASSUME_YES:-}" != "1" ]; then
  echo "This REPLACES the current Ledgr database with: $DUMP"
  printf 'Type RESTORE to continue: '
  read -r answer
  [ "$answer" = "RESTORE" ] || { echo "Cancelled. Nothing was changed."; exit 1; }
fi

[ -z "$APP_SERVICE" ] || $COMPOSE stop "$APP_SERVICE"

echo "Saving the current database to $SAFETY"
$COMPOSE exec -T "$DB_SERVICE" pg_dump -U ledgr -Fc ledgr > "$SAFETY"

echo "Restoring..."
if $COMPOSE exec -T "$DB_SERVICE" pg_restore -U ledgr -d ledgr \
     --clean --if-exists --no-owner --no-privileges --single-transaction < "$DUMP"; then
  echo "Restore complete."
else
  echo "Restore FAILED and was rolled back; the database is unchanged." >&2
  echo "Your pre-restore copy is at $SAFETY" >&2
  [ -z "$APP_SERVICE" ] || $COMPOSE start "$APP_SERVICE"
  exit 1
fi

[ -z "$APP_SERVICE" ] || $COMPOSE start "$APP_SERVICE"
echo "Done. The app re-applies migrations and database roles when it starts."
