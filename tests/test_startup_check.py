"""Tests for IBVAP Startup Health Check (Phase 25 & 32)."""

import os
import shutil
import tempfile
import unittest
from unittest.mock import patch

from runtime.startup_check import StartupValidator, CheckResult


class TestStartupCheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp, "test_startup.db")
        self.evidence_dir = os.path.join(self.tmp, "snapshots")
        self.evidence_key = os.path.join(self.tmp, "evidence.key")
        self.validator = StartupValidator(
            db_path=self.db_path,
            evidence_dir=self.evidence_dir,
            evidence_key=self.evidence_key,
        )

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_check_database_success(self):
        res = self.validator.check_database()
        self.assertTrue(res.ok)
        self.assertEqual(res.status, "READY")
        self.assertIn("READY", res.details)

    def test_check_database_failure(self):
        # Point database to an invalid / read-only path
        bad_validator = StartupValidator(db_path="/proc/non_existent/bad.db")
        res = bad_validator.check_database()
        self.assertFalse(res.ok)
        self.assertEqual(res.status, "FAILED")

    def test_check_evidence_success(self):
        res = self.validator.check_evidence()
        self.assertTrue(res.ok)
        self.assertEqual(res.status, "READY")
        self.assertIn("snapshots", res.details)

    def test_check_models_real_or_missing(self):
        res_list = self.validator.check_models()
        self.assertEqual(len(res_list), 2)
        names = [r.name for r in res_list]
        self.assertIn("Detector Models", names)
        self.assertIn("Re-ID Models", names)

    @patch("os.path.isfile")
    def test_check_models_missing(self, mock_isfile):
        mock_isfile.return_value = False
        res_list = self.validator.check_models()
        for r in res_list:
            self.assertFalse(r.ok)
            self.assertEqual(r.status, "MISSING")

    def test_check_zones(self):
        res = self.validator.check_zones()
        self.assertTrue(res.ok)
        self.assertIn("camera profiles active", res.details)

    def test_run_all(self):
        critical_ok, all_checks = self.validator.run_all()
        self.assertIsInstance(critical_ok, bool)
        self.assertGreaterEqual(len(all_checks), 5)

    def test_print_summary(self):
        ok = self.validator.print_summary()
        self.assertIsInstance(ok, bool)


if __name__ == "__main__":
    unittest.main()
