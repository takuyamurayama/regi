import copy
import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote, urlparse
from contextlib import nullcontext, redirect_stderr
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
HOST = ROOT / "infra/sandbox/host"
sys.path.insert(0, str(HOST))
import database_backup as backup
import install_host


class BackupUnitTests(unittest.TestCase):
    def test_restart_requires_real_api_health_and_both_compose_services_running(self):
        with tempfile.TemporaryDirectory() as directory:
            tools = backup.DatabaseTools({"backend": "compose", "database": "regi", "user": "regi_owner", "privateDirectory": directory})
            states = b'{"Service":"api","State":"running"}\n{"Service":"worker","State":"running"}\n'
            outputs = [subprocess.CompletedProcess([], 0, b"", b""), subprocess.CompletedProcess([], 0, states, b"")]
            with patch.object(tools, "execute", side_effect=outputs) as commands, patch.object(backup, "urlopen", return_value=nullcontext(SimpleNamespace(status=200))) as health:
                tools.services("start")
                health.assert_called_once_with("http://127.0.0.1:3000/health", timeout=5)
                self.assertIn("--wait", commands.call_args_list[0].args[0])
                self.assertIn("worker", commands.call_args_list[1].args[0])
            with patch.object(tools, "execute", return_value=outputs[0]), patch.object(backup, "urlopen", return_value=nullcontext(SimpleNamespace(status=500))):
                with self.assertRaisesRegex(backup.BackupError, "RESTORE_API_UNHEALTHY"):
                    tools.services("start")
            bad = subprocess.CompletedProcess([], 0, states.replace(b'"worker","State":"running"', b'"worker","State":"restarting"'), b"")
            with patch.object(tools, "execute", side_effect=[outputs[0], bad]), patch.object(backup, "urlopen", return_value=nullcontext(SimpleNamespace(status=200))):
                with self.assertRaisesRegex(backup.BackupError, "RESTORE_SERVICES_UNHEALTHY"):
                    tools.services("start")

    def test_identifiers_private_json_and_streaming_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            backup.private_json(path, {"snapshot_id": "synthetic"})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(backup.sha256_file(path), hashlib.sha256(path.read_bytes()).hexdigest())
        for value in ("db;DROP DATABASE regi", "../database", "", "x" * 64):
            with self.assertRaises(backup.BackupError):
                backup.identifier(value)
        self.assertEqual(backup.literal("quote's"), "'quote''s'")

    def test_upload_is_single_put_sse_with_version_and_conservative_size_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dump.gz"
            path.write_bytes(b"synthetic")
            config = {"backupBucket": "synthetic-backups", "backupRegion": "ap-northeast-1"}
            with patch.object(backup.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, '{"VersionId":"synthetic-version"}', "")) as command:
                self.assertEqual(backup.upload_object(config, "pg/2026/10/02/01.dump.gz", path, "synthetic-snapshot", "0" * 64), "synthetic-version")
                arguments = command.call_args.args[0]
                self.assertEqual(arguments[:3], ["aws", "s3api", "put-object"])
                self.assertIn("AES256", arguments)
                self.assertIn("--body", arguments)
                self.assertFalse(any(word in " ".join(arguments) for word in ("get-object", "head-object", "list-objects", "delete-object")))
            with path.open("wb") as handle:
                handle.truncate(5000000001)
            with patch.object(backup.subprocess, "run") as command:
                with self.assertRaisesRegex(backup.BackupError, "SINGLE_PUT_TOO_LARGE"):
                    backup.upload_object(config, "pg/2026/10/02/01.dump.gz", path, "snapshot", "0" * 64)
                command.assert_not_called()

    def test_credentials_are_environment_only_and_child_errors_are_fixed(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {"backend": "local", "database": "regi_backup_test_unit", "user": "postgres", "privateDirectory": directory}
            with patch.dict(os.environ, {"SANDBOX_TEST_ADMIN_DATABASE_URL": "postgresql://postgres:synthetic-private-password@localhost:5432/postgres"}):
                tools = backup.DatabaseTools(config)
            with patch.object(backup.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["psql"], stderr="synthetic-private-password")) as command:
                with self.assertRaisesRegex(backup.BackupError, "DATABASE_COMMAND_FAILED") as failure:
                    tools.sql(config["database"], "SELECT 1;")
                arguments = command.call_args.args[0]
                self.assertNotIn("synthetic-private-password", " ".join(arguments))
                self.assertNotIn("postgresql://", " ".join(arguments))
                self.assertNotIn("synthetic-private-password", str(failure.exception))
                self.assertEqual(command.call_args.kwargs["env"]["PGPASSWORD"], "synthetic-private-password")
            diagnostic = io.StringIO()
            with patch.object(backup, "configuration", return_value=config), patch.object(backup, "DatabaseTools", return_value=tools), patch.object(backup, "backup", side_effect=backup.BackupError("OPERATION_FAILED")), patch.object(backup, "private_json", side_effect=OSError("synthetic-private-password")), patch.object(backup.signal, "signal"), patch.object(sys, "argv", ["database_backup.py", "backup", "--local-dir", directory]), redirect_stderr(diagnostic):
                self.assertEqual(backup.main(), 1)
            self.assertIn("BACKUP_FAILURE_RECORD_UNAVAILABLE", diagnostic.getvalue())
            self.assertNotIn("synthetic-private-password", diagnostic.getvalue())

    def test_host_file_set_and_hashes_are_verified_before_any_install(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for name in install_host.FILES:
                (target / name).write_text("synthetic " + name)
            hashes = {name: backup.sha256_file(target / name) for name in install_host.FILES}
            install_host.validate(target, hashes)
            with self.assertRaises(ValueError):
                install_host.validate(target, {**hashes, "../private": "0" * 64})
            (target / "install_host.py").write_text("tampered")
            with self.assertRaises(ValueError):
                install_host.validate(target, hashes)
            (target / "install_host.py").unlink()
            (target / "install_host.py").symlink_to(target / "bootstrap.py")
            with self.assertRaises(ValueError):
                install_host.validate(target, hashes)
        source = (HOST / "user-data.sh.tftpl").read_text()
        self.assertLess(source.index("REGI initial host checksum mismatch"), source.index("chmod 700 /opt/regi/bootstrap.sh"))
        self.assertLess(source.index("REGI initial host checksum mismatch"), source.index("/opt/regi/install-host.sh\n"))

    def test_failed_refresh_keeps_all_old_files_and_never_restarts_application(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for name in install_host.FILES:
                (target / name).write_text("old " + name)
            (target / "host.json").write_text(json.dumps({"runtimePath": "/synthetic/runtime", "bucket": "synthetic-release", "name": "synthetic", "region": "ap-northeast-1"}))
            hashes = {name: hashlib.sha256(("new " + name).encode()).hexdigest() for name in install_host.FILES}

            def download(arguments, **kwargs):
                destination = Path(arguments[4])
                destination.write_text("tampered" if destination.name == "install_host.py" else "new " + destination.name)
                return subprocess.CompletedProcess(arguments, 0)

            with patch("credentials.aws", return_value={"Parameter": {"Value": json.dumps({"bootstrapSha256": hashes})}}), patch.object(install_host.subprocess, "run", side_effect=download), patch.object(install_host, "install") as install:
                with self.assertRaises(ValueError):
                    install_host.refresh(target)
                install.assert_not_called()
            for name in install_host.FILES:
                self.assertEqual((target / name).read_text(), "old " + name)


class BackupPostgresTests(unittest.TestCase):
    """Actual pg_dump/pg_restore, always in unique databases and without real AWS."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="regi-backup-test-")
        self.directory = Path(self.temporary.name)
        self.database = "regi_backup_test_" + uuid.uuid4().hex[:12]
        self.created = {self.database}
        admin = urlparse(os.environ.get("SANDBOX_TEST_ADMIN_DATABASE_URL", "postgresql://postgres@localhost:5432/postgres"))
        self.config = {"backend": "container" if os.environ.get("POSTGRES_TEST_CONTAINER") else "local",
                       "database": self.database, "user": unquote(admin.username or "postgres"),
                       "privateDirectory": str(self.directory / "private"),
                       "migrationDirectory": str(ROOT / "apps/api/prisma/migrations"),
                       "backupBucket": "synthetic-backups", "backupRegion": "ap-northeast-1"}
        self.configuration = self.directory / "config.json"
        backup.private_json(self.configuration, self.config)
        self.environment = {**os.environ, "NODE_ENV": "test", "REGI_BACKUP_CONFIG": str(self.configuration)}
        self.tools = backup.DatabaseTools(self.config)
        self.tools.sql("postgres", "CREATE DATABASE " + backup.identifier(self.database) + " OWNER regi_owner;")
        self.tools.sql(self.database, "SET ROLE regi_owner; CREATE TABLE regi_migrations(version text PRIMARY KEY,checksum text NOT NULL); RESET ROLE;")
        for path in sorted(Path(self.config["migrationDirectory"]).glob("[0-9][0-9][0-9]_*/migration.sql")):
            self.tools.sql(self.database, "BEGIN; SET LOCAL ROLE regi_owner;\n" + path.read_text() + "\nINSERT INTO regi_migrations VALUES(" + backup.literal(path.parent.name[:3]) + "," + backup.literal(backup.sha256_file(path)) + "); COMMIT;")
        tenant, store, staff, device = [str(uuid.uuid4()) for _ in range(4)]
        values = [backup.literal(value) for value in (tenant, store, staff, device)]
        self.tenant = tenant
        self.tools.sql(self.database, """
        INSERT INTO tenants VALUES(%s,'synthetic','inclusive',now(),now()+interval '1 year',1);
        INSERT INTO stores VALUES(%s,%s,'synthetic');
        INSERT INTO staff VALUES(%s,%s,'backup-synthetic','synthetic','admin',ARRAY[%s]::uuid[],'synthetic-not-a-real-pin',true);
        INSERT INTO devices(id,tenant_id,store_id,name) VALUES(%s,%s,%s,'synthetic');
        INSERT INTO device_event_quarantine(tenant_id,id,store_id,device_id,sequence,hash,status,result,body)
          VALUES(%s,gen_random_uuid(),%s,%s,1,'synthetic','waiting','{}','{}');
        INSERT INTO operations(tenant_id,id,hash,result) VALUES(%s,gen_random_uuid(),'synthetic','{"amount":"5280000"}');
        SET ROLE regi_owner;
        CREATE TABLE future_financial_ledger(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),amount bigint NOT NULL);
        ALTER TABLE future_financial_ledger ENABLE ROW LEVEL SECURITY;
        ALTER TABLE future_financial_ledger FORCE ROW LEVEL SECURITY;
        CREATE POLICY isolation ON future_financial_ledger USING(tenant_visible(tenant_id)) WITH CHECK(tenant_visible(tenant_id));
        GRANT SELECT ON future_financial_ledger TO regi_app;
        RESET ROLE;
        INSERT INTO future_financial_ledger VALUES(gen_random_uuid(),%s,5280000);
        """ % (values[0], values[1], values[0], values[2], values[0], values[1], values[3], values[0], values[1], values[0], values[1], values[3], values[0], values[0]))
        self.local = self.directory / "snapshot"

    def tearDown(self):
        self.record_databases()
        try:
            for name in self.created:
                self.tools.sql("postgres", "DROP DATABASE IF EXISTS " + backup.identifier(name) + " WITH (FORCE);")
        finally:
            self.temporary.cleanup()

    def record_databases(self):
        journal = Path(self.config["privateDirectory"]) / "last-restore.json"
        if journal.exists():
            data = json.loads(journal.read_text())
            self.created.update(data[key] for key in ("candidate_database", "previous_database"))

    def cli(self, action, arguments=(), expected=0, environment=None):
        result = subprocess.run(["bash", str(HOST / (action + ".sh")), *map(str, arguments)], env=environment or self.environment,
                                capture_output=True, text=True, timeout=90)
        self.record_databases()
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        self.assertNotIn("postgresql://", result.stdout + result.stderr)
        self.assertNotIn("synthetic-private-password", result.stdout + result.stderr)
        return result

    def make_backup(self):
        self.cli("backup", ("--local-dir", self.local))
        self.manifest_path = self.local / "backup.manifest.json"
        self.dump = self.local / "backup.dump.gz"
        return json.loads(self.manifest_path.read_text())

    def journal(self):
        return json.loads((Path(self.config["privateDirectory"]) / "last-restore.json").read_text())

    def test_actual_cli_roundtrip_preserves_dynamic_tables_owner_acl_force_rls_and_checksums(self):
        manifest = self.make_backup()
        self.assertEqual(manifest["database"]["counts"]["future_financial_ledger"], 1)
        self.assertEqual(manifest["database"]["counts"]["device_event_quarantine"], 1)
        self.assertEqual(len(manifest["database"]["migrations"]), 8)
        self.assertEqual(manifest["dump_sha256"], backup.sha256_file(self.dump))
        self.cli("restore", (self.dump, "--verify-only"))
        candidate = self.journal()["candidate_database"]
        self.assertEqual(self.journal()["phase"], "verified")
        self.assertEqual(self.tools.query(candidate, "SELECT to_jsonb(amount) FROM future_financial_ledger;"), 5280000)
        self.assertEqual(self.tools.query(candidate, "SELECT to_jsonb(relforcerowsecurity) FROM pg_class WHERE relname='future_financial_ledger';"), True)
        self.assertEqual(self.tools.query("postgres", "SELECT to_jsonb(datconnlimit) FROM pg_database WHERE datname=" + backup.literal(candidate) + ";"), 0)
        self.assertTrue(backup.database_exists(self.tools, self.database))

    def test_dump_and_counts_use_one_exported_snapshot_during_concurrent_committed_write(self):
        original = self.tools.dump

        def concurrent_write(database, snapshot, destination):
            self.tools.sql(database, "INSERT INTO future_financial_ledger VALUES(gen_random_uuid()," + backup.literal(self.tenant) + ",1);")
            return original(database, snapshot, destination)

        with patch.object(self.tools, "dump", side_effect=concurrent_write):
            backup.backup(self.tools, self.local)
        self.assertEqual(self.tools.query(self.database, "SELECT to_jsonb(count(*)) FROM future_financial_ledger;"), 2)
        self.cli("restore", (self.local / "backup.dump.gz", "--verify-only"))
        candidate = self.journal()["candidate_database"]
        self.assertEqual(self.tools.query(candidate, "SELECT to_jsonb(count(*)) FROM future_financial_ledger;"), 1)

    def test_explicit_database_acl_is_reproduced_on_candidate_without_granting_source(self):
        self.tools.sql("postgres", "REVOKE ALL ON DATABASE " + backup.identifier(self.database) + " FROM PUBLIC; GRANT CONNECT ON DATABASE " + backup.identifier(self.database) + " TO regi_app;")
        manifest = self.make_backup()
        self.cli("restore", (self.dump, "--verify-only"))
        candidate = self.journal()["candidate_database"]
        restored = self.tools.query(candidate, backup.DATABASE_SQL)
        self.assertEqual(restored["acl"], manifest["source"]["acl"])
        current = self.tools.query(self.database, backup.DATABASE_SQL)
        self.assertEqual(current["acl"], manifest["source"]["acl"])

    def test_client_timeouts_are_effective_in_actual_postgresql_session(self):
        settings = self.tools.query(self.database, "SELECT jsonb_build_object('statement',current_setting('statement_timeout'),'lock',current_setting('lock_timeout'));")
        self.assertEqual(settings, {"statement": "2min", "lock": "10s"})

    def test_restore_space_preflight_and_expansion_budget_fail_before_service_stop(self):
        manifest = self.make_backup()
        with patch.object(backup.shutil, "disk_usage", return_value=type("Usage", (), {"free": 0})()), patch.object(self.tools, "services") as services:
            with self.assertRaisesRegex(backup.BackupError, "RESTORE_INSUFFICIENT_SPACE"):
                backup.restore(self.tools, self.dump)
            services.assert_not_called()
        self.assertFalse((Path(self.config["privateDirectory"]) / "last-restore.json").exists())
        manifest["archive_bytes"] = 1
        backup.private_json(self.manifest_path, manifest)
        failure = self.cli("restore", (self.dump,), expected=1)
        self.assertIn("RESTORE_ARCHIVE_SIZE_MISMATCH", failure.stderr)
        self.assertEqual(self.tools.query(self.database, "SELECT to_jsonb(count(*)) FROM future_financial_ledger;"), 1)

    def test_corrupt_dump_or_gzip_is_refused_before_business_stop(self):
        manifest = self.make_backup()
        self.dump.write_bytes(b"corrupt")
        failure = self.cli("restore", (self.dump,), expected=1)
        self.assertIn("RESTORE_DUMP_CHECKSUM_MISMATCH", failure.stderr)
        manifest.update(dump_sha256=backup.sha256_file(self.dump), dump_bytes=self.dump.stat().st_size)
        backup.private_json(self.manifest_path, manifest)
        failure = self.cli("restore", (self.dump,), expected=1)
        self.assertIn("RESTORE_ARCHIVE_INVALID", failure.stderr)
        self.assertEqual(self.tools.query(self.database, "SELECT to_jsonb(count(*)) FROM future_financial_ledger;"), 1)

    def test_manifest_count_acl_or_role_flag_tampering_never_stops_business(self):
        manifest = self.make_backup()
        variants = []
        count = copy.deepcopy(manifest)
        count["database"]["counts"]["future_financial_ledger"] = 2
        variants.append(count)
        acl = copy.deepcopy(manifest)
        table = next(item for item in acl["database"]["catalog"]["objects"] if item["name"] == "future_financial_ledger")
        table["acl"] = []
        variants.append(acl)
        role = copy.deepcopy(manifest)
        next(item for item in role["database"]["catalog"]["roles"] if item["name"] == "regi_app")["super"] = True
        variants.append(role)
        for variant in variants:
            backup.private_json(self.manifest_path, variant)
            failure = self.cli("restore", (self.dump,), expected=1)
            self.assertIn("RESTORE_VERIFICATION_FAILED", failure.stderr)
            self.assertTrue(backup.database_exists(self.tools, self.database))

    def test_real_modified_rls_and_migration_ledger_are_refused(self):
        manifest = self.make_backup()
        for source, expected in (("ALTER TABLE future_financial_ledger NO FORCE ROW LEVEL SECURITY;", "TENANT_RLS_UNSAFE"),
                                 ("ALTER TABLE future_financial_ledger FORCE ROW LEVEL SECURITY; UPDATE regi_migrations SET checksum=repeat('0',64) WHERE version='007';", "MIGRATION_CHECKSUM_MISMATCH")):
            self.tools.sql(self.database, source)
            with self.tools.snapshot(self.database) as exported:
                archive_bytes = self.tools.dump(self.database, exported, self.dump)
            variant = copy.deepcopy(manifest)
            variant.update(dump_sha256=backup.sha256_file(self.dump), dump_bytes=self.dump.stat().st_size, archive_bytes=archive_bytes)
            backup.private_json(self.manifest_path, variant)
            failure = self.cli("restore", (self.dump,), expected=1)
            self.assertIn(expected, failure.stderr)
        self.assertTrue(backup.database_exists(self.tools, self.database))

    def service_stub(self, fail_once=False):
        script = self.directory / "services.py"
        log = self.directory / "services.log"
        script.write_text("import pathlib,sys\np=pathlib.Path(" + repr(str(log)) + ")\na=sys.argv[1]\nh=p.read_text() if p.exists() else ''\np.write_text(h+a+'\\n')\n" + ("raise SystemExit(1 if a=='start' and 'start' not in h else 0)\n" if fail_once else ""))
        self.config["testServicesCommand"] = [sys.executable, str(script)]
        backup.private_json(self.configuration, self.config)
        return log

    def test_cutover_preserves_old_database_and_only_stops_then_restarts_business_services(self):
        self.make_backup()
        self.tools.sql(self.database, "INSERT INTO future_financial_ledger VALUES(gen_random_uuid()," + backup.literal(self.tenant) + ",1);")
        log = self.service_stub()
        self.cli("restore", (self.dump,))
        record = self.journal()
        self.assertEqual(record["phase"], "complete")
        self.assertEqual(log.read_text().splitlines(), ["stop", "start"])
        self.assertEqual(self.tools.query(self.database, "SELECT to_jsonb(count(*)) FROM future_financial_ledger;"), 1)
        self.assertEqual(self.tools.query("postgres", "SELECT to_jsonb(datallowconn) FROM pg_database WHERE datname=" + backup.literal(record["previous_database"]) + ";"), False)
        backup.connections(self.tools, record["previous_database"], True, 0)
        self.assertEqual(self.tools.query(record["previous_database"], "SELECT to_jsonb(count(*)) FROM future_financial_ledger;"), 2)
        self.assertEqual(self.tools.query("postgres", "SELECT to_jsonb(datconnlimit) FROM pg_database WHERE datname=" + backup.literal(self.database) + ";"), -1)

    def test_failed_business_restart_rolls_back_actual_database_rename_and_preserves_new_candidate(self):
        self.make_backup()
        self.tools.sql(self.database, "INSERT INTO future_financial_ledger VALUES(gen_random_uuid()," + backup.literal(self.tenant) + ",1);")
        log = self.service_stub(fail_once=True)
        failure = self.cli("restore", (self.dump,), expected=1)
        self.assertIn("RESTORE_ROLLED_BACK", failure.stderr)
        record = self.journal()
        self.assertEqual(record["phase"], "rolled-back")
        self.assertEqual(record["database_state"], "original-restored")
        self.assertEqual(record["service_state"], "running")
        self.assertEqual(log.read_text().splitlines(), ["stop", "start", "stop", "start"])
        self.assertEqual(self.tools.query(self.database, "SELECT to_jsonb(count(*)) FROM future_financial_ledger;"), 2)
        self.assertTrue(backup.database_exists(self.tools, record["candidate_database"]))
        script = Path(self.config["testServicesCommand"][1])
        script.write_text(script.read_text().replace("raise SystemExit(1 if a=='start' and 'start' not in h else 0)", "raise SystemExit(1 if a=='start' else 0)"))
        failure = self.cli("restore", (self.dump,), expected=1)
        self.assertIn("RESTORE_ROLLBACK_FAILED", failure.stderr)
        record = self.journal()
        self.assertEqual(record["phase"], "rollback-failed-operator-required")
        self.assertEqual(record["database_state"], "original-restored")
        self.assertEqual(record["service_state"], "operator-required")
        self.assertEqual(self.tools.query(self.database, "SELECT to_jsonb(count(*)) FROM future_financial_ledger;"), 2)

    def test_local_backup_of_missing_force_rls_fails_and_records_fixed_failure(self):
        for table in ("future_financial_ledger", "tenants"):
            self.tools.sql(self.database, "ALTER TABLE " + backup.identifier(table) + " NO FORCE ROW LEVEL SECURITY;")
            result = self.cli("backup", ("--local-dir", self.local), expected=1)
            self.assertIn("TENANT_RLS_UNSAFE", result.stderr)
            receipt = json.loads((Path(self.config["privateDirectory"]) / "last-backup.json").read_text())
            self.assertEqual(receipt["status"], "failed")
            self.assertEqual(receipt["code"], "TENANT_RLS_UNSAFE")
            self.tools.sql(self.database, "ALTER TABLE " + backup.identifier(table) + " FORCE ROW LEVEL SECURITY;")

    def test_uploaded_pair_is_version_pinned_and_failed_manifest_never_counts_as_success_or_leaks_tempfiles(self):
        binary = self.directory / "bin"
        binary.mkdir()
        uploaded = self.directory / "uploaded"
        uploaded.mkdir()
        command_log = self.directory / "aws.jsonl"
        stub = binary / "aws"
        stub.write_text("#!/usr/bin/env python3\nimport json,os,pathlib,shutil,sys\na=sys.argv[1:]\nwith open(os.environ['BACKUP_AWS_TEST_LOG'],'a') as h: h.write(json.dumps(a)+'\\n')\nassert a[:2]==['s3api','put-object']\nkey=a[a.index('--key')+1]\nmanifest=key.endswith('.manifest.json')\nif manifest and os.environ.get('BACKUP_AWS_TEST_FAIL_MANIFEST')=='true': raise SystemExit(1)\nshutil.copyfile(a[a.index('--body')+1],pathlib.Path(os.environ['BACKUP_AWS_TEST_UPLOAD'])/('backup.manifest.json' if manifest else 'backup.dump.gz'))\nprint(json.dumps({'VersionId':'synthetic-manifest-v1' if manifest else 'synthetic-dump-v1'}))\n")
        stub.chmod(0o700)
        environment = {**self.environment, "PATH": str(binary) + ":" + os.environ["PATH"],
                       "BACKUP_AWS_TEST_LOG": str(command_log), "BACKUP_AWS_TEST_UPLOAD": str(uploaded)}
        self.cli("backup", ("--reason", "hourly"), environment=environment)
        private = Path(self.config["privateDirectory"])
        receipt = json.loads((private / "last-backup.json").read_text())
        manifest = json.loads((uploaded / "backup.manifest.json").read_text())
        self.assertEqual(receipt["status"], "complete")
        self.assertEqual(receipt["dump_version_id"], "synthetic-dump-v1")
        self.assertEqual(receipt["manifest_version_id"], "synthetic-manifest-v1")
        self.assertEqual(receipt["manifest_sha256"], backup.sha256_file(uploaded / "backup.manifest.json"))
        self.assertEqual(manifest["snapshot_id"], receipt["snapshot_id"])
        self.assertEqual(manifest["s3_dump"]["version_id"], receipt["dump_version_id"])
        calls = [json.loads(line) for line in command_log.read_text().splitlines()]
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call[:2] == ["s3api", "put-object"] and "AES256" in call for call in calls))
        self.assertEqual([path.name for path in private.iterdir() if path.is_dir()], ["receipts"])
        failure = self.cli("backup", ("--reason", "stop"), expected=1,
                           environment={**environment, "BACKUP_AWS_TEST_FAIL_MANIFEST": "true"})
        self.assertIn("BACKUP_UPLOAD_FAILED", failure.stderr)
        self.assertEqual(json.loads((private / "last-backup.json").read_text())["status"], "failed")
        self.assertEqual(json.loads((private / "last-successful-backup.json").read_text()), receipt)
        self.assertEqual([path.name for path in private.iterdir() if path.is_dir()], ["receipts"])


if __name__ == "__main__":
    unittest.main()
