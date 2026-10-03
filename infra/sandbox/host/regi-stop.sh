#!/usr/bin/env bash
set -uo pipefail
umask 077
if ! /opt/regi/backup.sh --reason stop; then
  printf 'REGI stop backup failed; protected last-backup.json records the result; continuing bounded shutdown\n' >&2
fi
exec /usr/bin/docker compose -f /opt/regi/compose.yaml stop -t 45
