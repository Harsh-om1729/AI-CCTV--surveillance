"""Offline unit tests for virtual boundaries (tripwires).
Run from ibvap/: python -m unittest tests.test_boundary_engine
"""
import tempfile
import unittest
from pathlib import Path

from zones.boundary_engine import Boundary, BoundaryEngine

# A vertical line at x=100, from y=0 to y=200.
VERTICAL_LINE = Boundary("b1", "fence line", (100, 0), (100, 200))


class TestBoundaryEngine(unittest.TestCase):
    def _engine(self, boundaries=None) -> BoundaryEngine:
        tmp_dir = tempfile.mkdtemp()
        engine = BoundaryEngine(config_path=str(Path(tmp_dir) / "boundaries.json"))
        for b in boundaries or []:
            engine.add_boundary(b)
        return engine

    def test_no_crossing_when_track_stays_on_one_side(self):
        engine = self._engine([VERTICAL_LINE])
        engine.check_crossing("T1", (50, 100))  # left side
        events = engine.check_crossing("T1", (60, 100))  # still left side
        self.assertEqual(events, [])

    def test_crossing_detected_on_side_flip(self):
        engine = self._engine([VERTICAL_LINE])
        engine.check_crossing("T1", (50, 100))  # left of the line
        events = engine.check_crossing("T1", (150, 100))  # now right of the line
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["boundaryId"], "b1")
        self.assertEqual(events[0]["label"], "fence line")

    def test_disabled_boundary_never_reports_a_crossing(self):
        disabled = Boundary("b2", "disabled tripwire", (100, 0), (100, 200), enabled=False)
        engine = self._engine([disabled])
        engine.check_crossing("T1", (50, 100))
        events = engine.check_crossing("T1", (150, 100))
        self.assertEqual(events, [])

    def test_first_sighting_never_reports_a_crossing(self):
        """No prior side is known yet - can't have "crossed" on the very
        first frame a track is seen, regardless of which side it's on."""
        engine = self._engine([VERTICAL_LINE])
        events = engine.check_crossing("T1", (150, 100))
        self.assertEqual(events, [])

    def test_crossings_are_independent_per_track(self):
        engine = self._engine([VERTICAL_LINE])
        engine.check_crossing("T1", (50, 100))
        engine.check_crossing("T2", (150, 100))
        events_t1 = engine.check_crossing("T1", (150, 100))  # T1 crosses
        events_t2 = engine.check_crossing("T2", (160, 100))  # T2 stays put
        self.assertEqual(len(events_t1), 1)
        self.assertEqual(events_t2, [])

    def test_none_track_id_never_reports_a_crossing(self):
        engine = self._engine([VERTICAL_LINE])
        engine.check_crossing(None, (50, 100))
        events = engine.check_crossing(None, (150, 100))
        self.assertEqual(events, [])

    def test_persists_across_reload(self):
        tmp_dir = tempfile.mkdtemp()
        path = str(Path(tmp_dir) / "boundaries.json")
        engine = BoundaryEngine(config_path=path)
        engine.add_boundary(VERTICAL_LINE)

        reloaded = BoundaryEngine(config_path=path)
        self.assertEqual(len(reloaded.boundaries), 1)
        self.assertEqual(reloaded.boundaries[0].id, "b1")
        self.assertEqual(reloaded.boundaries[0].label, "fence line")
        self.assertEqual(reloaded.boundaries[0].line.p1, (100.0, 0.0))

    def test_remove_boundary_clears_its_crossing_state_too(self):
        engine = self._engine([VERTICAL_LINE])
        engine.check_crossing("T1", (50, 100))
        engine.remove_boundary("b1")
        self.assertEqual(engine.boundaries, [])
        self.assertEqual(engine._last_side, {})

    def test_stale_tracks_are_purged_so_state_does_not_grow_forever(self):
        """A long-running camera mints a fresh track_id for every passerby;
        without a TTL, _last_side would grow by one entry per track_id ever
        seen for the life of the process."""
        clock = [0.0]
        tmp_dir = tempfile.mkdtemp()
        engine = BoundaryEngine(
            config_path=str(Path(tmp_dir) / "boundaries.json"),
            ttl_seconds=30.0,
            now_fn=lambda: clock[0],
        )
        engine.add_boundary(VERTICAL_LINE)

        engine.check_crossing("T1", (50, 100))
        self.assertEqual(len(engine._last_side), 1)

        clock[0] = 31.0  # past the TTL, and T1 never comes back
        engine.check_crossing("T2", (50, 100))  # any call sweeps stale entries

        self.assertNotIn(("T1", "b1"), engine._last_side)
        self.assertIn(("T2", "b1"), engine._last_side)


if __name__ == "__main__":
    unittest.main()
