#!/usr/bin/env bash
set -euo pipefail
PGDATA="${PGDATA:-/tmp/regi-postgres}"
if [ ! -f "$PGDATA/PG_VERSION" ]; then
 mkdir -p "$PGDATA"; sudo chown postgres:postgres "$PGDATA"
 sudo -u postgres /usr/bin/initdb -D "$PGDATA" --auth-local=trust --auth-host=trust > /dev/null
fi
if ! sudo -u postgres /usr/bin/pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
 sudo -u postgres /usr/bin/pg_ctl -D "$PGDATA" -l "$PGDATA/server.log" -o '-h 127.0.0.1 -k /tmp' start
fi
psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='regi_owner') THEN CREATE ROLE regi_owner LOGIN PASSWORD 'local-owner-only' NOSUPERUSER NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='regi_app') THEN CREATE ROLE regi_app LOGIN PASSWORD 'local-regi-only' NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
SELECT 'CREATE DATABASE regi OWNER regi_owner' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='regi')\gexec
SQL
