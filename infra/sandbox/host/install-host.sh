#!/usr/bin/env bash
set -euo pipefail
umask 077
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec python3 "$directory/install_host.py" "$@"
