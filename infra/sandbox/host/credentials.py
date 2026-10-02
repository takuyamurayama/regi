import json
import os
import subprocess
import tempfile


def aws(*arguments):
    result = subprocess.run(["aws", *arguments, "--region", "ap-northeast-1", "--output", "json"], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def refresh(config):
    response = aws("ssm", "get-parameter", "--name", config["runtimePath"])
    runtime = json.loads(response["Parameter"]["Value"])
    credentials = aws("sts", "assume-role", "--role-arn", runtime["workloadRoleArn"], "--role-session-name", "regi-sandbox-workload", "--duration-seconds", "3600")["Credentials"]
    directory = "/var/lib/regi/workload"
    os.makedirs(directory, mode=0o750, exist_ok=True)
    os.chown(directory, 0, 1000)
    os.chmod(directory, 0o750)
    descriptor, temporary = tempfile.mkstemp(dir=directory)
    try:
        os.fchmod(descriptor, 0o640)
        os.fchown(descriptor, 0, 1000)
        with os.fdopen(descriptor, "w") as handle:
            json.dump({"Version": 1, **credentials}, handle)
        os.replace(temporary, directory + "/credentials.json")
        with open(directory + "/config", "w") as handle:
            handle.write("[profile sandbox-workload]\ncredential_process = cat /run/regi-aws/credentials.json\nregion = ap-northeast-1\n")
        os.chown(directory + "/config", 0, 1000)
        os.chmod(directory + "/config", 0o640)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    try:
        with open("/opt/regi/host.json") as handle:
            refresh(json.load(handle))
    except Exception:
        raise SystemExit("Workload identity refresh failed; no credentials logged")
