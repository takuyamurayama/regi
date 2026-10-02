#!/usr/bin/env bash
set -euo pipefail
config_file="${REGI_SANDBOX_CONTROL_CONFIG:-$HOME/regi-sandbox/.private/control.json}"
python="${REGI_CONTROL_PYTHON:-/usr/bin/python3}"
action="${1:-status}"
configuration=$("$python" - "$config_file" <<'PY'
import json, re, sys
with open(sys.argv[1]) as handle:
    config = json.load(handle)
checks = {"aws_profile": r"[A-Za-z0-9_.-]+", "expected_account_id": r"[0-9]{12}", "region": r"ap-northeast-1", "instance_id": r"i-([0-9a-f]{8}|[0-9a-f]{17})", "web_url": r"https://[a-z0-9]+\.cloudfront\.net"}
if any(not re.fullmatch(pattern, config.get(key, "")) for key, pattern in checks.items()):
    raise SystemExit("Invalid explicit sandbox configuration; no AWS operation executed")
print("\n".join(config[key] for key in checks))
PY
)
profile=$(printf '%s\n' "$configuration" | sed -n '1p')
account=$(printf '%s\n' "$configuration" | sed -n '2p')
region=$(printf '%s\n' "$configuration" | sed -n '3p')
instance=$(printf '%s\n' "$configuration" | sed -n '4p')
url=$(printf '%s\n' "$configuration" | sed -n '5p')
aws_cli() { aws --profile "$profile" --region "$region" "$@"; }
actual_account=$(aws_cli sts get-caller-identity --query Account --output text)
if [ "$actual_account" != "$account" ]; then printf 'AWS account mismatch; refusing operation\n' >&2; exit 1; fi
send_command() {
  local parameters="$1" command_id invocation_status deadline
  command_id=$(AWS_MAX_ATTEMPTS=1 AWS_RETRY_MODE=standard aws_cli ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript --timeout-seconds 60 --parameters "$parameters" --query 'Command.CommandId' --output text --cli-connect-timeout 5 --cli-read-timeout 10) || return 1
  if ! [[ "$command_id" =~ ^[0-9a-f-]{36}$ ]]; then return 1; fi
  deadline=$((SECONDS + 480))
  while [ "$SECONDS" -lt "$deadline" ]; do
    invocation_status=$(AWS_MAX_ATTEMPTS=1 AWS_RETRY_MODE=standard aws_cli ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" --query Status --output text --cli-connect-timeout 5 --cli-read-timeout 10) || invocation_status=Pending
    case "$invocation_status" in
      Success) return 0 ;;
      Cancelled|Cancelling|Failed|TimedOut|Undeliverable|Terminated) return 1 ;;
      Pending|InProgress|Delayed) sleep 5 ;;
      *) return 1 ;;
    esac
  done
  return 1
}
case "$action" in
  start)
    state=$(aws_cli ec2 describe-instances --instance-ids "$instance" --query 'Reservations[0].Instances[0].State.Name' --output text)
    if [ "$state" = stopping ]; then aws_cli ec2 wait instance-stopped --instance-ids "$instance"; state=stopped; fi
    case "$state" in
      stopped) aws_cli ec2 start-instances --instance-ids "$instance" --query 'StartingInstances[0].CurrentState.Name' --output text ;;
      running|pending) ;;
      *) printf 'Cannot start instance in state %s\n' "$state" >&2; exit 1 ;;
    esac
    aws_cli ec2 wait instance-running --instance-ids "$instance"
    aws_cli ec2 wait instance-status-ok --instance-ids "$instance"
    connected=false
    for attempt in $(seq 1 120); do
      if [ "$(aws_cli ssm describe-instance-information --filters "Key=InstanceIds,Values=$instance" --query 'InstanceInformationList[0].PingStatus' --output text)" = Online ]; then
        if send_command '{"executionTimeout":["420"],"commands":["systemctl restart regi-autostop.timer","systemctl is-active --quiet regi-autostop.timer","systemctl start --no-block regi.service"]}'; then connected=true; break; fi
      fi
      sleep 5
    done
    if [ "$connected" != true ]; then printf 'SSM unavailable; guest two-hour auto-stop remains enabled. Check host bootstrap.\n' >&2; exit 1; fi
    printf 'Started; auto-stop is reset to two hours. Private API may take several minutes to initialize.\n%s\n' "$url"
    if [ "$(uname -s)" = Darwin ] && command -v open >/dev/null 2>&1; then
      open "$url" >/dev/null 2>&1 || printf 'Browser could not open; use the URL above.\n' >&2
    fi
    ;;
  stop)
    state=$(aws_cli ec2 describe-instances --instance-ids "$instance" --query 'Reservations[0].Instances[0].State.Name' --output text)
    case "$state" in
      running|pending)
        if [ "$state" = pending ]; then aws_cli ec2 wait instance-running --instance-ids "$instance"; fi
        send_command '{"executionTimeout":["420"],"commands":["systemctl stop regi.service","python3 -c '\''import json,datetime; p=\"/var/lib/regi/private/backups/last-backup.json\"; r=json.load(open(p)); age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(r[\"created_at\"])).total_seconds(); ok=r.get(\"status\")==\"complete\" and r.get(\"reason\")==\"stop\" and 0<=age<=360; print(\"REGI stop backup complete\" if ok else \"REGI stop backup incomplete; inspect private record\"); raise SystemExit(0 if ok else 1)'\''"]}' || printf 'SSM shutdown or stop backup incomplete; inspect private backup record. Requesting normal guest OS shutdown, never forced stop.\n' >&2
        aws_cli ec2 stop-instances --instance-ids "$instance" --query 'StoppingInstances[0].CurrentState.Name' --output text
        aws_cli ec2 wait instance-stopped --instance-ids "$instance" ;;
      stopping) aws_cli ec2 wait instance-stopped --instance-ids "$instance" ;;
      stopped) ;;
      *) printf 'Cannot stop instance in state %s\n' "$state" >&2; exit 1 ;;
    esac
    state=$(aws_cli ec2 describe-instances --instance-ids "$instance" --query 'Reservations[0].Instances[0].State.Name' --output text)
    if [ "$state" != stopped ]; then printf 'Stop not confirmed; current state is %s\n' "$state" >&2; exit 1; fi
    printf 'Stopped. EBS/S3 retained data still incur storage charges.\n'
    ;;
  status)
    aws_cli ec2 describe-instances --instance-ids "$instance" --query 'Reservations[0].Instances[0].{State:State.Name,Type:InstanceType}' --output json
    printf '%s\n' "$url"
    ;;
  *) printf 'Usage: sandbox-control.sh start|stop|status\n' >&2; exit 2 ;;
esac
