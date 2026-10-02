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
  *'ssm get-command-invocation'*)
    if [ "${MOCK_SSM_FIRST_FAILURE:-false}" = true ] && [ ! -f "$MOCK_AWS_LOG.ssm-retry" ]; then touch "$MOCK_AWS_LOG.ssm-retry"; printf 'Failed\n'; exit 0; fi
    polls=0
    if [ -f "$MOCK_AWS_LOG.ssm-polls" ]; then polls=$(cat "$MOCK_AWS_LOG.ssm-polls"); fi
    polls=$((polls + 1))
    printf '%s\n' "$polls" > "$MOCK_AWS_LOG.ssm-polls"
    if [ "$polls" -le "${MOCK_SSM_PENDING_POLLS:-0}" ]; then printf 'InProgress\n'; else printf '%s\n' "${MOCK_SSM_FINAL_STATUS:-Success}"; fi ;;
esac
