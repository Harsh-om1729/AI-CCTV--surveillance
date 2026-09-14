"""Offline unit tests for the zone role->tier policy.
Run from ibvap/: python -m unittest tests.test_zone_policy
"""
import tempfile
import unittest
from pathlib import Path

from zones.zone_policy import DEFAULT_ROLE_TIER, ZONE_ROLES, ZonePolicy


class TestZonePolicy(unittest.TestCase):
    def _policy(self) -> ZonePolicy:
        tmp_dir = tempfile.mkdtemp()
        return ZonePolicy(config_path=str(Path(tmp_dir) / "zone_policy.json"))

    def test_defaults_match_every_role(self):
        policy = self._policy()
        for role in ZONE_ROLES:
            self.assertEqual(policy.tier_for_role(role), DEFAULT_ROLE_TIER[role])

    def test_unknown_role_returns_none(self):
        policy = self._policy()
        self.assertIsNone(policy.tier_for_role("nonsense"))

    def test_none_role_returns_none(self):
        """The caller's signal to fall back to treating the value as a raw
        tier instead of a role."""
        policy = self._policy()
        self.assertIsNone(policy.tier_for_role(None))

    def test_update_persists_across_instances(self):
        tmp_dir = tempfile.mkdtemp()
        path = str(Path(tmp_dir) / "zone_policy.json")
        policy = ZonePolicy(config_path=path)
        policy.update({"buffer": "red"})
        self.assertEqual(policy.tier_for_role("buffer"), "red")

        reloaded = ZonePolicy(config_path=path)
        self.assertEqual(reloaded.tier_for_role("buffer"), "red")
        # Untouched roles keep their defaults across the reload.
        self.assertEqual(reloaded.tier_for_role("restricted"), "red")
        self.assertEqual(reloaded.tier_for_role("authorized"), "green")

    def test_update_rejects_unknown_role_without_saving_anything(self):
        policy = self._policy()
        with self.assertRaises(ValueError):
            policy.update({"transit": "green", "not_a_role": "red"})
        # Nothing from the bad payload took effect - not even the valid entry.
        self.assertEqual(policy.tier_for_role("transit"), "yellow")

    def test_update_rejects_invalid_tier_without_saving_anything(self):
        policy = self._policy()
        with self.assertRaises(ValueError):
            policy.update({"restricted": "purple"})
        self.assertEqual(policy.tier_for_role("restricted"), "red")

    def test_missing_config_file_uses_defaults(self):
        policy = ZonePolicy(config_path="/tmp/ibvap-test-does-not-exist/zone_policy.json")
        self.assertEqual(policy.as_dict(), dict(DEFAULT_ROLE_TIER))


if __name__ == "__main__":
    unittest.main()
