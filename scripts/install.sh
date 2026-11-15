#!/bin/sh
# curl -fsSL https://raw.githubusercontent.com/dbullard/ledgr/main/scripts/install.sh | sh
set -e

REPO_RAW="https://raw.githubusercontent.com/dbullard/ledgr/main"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required but wasn't found. Install it from https://docs.docker.com/get-docker/ and re-run this script." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is required but wasn't found. Install it from https://docs.docker.com/compose/install/ and re-run this script." >&2
  exit 1
fi

mkdir -p ledgr
cd ledgr

if [ -f docker-compose.yml ]; then
  echo "docker-compose.yml already exists in $(pwd), skipping download."
else
  echo "Downloading docker-compose.yml..."
  curl -fsSL -o docker-compose.yml "$REPO_RAW/docker-compose.yml"
fi

PORT_VALUE=4200

if [ -f .env ]; then
  echo ".env already exists in $(pwd), leaving it alone."
else
  # A random database password, and the address the phone/Mac apps will use.
  # The password is only read when the database is first created, so keep this
  # .env with the data (or the app will not be able to reach its database).
  if command -v openssl >/dev/null 2>&1; then
    DB_PASSWORD="$(openssl rand -hex 16)"
  else
    DB_PASSWORD="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi

  # Best-effort LAN address so sign-in works from other devices, not just from
  # the NAS itself. Falls back to localhost; edit .env if it guessed wrong.
  LAN_IP="$( (hostname -I 2>/dev/null | awk '{print $1}') || true)"
  if [ -z "$LAN_IP" ] && command -v ipconfig >/dev/null 2>&1; then
    LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
  fi
  APP_URL="http://${LAN_IP:-localhost}:${PORT_VALUE}"

  TZ_VALUE="${TZ:-}"
  if [ -z "$TZ_VALUE" ] && [ -f /etc/timezone ]; then TZ_VALUE="$(cat /etc/timezone)"; fi

  cat > .env <<EOF
POSTGRES_PASSWORD=${DB_PASSWORD}
PORT=${PORT_VALUE}
TZ=${TZ_VALUE:-UTC}
BETTER_AUTH_URL=${APP_URL}
NEXT_PUBLIC_APP_URL=${APP_URL}
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:${PORT_VALUE}
EOF
  chmod 600 .env
  echo "Wrote .env (address: ${APP_URL})."
fi

echo "Starting Ledgr..."
docker compose up -d

echo ""
echo "Ledgr is starting. Open the address in $(pwd)/.env (BETTER_AUTH_URL) once the containers are healthy."
echo "Run 'docker compose logs -f' in $(pwd) to watch startup."
