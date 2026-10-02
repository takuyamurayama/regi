#!/usr/bin/env bash
set -euo pipefail
umask 077
iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT 2>/dev/null || iptables -I DOCKER-USER 1 -d 169.254.169.254/32 -j REJECT
python3 /opt/regi/bootstrap.py
