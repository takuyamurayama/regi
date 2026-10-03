#!/usr/bin/env bash
set -euo pipefail
umask 077
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec timeout --signal=TERM --kill-after=15s 1800 python3 "$directory/database_backup.py" restore "$@"
