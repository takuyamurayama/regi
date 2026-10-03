"""REGI PostgreSQL 17 backup and verified alternate-database restore.

Uses Python 3.9 stdlib and PostgreSQL tools in the existing database container.
Credentials are never command arguments; subprocess diagnostics stay private.
"""

import argparse
import datetime
import fcntl
import gzip
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.request import urlopen


class BackupError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]{0,62}", value):
        raise BackupError("INVALID_IDENTIFIER")
    return '"' + value + '"'


def literal(value):
    if not isinstance(value, str) or "\x00" in value:
        raise BackupError("INVALID_LITERAL")
    return "'" + value.replace("'", "''") + "'"


def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".regi-", dir=str(path.parent))
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def configuration(path):
    target = Path(path)
    if target.is_symlink() or target.stat().st_mode & 0o077:
        raise BackupError("CONFIG_NOT_PRIVATE")
    value = json.loads(target.read_text())
    identifier(value["database"])
    identifier(value["user"])
    backend = value.get("backend", "compose")
    if backend not in ("compose", "local", "container"):
        raise BackupError("INVALID_BACKEND")
    if backend != "compose" and os.environ.get("NODE_ENV") != "test":
        raise BackupError("TEST_BACKEND_FORBIDDEN")
    if backend != "compose" and not value["database"].startswith("regi_backup_test_"):
        raise BackupError("TEST_DATABASE_REQUIRED")
    return value


class DatabaseTools:
    def __init__(self, config):
        self.config = config
        self.directory = Path(config.get("hostDirectory", "/opt/regi"))
        self.private = Path(config.get("privateDirectory", "/var/lib/regi/private/backups"))
        self.private.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.private, 0o700)
        self.backend = config.get("backend", "compose")
        self.environment = dict(os.environ)
        timeout_options = "-c statement_timeout=120000 -c lock_timeout=10000"
        if self.backend == "compose":
            self.prefix = ["docker", "compose", "-f", str(self.directory / "compose.yaml"), "exec", "-T", "--env", "PGOPTIONS=" + timeout_options, "db"]
        elif self.backend == "container":
            container = os.environ.get("POSTGRES_TEST_CONTAINER", "")
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", container):
                raise BackupError("TEST_CONTAINER_REQUIRED")
            self.prefix = ["docker", "exec", "-i", "--env", "PGOPTIONS=" + timeout_options, container]
        else:
            self.prefix = []
            url = urlparse(os.environ.get("SANDBOX_TEST_ADMIN_DATABASE_URL", "postgresql://postgres@localhost:5432/postgres"))
            if url.hostname not in ("localhost", "127.0.0.1") or url.scheme not in ("postgres", "postgresql"):
                raise BackupError("LOCAL_ADMIN_REQUIRED")
            self.environment.update(PGHOST=url.hostname, PGPORT=str(url.port or 5432), PGPASSWORD=unquote(url.password or ""))
        self.environment["PGOPTIONS"] = timeout_options

    def command(self, program, database, *options):
        identifier(database)
        return self.prefix + [program, "--no-password", "-U", self.config["user"], "-d", database, *options]

    def execute(self, arguments, input_text=None, output=None, timeout=120):
        try:
            return subprocess.run(arguments, input=input_text, stdout=output or subprocess.PIPE,
                                  stderr=subprocess.PIPE, env=self.environment, timeout=timeout,
                                  check=True, text=input_text is not None)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            raise BackupError("DATABASE_COMMAND_FAILED") from None

    def sql(self, database, source):
        result = self.execute(self.command("psql", database, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"), source)
        return result.stdout.strip()

    def query(self, database, source, snapshot=None):
        prefix = ""
        if snapshot is not None:
            prefix = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT " + literal(snapshot) + ";\n"
        return json.loads(self.sql(database, prefix + source + ("\nCOMMIT;" if snapshot is not None else "")))

    @contextmanager
    def snapshot(self, database):
        error_file = tempfile.TemporaryFile(dir=str(self.private))
        process = subprocess.Popen(self.command("psql", database, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"),
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=error_file,
                                   env=self.environment, text=True)
        try:
            process.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();\n")
            process.stdin.flush()
            exported = process.stdout.readline().strip()
            if not re.fullmatch(r"[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9A-Fa-f]+", exported):
                raise BackupError("SNAPSHOT_EXPORT_FAILED")
            yield exported
        finally:
            if process.poll() is None:
                try:
                    process.stdin.write("ROLLBACK;\n\\q\n")
                    process.stdin.flush()
                    process.wait(timeout=5)
                except (BrokenPipeError, subprocess.TimeoutExpired):
                    process.kill()
                    process.wait()
            process.stdin.close()
            process.stdout.close()
            error_file.close()

    def dump(self, database, snapshot, destination):
        error_file = tempfile.TemporaryFile(dir=str(self.private))
        process = subprocess.Popen(self.command("pg_dump", database, "--format=custom", "--snapshot=" + snapshot,
                                                "--lock-wait-timeout=10000"),
                                   stdout=subprocess.PIPE, stderr=error_file, env=self.environment)
        try:
            archive_bytes = 0
            with destination.open("wb") as raw:
                os.chmod(destination, 0o600)
                with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as compressed:
                    for chunk in iter(lambda: process.stdout.read(1024 * 1024), b""):
                        archive_bytes += len(chunk)
                        compressed.write(chunk)
            if process.wait(timeout=5) != 0:
                raise BackupError("DATABASE_DUMP_FAILED")
            return archive_bytes
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()
            error_file.close()

    def restore(self, database, archive):
        with archive.open("rb") as handle:
            try:
                subprocess.run(self.command("pg_restore", database, "--exit-on-error", "--single-transaction"),
                               stdin=handle, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                               env=self.environment, check=True, timeout=240)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                raise BackupError("DATABASE_RESTORE_FAILED") from None

    def services(self, action):
        if self.backend == "compose":
            base = ["docker", "compose", "-f", str(self.directory / "compose.yaml")]
            options = ["stop", "-t", "45", "api", "worker"] if action == "stop" else ["up", "-d", "--wait", "--wait-timeout", "120", "api", "worker"]
            self.execute(base + options, timeout=135)
            if action == "start":
                try:
                    with urlopen("http://127.0.0.1:3000/health", timeout=5) as response:
                        if response.status != 200:
                            raise BackupError("RESTORE_API_UNHEALTHY")
                    result = self.execute(base + ["ps", "--format", "json", "api", "worker"])
                    rows = [json.loads(line) for line in result.stdout.decode().splitlines() if line.strip()]
                    if {row.get("Service") for row in rows if row.get("State") == "running"} != {"api", "worker"}:
                        raise BackupError("RESTORE_SERVICES_UNHEALTHY")
                except BackupError:
                    raise
                except Exception:
                    raise BackupError("RESTORE_API_UNHEALTHY") from None
        else:
            command = self.config.get("testServicesCommand")
            if command:
                self.execute(command + [action], timeout=15)


CATALOG_SQL = r"""
WITH relation AS (
 SELECT c.*,pg_get_userbyid(c.relowner) owner FROM pg_class c
 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
 AND c.relkind IN ('r','p','v','m','S','f')
), object AS (
 SELECT r.relname name,r.relkind kind,r.owner,r.relrowsecurity rls,r.relforcerowsecurity force_rls,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
   'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
   'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type)
   FROM aclexplode(COALESCE(r.relacl,acldefault(CASE WHEN r.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,r.relowner))) a),'[]') acl,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
   'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
   'default',pg_get_expr(d.adbin,d.adrelid),'acl',a.attacl::text) ORDER BY a.attnum)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),'[]') columns,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,
   'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN role=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role) END ORDER BY role) FROM unnest(p.polroles) role),
   'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)
   FROM pg_policy p WHERE p.polrelid=r.oid),'[]') policies,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid,true)) ORDER BY c.conname)
   FROM pg_constraint c WHERE c.conrelid=r.oid),'[]') constraints,
 COALESCE((SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text)
   FROM pg_index i WHERE i.indrelid=r.oid),'[]') indexes,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,
   'definition',pg_get_triggerdef(t.oid,true)) ORDER BY t.tgname)
   FROM pg_trigger t WHERE t.tgrelid=r.oid AND NOT t.tgisinternal),'[]') triggers,
 CASE WHEN r.relkind IN ('v','m') THEN pg_get_viewdef(r.oid,true) ELSE NULL END view_definition
 FROM relation r
), functions AS (
 SELECT p.oid,p.proowner,pg_get_userbyid(p.proowner) owner,p.proname name,
 pg_get_function_identity_arguments(p.oid) arguments,pg_get_functiondef(p.oid) definition,
 COALESCE(p.proacl,acldefault('f',p.proowner))::text acl
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prokind IN ('f','p')
), relevant_role AS (
 SELECT relowner oid FROM relation UNION SELECT proowner FROM functions
 UNION SELECT nspowner FROM pg_namespace WHERE nspname='public'
 UNION SELECT datdba FROM pg_database WHERE datname=current_database()
 UNION SELECT oid FROM pg_roles WHERE rolname='regi_app'
 UNION SELECT (aclexplode(relacl)).grantee FROM relation
 UNION SELECT unnest(polroles) FROM pg_policy WHERE polrelid IN (SELECT oid FROM relation)
)
SELECT jsonb_build_object(
 'objects',COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.name) FROM object o),'[]'),
 'functions',COALESCE((SELECT jsonb_agg(to_jsonb(f)-'oid'-'proowner' ORDER BY f.name,f.arguments) FROM functions f),'[]'),
 'schema',(SELECT jsonb_build_object('owner',pg_get_userbyid(nspowner),'acl',COALESCE(nspacl,acldefault('n',nspowner))::text) FROM pg_namespace WHERE nspname='public'),
 'defaults',COALESCE((SELECT jsonb_agg(jsonb_build_object('owner',pg_get_userbyid(defaclrole),'schema',COALESCE(n.nspname,''),'kind',defaclobjtype,'acl',defaclacl::text) ORDER BY defaclrole,defaclnamespace,defaclobjtype) FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE defaclnamespace=0 OR n.nspname='public'),'[]'),
 'roles',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',rolname,'super',rolsuper,'bypass_rls',rolbypassrls,'create_db',rolcreatedb,'create_role',rolcreaterole,'replication',rolreplication,'login',rolcanlogin,'inherit',rolinherit) ORDER BY rolname) FROM pg_roles WHERE oid IN (SELECT oid FROM relevant_role)),'[]')
);
"""


DATABASE_SQL = """
SELECT jsonb_build_object('owner',pg_get_userbyid(datdba),'encoding',pg_encoding_to_char(encoding),
 'collate',datcollate,'ctype',datctype,'provider',datlocprovider,'locale',datlocale,
 'connection_limit',datconnlimit,
 'acl',(SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
   'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
   'privilege',a.privilege_type,'grantable',a.is_grantable)
   ORDER BY pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type)
   FROM aclexplode(COALESCE(datacl,acldefault('d',datdba))) a),
 'database_bytes',pg_database_size(current_database()),
 'server_major',current_setting('server_version_num')::int/10000)
FROM pg_database WHERE datname=current_database();
"""


def migration_files(tools):
    path = tools.config.get("migrationDirectory")
    if tools.backend != "compose" and path:
        result = {}
        for item in sorted(Path(path).glob("[0-9][0-9][0-9]_*/migration.sql")):
            result[item.parent.name[:3]] = sha256_file(item)
        return result
    source = "const fs=require('fs'),c=require('crypto'),p='apps/api/prisma/migrations';console.log(JSON.stringify(Object.fromEntries(fs.readdirSync(p).filter(n=>/^\\d{3}_/.test(n)).sort().map(n=>[n.slice(0,3),c.createHash('sha256').update(fs.readFileSync(p+'/'+n+'/migration.sql')).digest('hex')]))));"
    result = tools.execute(["docker", "run", "--rm", "--network", "none", "--entrypoint", "node", "regi:sandbox", "-e", source])
    return json.loads(result.stdout)


def inspect_database(tools, database, snapshot=None):
    query = lambda source: tools.query(database, source, snapshot)
    current = query("SELECT jsonb_build_object('super',rolsuper) FROM pg_roles WHERE rolname=current_user;")
    if current.get("super") is not True:
        raise BackupError("DATABASE_SUPERUSER_REQUIRED")
    metadata = query(CATALOG_SQL)
    app = next((item for item in metadata["roles"] if item["name"] == "regi_app"), None)
    if not app or not app["login"] or any(app[key] for key in ("super", "bypass_rls", "create_db", "create_role", "replication")):
        raise BackupError("APPLICATION_ROLE_UNSAFE")
    tables = [item for item in metadata["objects"] if item["kind"] in ("r", "p")]
    counts = {}
    for table in tables:
        protected = table["name"] == "tenants" or any(column["name"] == "tenant_id" for column in table["columns"]) or bool(table["policies"])
        if protected and not (table["rls"] and table["force_rls"]):
            raise BackupError("TENANT_RLS_UNSAFE")
        name = table["name"]
        counts[name] = query("SELECT to_jsonb(count(*)) FROM public." + identifier(name) + ";")
    if "regi_migrations" not in counts:
        raise BackupError("MIGRATION_LEDGER_MISSING")
    migrations = query("SELECT COALESCE(jsonb_agg(jsonb_build_object('version',version,'checksum',checksum) ORDER BY version),'[]') FROM public.regi_migrations;")
    hashes = migration_files(tools)
    if not migrations or {row["version"]: row["checksum"] for row in migrations} != hashes:
        raise BackupError("MIGRATION_CHECKSUM_MISMATCH")
    return {"catalog": metadata, "counts": counts, "migrations": migrations, "migration_files": hashes}


@contextmanager
def exclusive(tools):
    with (tools.private / "operation.lock").open("a") as handle:
        os.chmod(handle.name, 0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BackupError("DATABASE_OPERATION_BUSY") from None
        yield


def upload_object(config, key, path, snapshot_id, dump_sha):
    if Path(path).stat().st_size > 5000000000:
        raise BackupError("BACKUP_SINGLE_PUT_TOO_LARGE")
    bucket = config.get("backupBucket", "")
    region = config.get("backupRegion", "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket) or region != "ap-northeast-1" or not key.startswith("pg/"):
        raise BackupError("BACKUP_DESTINATION_INVALID")
    try:
        response = subprocess.run(["aws", "s3api", "put-object", "--bucket", bucket, "--key", key,
                                   "--body", str(path), "--server-side-encryption", "AES256", "--metadata",
                                   "snapshot-id=" + snapshot_id + ",dump-sha256=" + dump_sha,
                                   "--region", region, "--output", "json"],
                                  check=True, capture_output=True, text=True, timeout=90)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        raise BackupError("BACKUP_UPLOAD_FAILED") from None
    version = json.loads(response.stdout).get("VersionId")
    if not isinstance(version, str) or not version or version == "null":
        raise BackupError("BACKUP_VERSION_MISSING")
    return version


def backup(tools, local_directory=None, reason="manual"):
    with exclusive(tools):
        now = datetime.datetime.now(datetime.timezone.utc)
        snapshot_id = str(uuid.uuid4())
        directory = Path(local_directory) if local_directory else tools.private / snapshot_id
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        try:
            dump = directory / "backup.dump.gz"
            manifest_path = directory / "backup.manifest.json"
            database = tools.config["database"]
            with tools.snapshot(database) as exported:
                source = tools.query(database, DATABASE_SQL, exported)
                if source["server_major"] != 17:
                    raise BackupError("POSTGRESQL_17_REQUIRED")
                data = inspect_database(tools, database, exported)
                archive_bytes = tools.dump(database, exported, dump)
            digest = sha256_file(dump)
            manifest = {"format": 1, "snapshot_id": snapshot_id, "created_at": now.isoformat(), "reason": reason,
                        "source": source, "database": data, "dump_sha256": digest, "dump_bytes": dump.stat().st_size,
                        "archive_bytes": archive_bytes}
            receipt = {"status": "complete", "snapshot_id": snapshot_id, "created_at": manifest["created_at"],
                       "dump_sha256": digest, "reason": reason,
                       "dump_key": None, "dump_version_id": None, "manifest_key": None, "manifest_version_id": None}
            if not local_directory:
                key = now.strftime("pg/%Y/%m/%d/%H")
                version = upload_object(tools.config, key + ".dump.gz", dump, snapshot_id, digest)
                manifest["s3_dump"] = {"key": key + ".dump.gz", "version_id": version}
                private_json(manifest_path, manifest)
                manifest_version = upload_object(tools.config, key + ".manifest.json", manifest_path, snapshot_id, digest)
                receipt.update(dump_key=key + ".dump.gz", dump_version_id=version,
                               manifest_key=key + ".manifest.json", manifest_version_id=manifest_version,
                               manifest_sha256=sha256_file(manifest_path))
            else:
                private_json(manifest_path, manifest)
                receipt["manifest_sha256"] = sha256_file(manifest_path)
            private_json(tools.private / "last-backup.json", receipt)
            private_json(tools.private / "last-successful-backup.json", receipt)
            private_json(tools.private / "receipts" / (snapshot_id + ".json"), receipt)
            return receipt
        finally:
            if not local_directory:
                shutil.rmtree(directory, ignore_errors=True)


def verify(tools, database, manifest):
    with tools.snapshot(database) as exported:
        source = tools.query(database, DATABASE_SQL, exported)
        expected = dict(manifest["source"])
        # Candidate connections remain superuser-only until cutover.
        source.pop("connection_limit", None)
        expected.pop("connection_limit", None)
        source.pop("database_bytes", None)
        expected.pop("database_bytes", None)
        if source != expected:
            raise BackupError("RESTORE_DATABASE_METADATA_MISMATCH")
        actual = inspect_database(tools, database, exported)
    if actual != manifest["database"]:
        raise BackupError("RESTORE_VERIFICATION_FAILED")


def create_database(tools, name, source):
    provider = {"c": "libc", "i": "icu", "b": "builtin"}.get(source["provider"])
    if not provider:
        raise BackupError("DATABASE_LOCALE_UNSUPPORTED")
    options = " TEMPLATE template0 OWNER " + identifier(source["owner"]) + " CONNECTION LIMIT 0 ENCODING " + literal(source["encoding"])
    options += " LC_COLLATE " + literal(source["collate"]) + " LC_CTYPE " + literal(source["ctype"]) + " LOCALE_PROVIDER " + provider
    if provider != "libc":
        options += (" ICU_LOCALE " if provider == "icu" else " BUILTIN_LOCALE ") + literal(source["locale"])
    tools.sql("postgres", "CREATE DATABASE " + identifier(name) + options + ";")


def restore_database_acl(tools, database, source):
    name = identifier(database)
    grants = source.get("acl") or []
    grantees = {source["owner"], "PUBLIC"} | {grant["grantee"] for grant in grants}
    for grantee in grantees:
        role = "PUBLIC" if grantee == "PUBLIC" else identifier(grantee)
        tools.sql("postgres", "REVOKE ALL ON DATABASE " + name + " FROM " + role + ";")
    pending = sorted(grants, key=lambda grant: (grant["grantor"] != source["owner"], not grant["grantable"]))
    # Grant options can form dependencies; reproduce each original grantor only once permitted.
    while pending:
        remaining = []
        for grant in pending:
            if grant["privilege"] not in ("CREATE", "CONNECT", "TEMPORARY") or type(grant["grantable"]) is not bool:
                raise BackupError("RESTORE_DATABASE_ACL_INVALID")
            role = "PUBLIC" if grant["grantee"] == "PUBLIC" else identifier(grant["grantee"])
            sql = "SET ROLE " + identifier(grant["grantor"]) + "; GRANT " + grant["privilege"] + " ON DATABASE " + name + " TO " + role
            sql += " WITH GRANT OPTION" if grant["grantable"] else ""
            try:
                tools.sql("postgres", sql + "; RESET ROLE;")
            except BackupError:
                remaining.append(grant)
        if len(remaining) == len(pending):
            raise BackupError("RESTORE_DATABASE_ACL_FAILED")
        pending = remaining


def database_exists(tools, name):
    return tools.query("postgres", "SELECT to_jsonb(EXISTS(SELECT FROM pg_database WHERE datname=" + literal(name) + "));")


def connections(tools, name, allowed, limit=0):
    tools.sql("postgres", "ALTER DATABASE " + identifier(name) + " WITH ALLOW_CONNECTIONS " + ("true" if allowed else "false") + " CONNECTION LIMIT " + str(int(limit)) + ";")
    if not allowed:
        tools.sql("postgres", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=" + literal(name) + " AND pid<>pg_backend_pid();")


def rename_database(tools, source, target):
    tools.sql("postgres", "ALTER DATABASE " + identifier(source) + " RENAME TO " + identifier(target) + ";")


def restore(tools, dump, manifest_path=None, verify_only=False):
    dump = Path(dump)
    if manifest_path is None:
        manifest_path = str(dump).removesuffix(".dump.gz") + ".manifest.json"
    manifest = json.loads(Path(manifest_path).read_text())
    if manifest.get("format") != 1 or not isinstance(manifest.get("snapshot_id"), str):
        raise BackupError("RESTORE_MANIFEST_INVALID")
    if sha256_file(dump) != manifest.get("dump_sha256") or dump.stat().st_size != manifest.get("dump_bytes"):
        raise BackupError("RESTORE_DUMP_CHECKSUM_MISMATCH")
    if manifest["source"]["server_major"] != 17:
        raise BackupError("POSTGRESQL_17_REQUIRED")
    size = manifest["source"].get("database_bytes")
    archive_bytes = manifest.get("archive_bytes")
    if not isinstance(size, int) or size <= 0 or not isinstance(archive_bytes, int) or archive_bytes <= 0:
        raise BackupError("RESTORE_SIZE_MANIFEST_INVALID")
    required = size * 2 + archive_bytes + 1024 ** 3
    if shutil.disk_usage(tools.private).free < required:
        raise BackupError("RESTORE_INSUFFICIENT_SPACE")
    with exclusive(tools):
        suffix = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S") + "_" + uuid.uuid4().hex[:8]
        candidate = "regi_restore_" + suffix
        previous = "regi_previous_" + suffix
        source = tools.config["database"]
        journal = {"snapshot_id": manifest["snapshot_id"], "candidate_database": candidate,
                   "previous_database": previous, "database": source, "phase": "candidate-create",
                   "database_state": "candidate-only", "service_state": "unchanged"}
        journal["started_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        private_json(tools.private / "last-restore.json", journal)
        create_database(tools, candidate, manifest["source"])
        with tempfile.NamedTemporaryFile(dir=str(tools.private)) as archive:
            try:
                with gzip.open(dump, "rb") as handle:
                    expanded = 0
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        expanded += len(chunk)
                        if expanded > archive_bytes:
                            raise BackupError("RESTORE_ARCHIVE_SIZE_MISMATCH")
                        archive.write(chunk)
                    if expanded != archive_bytes:
                        raise BackupError("RESTORE_ARCHIVE_SIZE_MISMATCH")
                archive.flush()
            except (OSError, EOFError):
                raise BackupError("RESTORE_ARCHIVE_INVALID") from None
            tools.restore(candidate, Path(archive.name))
        restore_database_acl(tools, candidate, manifest["source"])
        verify(tools, candidate, manifest)
        journal["phase"] = "verified"
        private_json(tools.private / "last-restore.json", journal)
        if verify_only:
            return journal
        stop_attempted = False
        try:
            stop_attempted = True
            journal["service_state"] = "stopping"
            private_json(tools.private / "last-restore.json", journal)
            tools.services("stop")
            journal["phase"] = "services-stopped"
            journal["service_state"] = "stopped"
            private_json(tools.private / "last-restore.json", journal)
            connections(tools, source, False)
            rename_database(tools, source, previous)
            journal["phase"] = "previous-renamed"
            journal["database_state"] = "original-retained"
            private_json(tools.private / "last-restore.json", journal)
            connections(tools, candidate, False)
            rename_database(tools, candidate, source)
            connections(tools, source, True, manifest["source"]["connection_limit"])
            journal["database_state"] = "snapshot-active"
            private_json(tools.private / "last-restore.json", journal)
            verify(tools, source, manifest)
            journal["service_state"] = "starting"
            private_json(tools.private / "last-restore.json", journal)
            tools.services("start")
            journal["phase"] = "complete"
            journal["service_state"] = "running"
            journal["completed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            private_json(tools.private / "last-restore.json", journal)
            return journal
        except Exception:
            try:
                if stop_attempted:
                    journal["service_state"] = "stopping-for-rollback"
                    private_json(tools.private / "last-restore.json", journal)
                    tools.services("stop")
                if database_exists(tools, previous):
                    if database_exists(tools, source):
                        connections(tools, source, False)
                        rename_database(tools, source, candidate)
                    rename_database(tools, previous, source)
                connections(tools, source, True, manifest["source"]["connection_limit"])
                journal["database_state"] = "original-restored"
                journal["service_state"] = "stopped"
                private_json(tools.private / "last-restore.json", journal)
                if stop_attempted:
                    journal["service_state"] = "restarting-original"
                    private_json(tools.private / "last-restore.json", journal)
                    tools.services("start")
                journal["phase"] = "rolled-back"
                journal["service_state"] = "running"
                journal["completed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                private_json(tools.private / "last-restore.json", journal)
            except Exception:
                journal["phase"] = "rollback-failed-operator-required"
                journal["service_state"] = "operator-required"
                private_json(tools.private / "last-restore.json", journal)
                raise BackupError("RESTORE_ROLLBACK_FAILED") from None
            raise BackupError("RESTORE_ROLLED_BACK") from None


def interrupted(signum, frame):
    raise BackupError("OPERATION_INTERRUPTED")


def main():
    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description="REGI private PostgreSQL backup/restore")
    subparsers = parser.add_subparsers(dest="action", required=True)
    backup_parser = subparsers.add_parser("backup")
    backup_parser.add_argument("--reason", choices=("manual", "hourly", "startup", "stop"), default="manual")
    backup_parser.add_argument("--local-dir")
    restore_parser = subparsers.add_parser("restore")
    restore_parser.add_argument("dump")
    restore_parser.add_argument("--manifest")
    restore_parser.add_argument("--verify-only", action="store_true")
    options = parser.parse_args()
    tools = None
    try:
        tools = DatabaseTools(configuration(os.environ.get("REGI_BACKUP_CONFIG", "/opt/regi/backup.json")))
        if options.action == "backup":
            result = backup(tools, options.local_dir, options.reason)
            print("REGI backup complete snapshot_id=" + result["snapshot_id"])
        else:
            result = restore(tools, options.dump, options.manifest, options.verify_only)
            print("REGI restore " + result["phase"] + " candidate=" + result["candidate_database"] + " previous=" + result["previous_database"])
    except Exception as error:
        code = error.code if isinstance(error, BackupError) else "OPERATION_FAILED"
        if tools and options.action == "backup":
            try:
                private_json(tools.private / "last-backup.json", {"status": "failed", "code": code, "reason": options.reason,
                             "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
            except OSError:
                code = "BACKUP_FAILURE_RECORD_UNAVAILABLE"
        print("REGI " + options.action + " failed code=" + code + "; no credentials logged", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
