#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_AWS_LOG"
case "$*" in
  *'sts get-caller-identity'*) printf '%s\n' "$MOCK_AWS_ACCOUNT" ;;
  *'ec2 describe-instances'*) if [ -f "$MOCK_AWS_LOG.state" ]; then cat "$MOCK_AWS_LOG.state"; else printf '%s\n' "${MOCK_AWS_STATE:-running}"; fi ;;
  *'ec2 wait instance-stopped'*) if [ "${MOCK_WAIT_STAYS_STOPPING:-false}" != true ]; then printf 'stopped\n' > "$MOCK_AWS_LOG.state"; fi ;;
  *'ec2 wait instance-running'*) printf 'running\n' > "$MOCK_AWS_LOG.state" ;;
  *'describe-instance-information'*) printf 'Online\n' ;;
  *'ssm send-command'*) printf '00000000-0000-4000-8000-000000000001\n' ;;
  *'ssm wait command-executed'*) if [ "${MOCK_SSM_FIRST_FAILURE:-false}" = true ] && [ ! -f "$MOCK_AWS_LOG.ssm-retry" ]; then touch "$MOCK_AWS_LOG.ssm-retry"; exit 1; fi ;;
esac
