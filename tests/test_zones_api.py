"""API tests for /zones (role round-trip), /zone-policy and /boundaries.

Confirmed gap before this file existed: no test exercised these endpoints at
all. Run from ibvap/: python -m unittest tests.test_zones_api
"""
import os
import shutil
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import integration.api as api_module
from zones.zone_policy import DEFAULT_ROLE_TIER

TOKEN = "zones-test-token-not-a-real-secret"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


class TestZonesRoleRoundTrip(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.policy_path = os.path.join(self.tmp, "zone_policy.json")

        def zones_path(cam_id):
            return os.path.join(self.tmp, f"zones_{cam_id}.json")

        def make_policy(config_path=None):
            from zones.zone_policy import ZonePolicy as RealZonePolicy

            return RealZonePolicy(config_path=self.policy_path)

        for p in (
            patch.object(api_module, "IBVAP_API_TOKEN", TOKEN),
            patch.object(api_module, "_camera_sources", lambda: {"cam0": 0}),
            patch.object(api_module, "_zones_path", zones_path),
            patch.object(api_module, "CAMERA_WIDTH", 640),
            patch.object(api_module, "CAMERA_HEIGHT", 480),
            patch.object(api_module, "ZonePolicy", make_policy),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.client = TestClient(api_module.app)

    def _square_points(self):
        return [{"x": 0.0, "y": 0.0}, {"x": 0.5, "y": 0.0}, {"x": 0.5, "y": 0.5}, {"x": 0.0, "y": 0.5}]

    def test_saving_a_zone_with_a_role_resolves_and_stores_the_tier(self):
        resp = self.client.put(
            "/api/v1/zones",
            headers=AUTH,
            json={"cam0": [{"id": "z1", "role": "restricted", "points": self._square_points()}]},
        )
        self.assertEqual(resp.status_code, 200)
        zone = resp.json()["cam0"][0]
        self.assertEqual(zone["role"], "restricted")
        self.assertEqual(zone["tier"], DEFAULT_ROLE_TIER["restricted"])

        # And it round-trips identically on a plain GET.
        got = self.client.get("/api/v1/zones", headers=AUTH).json()["cam0"][0]
        self.assertEqual(got["role"], "restricted")
        self.assertEqual(got["tier"], "red")

    def test_saving_with_only_a_raw_tier_keeps_working_with_no_role(self):
        """Backward compatibility: the old frontend never sent `role`."""
        resp = self.client.put(
            "/api/v1/zones",
            headers=AUTH,
            json={"cam0": [{"id": "z1", "tier": "yellow", "points": self._square_points()}]},
        )
        zone = resp.json()["cam0"][0]
        self.assertIsNone(zone["role"])
        self.assertEqual(zone["tier"], "yellow")

    def test_unknown_role_is_rejected(self):
        resp = self.client.put(
            "/api/v1/zones",
            headers=AUTH,
            json={"cam0": [{"id": "z1", "role": "not-a-role", "points": self._square_points()}]},
        )
        self.assertEqual(resp.status_code, 422)

    def test_policy_change_affects_newly_saved_zones(self):
        self.client.put("/api/v1/zone-policy", headers=AUTH, json={"buffer": "red"})
        resp = self.client.put(
            "/api/v1/zones",
            headers=AUTH,
            json={"cam0": [{"id": "z1", "role": "buffer", "points": self._square_points()}]},
        )
        self.assertEqual(resp.json()["cam0"][0]["tier"], "red")

    def test_legacy_zone_file_with_no_role_key_still_loads(self):
        import json

        path = os.path.join(self.tmp, "zones_cam0.json")
        with open(path, "w") as f:
            json.dump([{"zone_type": "green", "polygon": [[0, 0], [10, 0], [10, 10]]}], f)
        zone = self.client.get("/api/v1/zones", headers=AUTH).json()["cam0"][0]
        self.assertIsNone(zone["role"])
        self.assertEqual(zone["tier"], "green")


class TestZonePolicyApi(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.policy_path = os.path.join(self.tmp, "zone_policy.json")

        def make_policy(config_path=None):
            from zones.zone_policy import ZonePolicy as RealZonePolicy

            return RealZonePolicy(config_path=self.policy_path)

        for p in (
            patch.object(api_module, "IBVAP_API_TOKEN", TOKEN),
            patch.object(api_module, "ZonePolicy", make_policy),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.client = TestClient(api_module.app)

    def test_get_returns_defaults_when_nothing_saved(self):
        resp = self.client.get("/api/v1/zone-policy", headers=AUTH)
        self.assertEqual(resp.json(), dict(DEFAULT_ROLE_TIER))

    def test_put_persists_and_get_reflects_it(self):
        self.client.put("/api/v1/zone-policy", headers=AUTH, json={"transit": "green"})
        resp = self.client.get("/api/v1/zone-policy", headers=AUTH)
        self.assertEqual(resp.json()["transit"], "green")

    def test_invalid_tier_returns_422(self):
        resp = self.client.put("/api/v1/zone-policy", headers=AUTH, json={"restricted": "blue"})
        self.assertEqual(resp.status_code, 422)

    def test_requires_a_token(self):
        resp = self.client.get("/api/v1/zone-policy")
        self.assertEqual(resp.status_code, 401)


class TestBoundariesApi(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        def boundaries_path(cam_id):
            return os.path.join(self.tmp, f"boundaries_{cam_id}.json")

        for p in (
            patch.object(api_module, "IBVAP_API_TOKEN", TOKEN),
            patch.object(api_module, "_camera_sources", lambda: {"cam0": 0}),
            patch.object(api_module, "_boundaries_path", boundaries_path),
            patch.object(api_module, "CAMERA_WIDTH", 640),
            patch.object(api_module, "CAMERA_HEIGHT", 480),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.client = TestClient(api_module.app)

    def _line(self, id="b1", enabled=True):
        return {
            "id": id,
            "label": "fence line",
            "p1": {"x": 0.1, "y": 0.5},
            "p2": {"x": 0.9, "y": 0.5},
            "enabled": enabled,
        }

    def test_empty_by_default(self):
        resp = self.client.get("/api/v1/boundaries", headers=AUTH)
        self.assertEqual(resp.json(), {"cam0": []})

    def test_save_and_reload_round_trips(self):
        self.client.put("/api/v1/boundaries", headers=AUTH, json={"cam0": [self._line()]})
        got = self.client.get("/api/v1/boundaries", headers=AUTH).json()["cam0"][0]
        self.assertEqual(got["id"], "b1")
        self.assertEqual(got["label"], "fence line")
        self.assertTrue(got["enabled"])
        self.assertAlmostEqual(got["p1"]["x"], 0.1, places=3)

    def test_disabled_boundary_round_trips_as_disabled(self):
        self.client.put("/api/v1/boundaries", headers=AUTH, json={"cam0": [self._line(enabled=False)]})
        got = self.client.get("/api/v1/boundaries", headers=AUTH).json()["cam0"][0]
        self.assertFalse(got["enabled"])

    def test_missing_point_is_rejected(self):
        bad = {"id": "b1", "label": "x", "p1": {"x": 0.1, "y": 0.5}, "enabled": True}
        resp = self.client.put("/api/v1/boundaries", headers=AUTH, json={"cam0": [bad]})
        self.assertEqual(resp.status_code, 422)

    def test_requires_a_token(self):
        resp = self.client.get("/api/v1/boundaries")
        self.assertEqual(resp.status_code, 401)


if __name__ == "__main__":
    unittest.main()
