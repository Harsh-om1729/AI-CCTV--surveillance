"""Offline unit tests for the zone engine — no camera/GUI required.
Run from ibvap/: python -m unittest tests.test_zone_engine
"""

import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from zones.zone_engine import Zone, ZoneEngine

# A simple square red zone and, beside it, a square yellow zone.
RED_ZONE = Zone("red", [(0, 0), (100, 0), (100, 100), (0, 100)])
YELLOW_ZONE = Zone("yellow", [(100, 0), (200, 0), (200, 100), (100, 100)])
GREEN_ZONE = Zone("green", [(200, 0), (300, 0), (300, 100), (200, 100)])


class TestZoneEngine(unittest.TestCase):
    def _engine(self, zones=None, **kwargs) -> ZoneEngine:
        tmp_dir = tempfile.mkdtemp()
        engine = ZoneEngine(config_path=str(Path(tmp_dir) / "zones.json"), **kwargs)
        for zone in zones or []:
            engine.add_zone(zone)
        return engine

    def test_point_inside_zone_returns_its_tier(self):
        engine = self._engine([RED_ZONE])
        result = engine.classify((50, 50))
        self.assertEqual(result["tier"], "red")

    def test_disabled_zone_is_ignored_by_classify(self):
        """Kept (saved) and round-tripped, just not used for classification
        — the operator's toggle actually does something, not just paints a
        different color in the dashboard."""
        disabled_red = Zone("red", [(0, 0), (100, 0), (100, 100), (0, 100)], enabled=False)
        engine = self._engine([disabled_red])
        result = engine.classify((50, 50))
        self.assertEqual(result["tier"], "none")

    def test_disabled_zone_persists_and_reloads_as_disabled(self):
        tmp_dir = tempfile.mkdtemp()
        path = str(Path(tmp_dir) / "zones.json")
        engine = ZoneEngine(config_path=path)
        engine.add_zone(Zone("red", [(0, 0), (10, 0), (10, 10)], enabled=False))

        reloaded = ZoneEngine(config_path=path)
        self.assertFalse(reloaded.zones[0].enabled)

    def test_point_outside_all_zones_returns_none(self):
        engine = self._engine([RED_ZONE])
        result = engine.classify((500, 500))
        self.assertEqual(result["tier"], "none")

    def test_overlapping_zones_favor_higher_priority(self):
        overlapping_yellow = Zone("yellow", [(0, 0), (100, 0), (100, 100), (0, 100)])
        engine = self._engine([overlapping_yellow, RED_ZONE])
        result = engine.classify((50, 50))
        self.assertEqual(result["tier"], "red")

    def test_overlapping_same_tier_zones_favor_the_smaller_one(self):
        """Explicit priority/specificity, not polygon load order: a small
        zone sitting inside a larger zone of the same tier must win
        regardless of which one was added to the engine first."""
        large = Zone("red", [(0, 0), (200, 0), (200, 200), (0, 200)])
        small = Zone("red", [(80, 80), (120, 80), (120, 120), (80, 120)])
        self.assertAlmostEqual(large.area(), 40000.0)
        self.assertAlmostEqual(small.area(), 1600.0)

        self.assertIs(ZoneEngine._select_most_specific([large, small]), small)
        self.assertIs(ZoneEngine._select_most_specific([small, large]), small)

    def test_higher_tier_still_wins_over_a_smaller_lower_tier_zone(self):
        """Priority is checked before specificity: a tiny red zone must beat
        a huge green zone it sits inside, not the other way round."""
        tiny_red = Zone("red", [(90, 90), (110, 90), (110, 110), (90, 110)])
        huge_green = Zone("green", [(0, 0), (500, 0), (500, 500), (0, 500)])
        self.assertIs(ZoneEngine._select_most_specific([huge_green, tiny_red]), tiny_red)

    def test_yellow_zone_direction_inward_toward_red(self):
        engine = self._engine([RED_ZONE, YELLOW_ZONE])
        # Yellow zone centroid is around (150, 50); red zone centroid (50, 50)
        # is to the left, so a leftward direction vector is "inward".
        result = engine.classify((150, 50), direction=(-10.0, 0.0))
        self.assertEqual(result["tier"], "yellow")
        self.assertEqual(result["direction"], "inward")

    def test_yellow_zone_direction_outward_away_from_red(self):
        engine = self._engine([RED_ZONE, YELLOW_ZONE])
        result = engine.classify((150, 50), direction=(10.0, 0.0))
        self.assertEqual(result["tier"], "yellow")
        self.assertEqual(result["direction"], "outward")

    def test_green_zone_retiered_to_yellow_during_curfew(self):
        curfew_midnight = datetime(2026, 1, 1, 0, 30)  # 00:30, inside 23:00-05:00
        engine = self._engine(
            [GREEN_ZONE], curfew_start_hour=23, curfew_end_hour=5, now_fn=lambda: curfew_midnight
        )
        result = engine.classify((250, 50))
        self.assertEqual(result["tier"], "yellow")

    def test_green_zone_stays_green_outside_curfew(self):
        midday = datetime(2026, 1, 1, 12, 0)
        engine = self._engine(
            [GREEN_ZONE], curfew_start_hour=23, curfew_end_hour=5, now_fn=lambda: midday
        )
        result = engine.classify((250, 50))
        self.assertEqual(result["tier"], "green")

    def test_zones_persist_across_reload(self):
        tmp_dir = tempfile.mkdtemp()
        config_path = str(Path(tmp_dir) / "zones.json")
        engine_a = ZoneEngine(config_path=config_path)
        engine_a.add_zone(RED_ZONE)

        engine_b = ZoneEngine(config_path=config_path)
        self.assertEqual(len(engine_b.zones), 1)
        self.assertEqual(engine_b.zones[0].zone_type, "red")


class TestFixedTierZoneEngine(unittest.TestCase):
    """A camera assigned one tier for its whole frame (CAMERA_ZONE_TIERS) -
    no polygons drawn, no config/zones_<camera>.json needed at all."""

    def _engine(self, fixed_tier, **kwargs) -> ZoneEngine:
        tmp_dir = tempfile.mkdtemp()
        return ZoneEngine(
            config_path=str(Path(tmp_dir) / "zones.json"), fixed_tier=fixed_tier, **kwargs
        )

    def test_every_point_gets_the_fixed_tier_regardless_of_position(self):
        engine = self._engine("red")
        self.assertEqual(engine.classify((0, 0))["tier"], "red")
        self.assertEqual(engine.classify((9999, 9999))["tier"], "red")

    def test_works_with_no_zones_json_on_disk(self):
        engine = self._engine("yellow")
        self.assertEqual(engine.zones, [])
        self.assertEqual(engine.classify((50, 50))["tier"], "yellow")

    def test_fixed_tier_wins_over_leftover_drawn_polygons(self):
        """The real bug this fixes: a camera pinned via CAMERA_ZONE_TIERS with
        an old config/zones_<camera>.json still sitting on disk (from before
        it was pinned, or from a camera that used to have zones drawn) must
        report its fixed tier everywhere in frame - not whatever leftover
        polygon a point happens to land in. Without a drawing UI left to
        clear that file, silently deferring to it made the fixed tier
        unfixable."""
        engine = self._engine("red")
        engine.add_zone(Zone("green", [(0, 0), (100, 0), (100, 100), (0, 100)]))
        self.assertEqual(engine.classify((50, 50))["tier"], "red")
        self.assertEqual(engine.classify((9999, 9999))["tier"], "red")

    def test_direction_inward_when_descending_toward_camera(self):
        engine = self._engine("red")
        result = engine.classify((50, 50), direction=(0.0, 10.0))
        self.assertEqual(result["direction"], "inward")

    def test_direction_outward_when_rising_away_from_camera(self):
        engine = self._engine("red")
        result = engine.classify((50, 50), direction=(0.0, -10.0))
        self.assertEqual(result["direction"], "outward")

    def test_direction_parallel_when_lateral_dominant(self):
        engine = self._engine("red")
        result = engine.classify((50, 50), direction=(10.0, 1.0))
        self.assertEqual(result["direction"], "parallel")

    def test_direction_none_below_minimum_magnitude(self):
        engine = self._engine("red")
        result = engine.classify((50, 50), direction=(1.0, 1.0))
        self.assertIsNone(result["direction"])

    def test_direction_none_when_not_provided(self):
        engine = self._engine("red")
        result = engine.classify((50, 50))
        self.assertIsNone(result["direction"])

    def test_fixed_green_retiers_to_yellow_during_curfew(self):
        curfew_midnight = datetime(2026, 1, 1, 0, 30)
        engine = self._engine(
            "green", curfew_start_hour=23, curfew_end_hour=5, now_fn=lambda: curfew_midnight
        )
        self.assertEqual(engine.classify((50, 50))["tier"], "yellow")

    def test_fixed_green_stays_green_outside_curfew(self):
        midday = datetime(2026, 1, 1, 12, 0)
        engine = self._engine(
            "green", curfew_start_hour=23, curfew_end_hour=5, now_fn=lambda: midday
        )
        self.assertEqual(engine.classify((50, 50))["tier"], "green")


if __name__ == "__main__":
    unittest.main()
