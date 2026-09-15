"""Offline unit tests for bounded per-track history (Issue C) — no YOLO model
or camera required.
Run from ibvap/: python -m unittest tests.test_track_history

`Tracker` keeps its position history in a `TrackHistory`, which is what these
tests drive directly. ByteTrack mints a fresh track_id on every
re-acquisition, so the dict keyed by track_id is exactly the structure that
used to grow for the lifetime of the process.
"""

import unittest

from tracking.history import TrackHistory


class Clock:
    def __init__(self, t=0.0):
        self.t = t

    def __call__(self):
        return self.t


class TestDirectionAndSpeed(unittest.TestCase):
    """The history exists to feed the zone engine and kinematics score — the
    cleanup must not disturb either."""

    def test_single_sample_has_no_direction_and_zero_speed(self):
        history = TrackHistory()
        direction, speed = history.update(1, (10.0, 10.0))
        self.assertIsNone(direction)
        self.assertEqual(speed, 0.0)

    def test_direction_and_speed_over_a_straight_track(self):
        history = TrackHistory()
        for x in range(5):
            direction, speed = history.update(1, (float(x * 3), 0.0))
        self.assertEqual(direction, (12.0, 0.0))
        self.assertAlmostEqual(speed, 3.0)  # 12px over 4 frame gaps

    def test_history_is_capped_at_history_len(self):
        history = TrackHistory(history_len=3)
        for x in range(10):
            history.update(1, (float(x), 0.0))
        self.assertEqual(len(history.history_for(1)), 3)
        self.assertEqual(history.history_for(1), [(7.0, 0.0), (8.0, 0.0), (9.0, 0.0)])

    def test_direction_and_speed_still_work_right_up_to_the_ttl_boundary(self):
        """Cleanup must not fire early and reset a track that is still live."""
        clock = Clock()
        history = TrackHistory(ttl_seconds=30.0, now_fn=clock)

        history.update(7, (0.0, 0.0))
        clock.t = 29.9  # still inside the TTL
        history.purge_stale()
        direction, speed = history.update(7, (10.0, 0.0))

        self.assertEqual(direction, (10.0, 0.0))
        self.assertAlmostEqual(speed, 10.0)
        self.assertEqual(len(history.history_for(7)), 2)


class TestSpeedSmoothing(unittest.TestCase):
    """A person standing still in front of the camera still gets a slightly
    jittery detection box (YOLO box regression noise), which used to flip
    the raw speed across the kinematics U-curve's ~1px-wide "stationary"
    boundary every frame - swinging kinematics_risk between 0 and max and
    flickering the displayed tier green/yellow/red for someone who never
    moved. Speed is now EMA-smoothed per track to absorb that jitter."""

    def test_jittering_but_stationary_track_has_damped_speed_swings(self):
        history = TrackHistory()
        # A person standing at (100, 100), with +/-2px alternating detection
        # jitter each frame - well inside real YOLO box noise, and enough to
        # cross the still (1.0) / walk_min (2.0) boundary on raw speed alone.
        jitter_points = [
            (100.0, 100.0), (102.0, 100.0), (100.0, 100.0), (102.0, 100.0),
            (100.0, 100.0), (102.0, 100.0), (100.0, 100.0), (102.0, 100.0),
        ]
        speeds = [history.update(1, p)[1] for p in jitter_points]
        # Raw (unsmoothed) speed here alternates between 0 and up to 2.0
        # every frame - swinging clean across the still/walk_min boundary.
        # The very first reading (index 1) has no prior EMA to smooth
        # against - that one-time cold-start jump is expected. From the next
        # reading on, smoothing must keep frame-to-frame swings well inside
        # one band instead of bouncing clean across it every frame.
        settled = speeds[2:]
        swings = [abs(settled[i] - settled[i - 1]) for i in range(1, len(settled))]
        self.assertLess(max(swings), 1.0, f"speed still swings sharply frame to frame: {speeds}")

    def test_speed_still_responds_to_a_real_sustained_change(self):
        """Smoothing must damp noise, not motion: a track that genuinely
        starts moving fast must still read as fast, not stay stuck low."""
        history = TrackHistory()
        for x in range(10):
            history.update(1, (float(x), 0.0))  # stationary
        speed = 0.0
        for x in range(10, 30):
            _, speed = history.update(1, (float(x * 20), 0.0))  # sustained fast motion
        self.assertGreater(speed, 15.0)


class TestActiveTracksAreRetained(unittest.TestCase):
    def test_active_track_keeps_its_history_across_repeated_purges(self):
        clock = Clock()
        history = TrackHistory(history_len=10, ttl_seconds=30.0, now_fn=clock)

        for step in range(20):
            clock.t = step * 5.0  # a long-lived track, updated every 5s
            history.update(1, (float(step), 0.0))
            history.purge_stale()

        self.assertEqual(len(history), 1)
        self.assertEqual(len(history.history_for(1)), 10)

    def test_track_that_briefly_disappears_within_the_ttl_keeps_its_history(self):
        clock = Clock()
        history = TrackHistory(ttl_seconds=30.0, now_fn=clock)
        history.update(1, (0.0, 0.0))
        history.update(1, (5.0, 0.0))

        clock.t = 20.0  # gone for 20s, inside the TTL
        history.purge_stale()

        self.assertEqual(len(history.history_for(1)), 2)
        direction, _speed = history.update(1, (10.0, 0.0))
        self.assertEqual(direction, (10.0, 0.0))  # continuous, not restarted


class TestStaleTracksAreRemoved(unittest.TestCase):
    def test_stale_track_is_dropped_once_past_the_ttl(self):
        clock = Clock()
        history = TrackHistory(ttl_seconds=30.0, now_fn=clock)
        history.update(1, (0.0, 0.0))

        clock.t = 30.1
        removed = history.purge_stale()

        self.assertEqual(removed, 1)
        self.assertEqual(len(history), 0)
        self.assertEqual(history.history_for(1), [])

    def test_only_the_stale_track_is_dropped(self):
        clock = Clock()
        history = TrackHistory(ttl_seconds=30.0, now_fn=clock)
        history.update(1, (0.0, 0.0))  # will go stale
        clock.t = 25.0
        history.update(2, (0.0, 0.0))  # still active

        clock.t = 40.0
        history.purge_stale()

        self.assertEqual(len(history), 1)
        self.assertEqual(history.history_for(1), [])
        self.assertEqual(len(history.history_for(2)), 1)

    def test_many_short_lived_tracks_stay_bounded(self):
        """The actual leak: ByteTrack hands out a new id every re-acquisition,
        so an all-day deployment sees an unbounded number of ids."""
        clock = Clock()
        history = TrackHistory(ttl_seconds=30.0, now_fn=clock)

        for track_id in range(5000):
            clock.t = track_id * 1.0  # one new short-lived track per second
            history.update(track_id, (0.0, 0.0))
            history.purge_stale()

        # Bounded by the TTL window, not by how many ids were ever seen.
        self.assertLessEqual(len(history), 31)
        self.assertGreater(len(history), 0)

    def test_a_reused_track_id_starts_a_clean_history(self):
        """If ByteTrack later reuses a number we have purged, the new track
        must not inherit the old one's positions (which would fabricate a
        huge direction/speed jump)."""
        clock = Clock()
        history = TrackHistory(ttl_seconds=30.0, now_fn=clock)
        history.update(1, (0.0, 0.0))
        history.update(1, (5.0, 0.0))

        clock.t = 100.0
        history.purge_stale()
        direction, speed = history.update(1, (900.0, 900.0))

        self.assertIsNone(direction)
        self.assertEqual(speed, 0.0)
        self.assertEqual(history.history_for(1), [(900.0, 900.0)])

    def test_purge_accepts_an_explicit_now_for_deterministic_cleanup(self):
        history = TrackHistory(ttl_seconds=10.0, now_fn=Clock(100.0))
        history.update(1, (0.0, 0.0))

        self.assertEqual(history.purge_stale(now=105.0), 0)
        self.assertEqual(history.purge_stale(now=111.0), 1)


if __name__ == "__main__":
    unittest.main()
