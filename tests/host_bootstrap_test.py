import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infra/sandbox/host"))
import bootstrap


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.demo = {"enabled": True, "tenant_id": "synthetic-test-tenant", "administrator_subject": "synthetic-external-subject", "end_day": "2026-10-01"}

    def tearDown(self):
        self.temporary.cleanup()

    def test_completed_seed_does_not_replay_after_normal_demo_operations(self):
        with patch.object(bootstrap, "compose") as compose:
            bootstrap.seed_demo_once(self.directory, self.demo)
            bootstrap.seed_demo_once(self.directory, self.demo)
            compose.assert_called_once_with("run", "--rm", "--user", "0", "maintenance", "npm", "run", "db:seed:sandbox")
        marker = self.directory / "demo-seed-completed.json"
        self.assertEqual(stat.S_IMODE(marker.stat().st_mode), 0o600)
        self.assertNotIn("adminPin", marker.read_text())

    def test_interrupted_seed_is_retried_not_marked_complete(self):
        with patch.object(bootstrap, "compose", side_effect=RuntimeError("seed interrupted")):
            with self.assertRaises(RuntimeError):
                bootstrap.seed_demo_once(self.directory, self.demo)
        self.assertFalse((self.directory / "demo-seed-completed.json").exists())
        with patch.object(bootstrap, "compose") as compose:
            bootstrap.seed_demo_once(self.directory, self.demo)
            self.assertEqual(compose.call_count, 1)

    def test_changed_tenant_subject_or_history_is_not_silently_replaced(self):
        with patch.object(bootstrap, "compose"):
            bootstrap.seed_demo_once(self.directory, self.demo)
        for field in ["tenant_id", "administrator_subject", "end_day"]:
            with patch.object(bootstrap, "compose") as compose:
                with self.assertRaises(ValueError):
                    bootstrap.seed_demo_once(self.directory, {**self.demo, field: "changed"})
                compose.assert_not_called()

    def test_shared_database_uri_avoids_prisma_only_connection_parameters(self):
        source = Path(bootstrap.__file__).read_text()
        self.assertNotIn("connection_limit=", source)
        self.assertIn('"@db:5432/regi"', source)
        from urllib.parse import urlparse
        self.assertEqual(urlparse("postgresql://regi_app:synthetic@db:5432/regi").query, "")

    def test_default_and_explicit_mfa_keep_no_password_only_exemption(self):
        expected = {"COGNITO_MFA_ENFORCED": "true", "REGI_PERSONAL_SANDBOX_PASSWORD_ONLY_TENANT_ID": ""}
        self.assertEqual(bootstrap.authentication_environment({"demo": self.demo}), expected)
        self.assertEqual(bootstrap.authentication_environment({"demo": self.demo, "requireMfa": True}), expected)

    def test_password_only_requires_synthetic_uuid_and_false_attestation(self):
        tenant = "00000000-0000-4000-8000-000000000001"
        environment = bootstrap.authentication_environment({"demo": {**self.demo, "tenant_id": tenant}, "requireMfa": False})
        self.assertEqual(environment, {"COGNITO_MFA_ENFORCED": "false", "REGI_PERSONAL_SANDBOX_PASSWORD_ONLY_TENANT_ID": tenant})
        with self.assertRaises(ValueError):
            bootstrap.authentication_environment({"demo": {**self.demo, "enabled": False}, "requireMfa": False})
        with self.assertRaises(ValueError):
            bootstrap.authentication_environment({"demo": self.demo, "requireMfa": False})
        with self.assertRaises(ValueError):
            bootstrap.authentication_environment({"demo": self.demo, "requireMfa": "false"})


if __name__ == "__main__":
    unittest.main()
