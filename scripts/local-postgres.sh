#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${LOCAL_MEMORY_PGDATA:-${HOME}/.local/share/local-memory-mcp/postgres}"
LOG_DIR="${LOCAL_MEMORY_LOG_DIR:-${HOME}/Library/Logs/local-memory-mcp}"
PORT="${LOCAL_MEMORY_PGPORT:-55432}"
DB_NAME="${LOCAL_MEMORY_DB:-local_memory}"
DB_USER="${LOCAL_MEMORY_DB_USER:-local_memory}"
DB_PASS="${LOCAL_MEMORY_DB_PASS:-local_memory}"
URL="postgres://${DB_USER}:${DB_PASS}@127.0.0.1:${PORT}/${DB_NAME}"
DEFAULT_PG17_BIN="/opt/homebrew/opt/postgresql@17/bin"
PG_BIN="${LOCAL_MEMORY_PG_BIN:-${DEFAULT_PG17_BIN}}"

mkdir -p "${LOG_DIR}"

if [ -d "${PG_BIN}" ]; then
  export PATH="${PG_BIN}:${PATH}"
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing command: $1" >&2
    exit 1
  }
}

is_running() {
  pg_ctl -D "${DATA_DIR}" status >/dev/null 2>&1
}

init_db() {
  require_cmd initdb
  if [ ! -s "${DATA_DIR}/PG_VERSION" ]; then
    mkdir -p "${DATA_DIR}"
    initdb -D "${DATA_DIR}" -U "$(whoami)" --auth-local=trust --auth-host=scram-sha-256 >/dev/null
    {
      echo "listen_addresses = '127.0.0.1'"
      echo "port = ${PORT}"
      echo "shared_buffers = '256MB'"
      echo "work_mem = '32MB'"
      echo "maintenance_work_mem = '256MB'"
      echo "effective_cache_size = '1GB'"
    } >> "${DATA_DIR}/postgresql.conf"
  fi
}

start_db() {
  require_cmd pg_ctl
  init_db
  if ! is_running; then
    pg_ctl -D "${DATA_DIR}" -l "${LOG_DIR}/postgres.log" -o "-p ${PORT}" start >/dev/null
  fi
}

create_role_and_db() {
  require_cmd psql
  start_db
  until pg_isready -p "${PORT}" >/dev/null 2>&1; do
    sleep 0.2
  done

  psql -p "${PORT}" -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN SUPERUSER PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE ${DB_USER} WITH LOGIN SUPERUSER PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\\gexec
SQL
}

case "${1:-start}" in
  init)
    create_role_and_db
    echo "${URL}"
    ;;
  start)
    create_role_and_db
    echo "Postgres running: ${URL}"
    ;;
  stop)
    require_cmd pg_ctl
    if is_running; then
      pg_ctl -D "${DATA_DIR}" stop -m fast >/dev/null
    fi
    ;;
  status)
    require_cmd pg_ctl
    if is_running; then
      pg_isready -h 127.0.0.1 -p "${PORT}"
    else
      echo "Postgres stopped"
      exit 1
    fi
    ;;
  url)
    echo "${URL}"
    ;;
  *)
    echo "Usage: $0 {init|start|stop|status|url}" >&2
    exit 2
    ;;
esac
