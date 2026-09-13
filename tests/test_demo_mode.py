"""Tests for IBVAP Deterministic Demo Mode (Phase 26 & 27)."""

import os
import shutil
import sqlite3
import tempfile
import unittest

from demo.demo_engine import DemoEngine
from cryptography.fernet import Fernet


class TestDemoMode(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp, "test_incidents.db")
        self.rules_path = os.path.join(self.tmp, "test_rules.db")
        self.evidence_dir = os.path.join(self.tmp, "snapshots")
        self.key_path = os.path.join(self.tmp, "evidence.key")
        self.runtime_dir = os.path.join(self.tmp, "runtime")

        orig_rules = "database/threat_rules.db"
        if os.path.exists(orig_rules):
            shutil.copyfile(orig_rules, self.rules_path)

        self.engine = DemoEngine(
            camera_id="cam0",
            db_path=self.db_path,
            rules_path=self.rules_path,
            evidence_dir=self.evidence_dir,
            evidence_key_path=self.key_path,
            runtime_dir=self.runtime_dir,
        )

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_initial_state(self):
        status = self.engine.status()
        self.assertEqual(status["step"], 0)
        self.assertEqual(status["totalSteps"], 15)
        self.assertFalse(status["isRunning"])
        self.assertIsNone(status["currentIncidentId"])

    def test_step_by_step_execution(self):
        # Step 1: Initial detection
        res1 = self.engine.step()
        self.assertEqual(res1["step"], 1)
        self.assertIsNotNone(self.engine.current_detection)
        self.assertEqual(self.engine.current_detection.confidence, 0.94)

        # Step 2: Track ID assigned
        res2 = self.engine.step()
        self.assertEqual(res2["step"], 2)
        self.assertEqual(self.engine.current_detection.track_id, 17)

        # Step 3: Enters GREEN
        res3 = self.engine.step()
        self.assertEqual(res3["step"], 3)
        self.assertEqual(self.engine.current_detection.zone_tier, "green")

        # Step 4: Moves inward
        self.engine.step()
        # Step 5: Enters YELLOW
        self.engine.step()
        self.assertEqual(self.engine.step_index, 5)
        self.assertEqual(self.engine.current_detection.zone_tier, "yellow")

        # Step 6: Transition YELLOW -> RED
        res6 = self.engine.step()
        self.assertEqual(res6["step"], 6)
        self.assertEqual(self.engine.current_detection.zone_tier, "red")
        self.assertEqual(self.engine.current_detection.previous_zone, "yellow")

        # Steps 7-10: Confirmation, Threat Scoring (CRITICAL), Zone crossing event, Alert
        for _ in range(4):
            self.engine.step()
        self.assertEqual(self.engine.step_index, 10)
        self.assertIsNotNone(self.engine.current_score)
        self.assertGreaterEqual(self.engine.current_score.total, 90)
        self.assertEqual(self.engine.current_score.level, "CRITICAL")
        self.assertTrue(any("RED zone" in r for r in self.engine.current_score.reasons))

    def test_full_run_and_persistence(self):
        summary = self.engine.run_all(delay_seconds=0.0)
        self.assertEqual(summary["step"], 15)
        self.assertEqual(summary["totalSteps"], 15)
        self.assertIsNotNone(summary["currentIncidentId"])
        self.assertGreaterEqual(summary["latestScore"], 90)
        self.assertEqual(summary["latestLevel"], "CRITICAL")

        # Check SQLite persistence
        self.assertTrue(os.path.exists(self.db_path))
        conn = sqlite3.connect(self.db_path)
        cur = conn.cursor()
        cur.execute("SELECT id, track_id, threat_level, snapshot_path FROM incidents WHERE track_id=17")
        rows = cur.fetchall()
        conn.close()
        self.assertGreaterEqual(len(rows), 1)
        inc_id, track_id, threat_level, snap_path = rows[0]
        self.assertEqual(track_id, 17)
        self.assertEqual(threat_level, "CRITICAL")

        # Check evidence encryption
        self.assertTrue(os.path.exists(snap_path))
        with open(snap_path, "rb") as f:
            encrypted_data = f.read()
        with open(self.key_path, "rb") as f:
            key = f.read()
        fernet = Fernet(key)
        decrypted = fernet.decrypt(encrypted_data)
        self.assertGreater(len(decrypted), 0)

        # Check live frame was published
        live_frame_path = os.path.join(self.runtime_dir, "live", "cam0.jpg")
        self.assertTrue(os.path.exists(live_frame_path))

    def test_reset(self):
        self.engine.step()
        self.engine.step()
        self.assertEqual(self.engine.step_index, 2)
        res = self.engine.reset()
        self.assertEqual(res["step"], 0)
        self.assertEqual(self.engine.step_index, 0)
        self.assertIsNone(self.engine.current_detection)


if __name__ == "__main__":
    unittest.main()
