"""Install the explicitly hashed sandbox host files, without changing application state."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


FILES = (
    "bootstrap.sh", "bootstrap.py", "credentials.py", "compose.yaml",
    "backup.sh", "restore.sh", "database_backup.py", "install-host.sh",
    "install_host.py", "regi-stop.sh", "regi.service", "regi-backup.service", "regi-backup.timer",
)


def validate(directory, hashes):
    if set(hashes) != set(FILES):
        raise ValueError("Host file set mismatch")
    for name in FILES:
        target = directory / name
        if target.is_symlink() or hashlib.sha256(target.read_bytes()).hexdigest() != hashes[name]:
            raise ValueError("Host file checksum mismatch")


def install(directory, unit_directory=Path("/etc/systemd/system")):
    for name in FILES:
        os.chmod(directory / name, 0o700 if name.endswith(".sh") else 0o600)
    for name in ("regi.service", "regi-backup.service", "regi-backup.timer"):
        shutil.copyfile(directory / name, unit_directory / name)
        os.chmod(unit_directory / name, 0o644)
    subprocess.run(["systemctl", "daemon-reload"], check=True, capture_output=True)
    subprocess.run(["systemctl", "enable", "regi.service", "regi-backup.timer"], check=True, capture_output=True)


def refresh(directory):
    from credentials import aws
    config = json.loads((directory / "host.json").read_text())
    runtime = json.loads(aws("ssm", "get-parameter", "--name", config["runtimePath"])["Parameter"]["Value"])
    hashes = runtime["bootstrapSha256"]
    if set(hashes) != set(FILES):
        raise ValueError("Runtime host file set mismatch")
    with tempfile.TemporaryDirectory(prefix="regi-host-", dir=str(directory)) as temporary:
        staging = Path(temporary)
        for name in FILES:
            subprocess.run(["aws", "s3", "cp", "s3://" + config["bucket"] + "/releases/" + config["name"] + "/bootstrap/" + name,
                            str(staging / name), "--region", config["region"], "--only-show-errors"],
                           check=True, capture_output=True, timeout=60)
        validate(staging, hashes)
        # All hashes are checked before replacing any host file. This never restarts REGI.
        for name in FILES:
            os.chmod(staging / name, 0o700 if name.endswith(".sh") else 0o600)
            os.replace(staging / name, directory / name)
    descriptor = os.open(directory / "bootstrap-manifest.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(hashes, handle, sort_keys=True)
    install(directory)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true")
    options = parser.parse_args()
    directory = Path(__file__).resolve().parent
    try:
        if options.refresh:
            refresh(directory)
        else:
            validate(directory, json.loads((directory / "bootstrap-manifest.json").read_text()))
            install(directory)
        print("REGI host files and backup units installed; application restart remains a separate operator step")
    except Exception:
        raise SystemExit("REGI host install failed; no credentials logged") from None


if __name__ == "__main__":
    main()
