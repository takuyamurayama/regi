import hashlib
import json
import os
import secrets
import subprocess
import time
from pathlib import Path
from credentials import aws, refresh

current_stage = "load-runtime"


def stage(label):
    global current_stage
    current_stage = label
    private_file("/opt/regi/bootstrap-stage.json", json.dumps({"stage": label, "timestamp": int(time.time())}))
    print("REGI bootstrap stage: " + label, flush=True)


def private_file(path, content):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(content)
    os.chmod(target, 0o600)


def environment_file(path, values):
    if any("\n" in str(value) or "\r" in str(value) for value in values.values()):
        raise ValueError("Invalid environment configuration")
    private_file(path, "\n".join(f"{key}={value}" for key, value in values.items()) + "\n")


def compose(*arguments):
    subprocess.run(["docker", "compose", "-f", "/opt/regi/compose.yaml", *arguments], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def seed_demo_once(directory, demo):
    marker = directory / "demo-seed-completed.json"
    expected = {"version": "regi-synthetic-v1", "configuration": demo}
    if marker.exists():
        if json.loads(marker.read_text()) != expected:
            raise ValueError("Completed demo configuration cannot be replaced automatically")
        return
    compose("run", "--rm", "--user", "0", "maintenance", "npm", "run", "db:seed:sandbox")
    private_file(marker, json.dumps(expected, sort_keys=True))


def authentication_environment(runtime):
    required = runtime.get("requireMfa", True)
    if type(required) is not bool:
        raise ValueError("MFA mode must be an explicit boolean")
    environment = {"COGNITO_MFA_ENFORCED": "true" if required else "false", "REGI_PERSONAL_SANDBOX_PASSWORD_ONLY_TENANT_ID": ""}
    if not required:
        import uuid
        demo = runtime["demo"]
        if demo.get("enabled") is not True:
            raise ValueError("Password-only mode requires an enabled synthetic tenant")
        tenant = demo["tenant_id"]
        if str(uuid.UUID(tenant)) != tenant:
            raise ValueError("Synthetic tenant must be an explicit UUID")
        environment["REGI_PERSONAL_SANDBOX_PASSWORD_ONLY_TENANT_ID"] = tenant
    return environment


def cognito_environment(runtime):
    environment = {
        "COGNITO_ISSUER": runtime["issuer"],
        "COGNITO_CLIENT_ID": runtime["clientId"],
        "COGNITO_ANDROID_CLIENT_ID": runtime.get("androidClientId", ""),
    }
    if any(not isinstance(value, str) for value in environment.values()):
        raise ValueError("Cognito client configuration must be strings")
    if not environment["COGNITO_ISSUER"] or not environment["COGNITO_CLIENT_ID"]:
        raise ValueError("Cognito issuer and Web client are required")
    return environment


def bootstrap(config, runtime):
    authentication = authentication_environment(runtime)
    cognito = cognito_environment(runtime)
    stage("runtime-secret")
    directory = Path("/var/lib/regi/private")
    directory.mkdir(parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    try:
        credentials = json.loads(aws("secretsmanager", "get-secret-value", "--secret-id", config["secretArn"])["SecretString"])
    except subprocess.CalledProcessError as error:
        if "ResourceNotFoundException" not in error.stderr:
            raise
        credentials = {"ownerPassword": secrets.token_urlsafe(36), "appPassword": secrets.token_urlsafe(36), "recoveryKey": secrets.token_urlsafe(48), "adminPin": str(secrets.randbelow(80000000) + 20000000)}
        temporary = directory / "secret-upload.json"
        private_file(temporary, json.dumps(credentials))
        try:
            aws("secretsmanager", "put-secret-value", "--secret-id", config["secretArn"], "--secret-string", "file://" + str(temporary))
        finally:
            temporary.unlink(missing_ok=True)
    stage("workload-identity")
    refresh(config)
    stage("release-download")
    archive = Path("/var/lib/regi/app.tar.gz")
    subprocess.run(["aws", "s3", "cp", "s3://" + runtime["releaseBucket"] + "/" + runtime["imageObjectKey"], str(archive), "--region", "ap-northeast-1", "--only-show-errors"], check=True, capture_output=True)
    stage("release-checksum")
    with archive.open("rb") as handle:
        digest = hashlib.sha256()
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
        checksum = digest.hexdigest()
    if checksum != runtime["imageSha256"]:
        raise ValueError("Image archive checksum mismatch")
    stage("release-docker-load")
    subprocess.run(["docker", "load", "-i", str(archive)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    stage("private-environment")
    private_file(directory / "app-password", credentials["appPassword"])
    private_file(directory / "admin-pin", credentials["adminPin"])
    owner_url = "postgresql://regi_owner:" + credentials["ownerPassword"] + "@db:5432/regi"
    app_url = "postgresql://regi_app:" + credentials["appPassword"] + "@db:5432/regi"
    demo = runtime["demo"]
    scopes = []
    if demo["enabled"]:
        digest = bytearray(hashlib.sha256(("regi-synthetic-v1:" + demo["tenant_id"] + ":admin").encode()).digest()[:16])
        digest[6] = (digest[6] & 15) | 64
        digest[8] = (digest[8] & 63) | 128
        import uuid
        scopes = [{"tenantId": demo["tenant_id"], "staffId": str(uuid.UUID(bytes=bytes(digest))), "role": "admin", "stores": [], "mfa": authentication["COGNITO_MFA_ENFORCED"] == "true"}]
    environment_file("/opt/regi/db.env", {"POSTGRES_USER": "regi_owner", "POSTGRES_PASSWORD": credentials["ownerPassword"], "POSTGRES_DB": "regi"})
    environment_file("/opt/regi/app.env", {"NODE_ENV": "production", "DATABASE_URL": app_url, "RECOVERY_SIGNING_SECRET": credentials["recoveryKey"], **cognito, **authentication, "WEB_ORIGIN": runtime["webOrigin"], "AWS_REGION": "ap-northeast-1", "AWS_PROFILE": "sandbox-workload", "AWS_CONFIG_FILE": "/run/regi-aws/config", "AWS_SHARED_CREDENTIALS_FILE": "/run/regi-aws/not-present", "AWS_EC2_METADATA_DISABLED": "true", "ARTIFACT_BUCKET": runtime["bucket"], "EXPORT_QUEUE_URL": runtime["queueUrl"], "BEDROCK_PROFILE_ID": runtime["bedrockProfileArn"], "WORKER_SCOPES": json.dumps(scopes, separators=(",", ":"))})
    environment_file("/opt/regi/maintenance.env", {"NODE_ENV": "production", "DATABASE_URL": app_url, "MIGRATION_DATABASE_URL": owner_url, "REGI_SANDBOX_DB_BOOTSTRAP": "sandbox-only", "REGI_SANDBOX_DB_CONFIRM": "regi", "REGI_SANDBOX_APP_PASSWORD_FILE": "/run/regi-private/app-password", "REGI_SANDBOX_ADMIN_PIN_FILE": "/run/regi-private/admin-pin", "REGI_SANDBOX_SEED": "synthetic-only" if demo["enabled"] else "disabled", "REGI_SANDBOX_TENANT_ID": demo["tenant_id"], "REGI_SANDBOX_CONFIRM_TENANT": demo["tenant_id"], "REGI_SANDBOX_ADMIN_SUBJECT": demo["administrator_subject"], "REGI_SANDBOX_END_DAY": demo["end_day"], "RECOVERY_SIGNING_SECRET": credentials["recoveryKey"]})
    stage("database-ready")
    compose("up", "-d", "--wait", "db")
    stage("database-application-role")
    compose("run", "--rm", "--user", "0", "maintenance", "npx", "tsx", "scripts/sandbox-db-role.ts")
    stage("database-migrations")
    compose("run", "--rm", "maintenance", "npm", "run", "db:migrate")
    if demo["enabled"]:
        stage("synthetic-seed")
        seed_demo_once(directory, demo)
        for index in range(2):
            stage("forecast-store-" + str(index + 1))
            digest = bytearray(hashlib.sha256(("regi-synthetic-v1:" + demo["tenant_id"] + ":store:" + str(index)).encode()).digest()[:16])
            digest[6] = (digest[6] & 15) | 64
            digest[8] = (digest[8] & 63) | 128
            compose("run", "--rm", "maintenance", "/opt/forecast/bin/python", "forecast/regi_forecast.py", "--tenant", demo["tenant_id"], "--store", str(uuid.UUID(bytes=bytes(digest))))
    stage("api-worker-start")
    compose("up", "-d", "api", "worker")
    stage("ready")


if __name__ == "__main__":
    with open("/opt/regi/host.json") as handle:
        config = json.load(handle)
    for attempt in range(180):
        try:
            stage("load-runtime")
            runtime = json.loads(aws("ssm", "get-parameter", "--name", config["runtimePath"])["Parameter"]["Value"])
            if not runtime["imageSha256"]:
                raise ValueError("Waiting for verified release image")
            bootstrap(config, runtime)
            print("REGI sandbox initialized; synthetic history only; no credentials logged")
            break
        except Exception as error:
            print("REGI initialization retry: stage=" + current_stage + " exception=" + type(error).__name__ + " returncode=" + str(getattr(error, "returncode", "none")) + "; no credentials logged", flush=True)
            time.sleep(20)
    else:
        raise SystemExit("REGI sandbox initialization failed; inspect protected configuration and release checksum")
