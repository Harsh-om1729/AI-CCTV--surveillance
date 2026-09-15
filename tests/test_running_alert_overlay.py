"""Unit tests for the running-person high-alert overlay in app.py:
_draw_running_high_alert (heavy dark border + zoomed inset), wired through
draw_threat_score_overlay's real scoring path. No camera or display needed —
cv2 draws onto a plain numpy array.

Run from ibvap/: python -m unittest tests.test_running_alert_overlay
"""
import tempfile
import unittest
from pathlib import Path

import numpy as np

import app as app_module
from intelligence.threat_rules import ThreatRulesDB
from intelligence.threat_score import ThreatScorer


class _FakeDet:
    def __init__(self, box, speed, zone_tier="yellow", zone_direction=None):
        self.box = box
        self.speed = speed
        self.zone_tier = zone_tier
        self.zone_direction = zone_direction
        self.watchlist_match = None
        self.watchlist_similarity = None

    def category(self):
        return "person"


class TestRunningHighAlertOverlay(unittest.TestCase):
    def _scorer(self) -> ThreatScorer:
        tmp_dir = tempfile.mkdtemp()
        rules = ThreatRulesDB(db_path=str(Path(tmp_dir) / "threat_rules.db"))
        return ThreatScorer(rules)

    def _frame(self):
        return np.zeros((300, 400, 3), dtype=np.uint8)

    def _fast_speed(self, scorer):
        return scorer.rules.get_movement_config()["fast_speed_px_per_frame"]

    def test_running_person_gets_a_dark_border_and_zoom_inset(self):
        # draw_threat_score_overlay only scores + draws the ordinary label
        # now; the running zoom-inset is a separate, explicit draw decided by
        # is_running_alert()/should_show_running_alert() in the main loop
        # (see the hold-behaviour tests below) - drive it the same way here.
        scorer = self._scorer()
        frame = self._frame()
        det = _FakeDet(box=(50, 50, 120, 250), speed=self._fast_speed(scorer) + 5)

        score = app_module.draw_threat_score_overlay(frame, det, scorer, dwell_seconds=0.0, group_count=1)

        self.assertIsNotNone(score.override_reason)
        self.assertIn("running", score.override_reason)
        self.assertEqual(score.tier, "red")
        self.assertTrue(app_module.is_running_alert(score))
        app_module._draw_running_high_alert(frame, det.box, slot=0)

        # The zoom inset (top-right corner) must no longer be blank.
        h, w = frame.shape[:2]
        corner = frame[10:10 + 20, w - 30:w - 10]
        self.assertTrue((corner != 0).any(), "zoom inset was not drawn in the top-right corner")

        # The padded dark border must actually be dark (near-black), not the
        # ordinary bright per-category/zone colors.
        x1, y1, x2, y2 = det.box
        border_pixel = frame[max(0, y1 - app_module.RUNNING_ALERT_PAD), x1]
        self.assertTrue((border_pixel < 60).all(), "border should be a near-black dark outline")

    def test_walking_person_gets_no_high_alert_overlay(self):
        scorer = self._scorer()
        frame = self._frame()
        walk_speed = (
            scorer.rules.get_movement_config()["walk_min_px_per_frame"]
            + scorer.rules.get_movement_config()["walk_max_px_per_frame"]
        ) / 2
        det = _FakeDet(box=(50, 50, 120, 250), speed=walk_speed)

        score = app_module.draw_threat_score_overlay(frame, det, scorer, dwell_seconds=0.0, group_count=1)

        self.assertIsNone(score.override_reason)
        self.assertFalse(app_module.is_running_alert(score))
        h, w = frame.shape[:2]
        corner = frame[10:10 + 20, w - 30:w - 10]
        self.assertFalse((corner != 0).any(), "a non-running person must not get the zoom inset")

    def test_low_fps_does_not_misread_ordinary_walking_as_running(self):
        """Regression guard: px/frame for a given real-world speed scales
        inversely with capture fps, so a camera running well below
        NOMINAL_KINEMATICS_FPS makes an ordinary walker's raw det.speed look
        larger. Without normalizing back to the nominal rate, that walker
        would wrongly trip the running override. This is the scenario that
        motivated it: two cameras sharing one CPU-bound sequential loop
        measured at ~8fps in practice."""
        scorer = self._scorer()
        frame = self._frame()
        nominal_walk_speed = (
            scorer.rules.get_movement_config()["walk_min_px_per_frame"]
            + scorer.rules.get_movement_config()["walk_max_px_per_frame"]
        ) / 2  # ordinary walking pace, calibrated at NOMINAL_KINEMATICS_FPS
        low_fps = 8.0
        # The same real-world walk, captured at low_fps, shows this many
        # more pixels moving per frame (inverse scaling).
        raw_speed_at_low_fps = nominal_walk_speed * (app_module.NOMINAL_KINEMATICS_FPS / low_fps)
        det = _FakeDet(box=(50, 50, 120, 250), speed=raw_speed_at_low_fps)

        score = app_module.draw_threat_score_overlay(
            frame, det, scorer, dwell_seconds=0.0, group_count=1, fps=low_fps
        )
        self.assertIsNone(
            score.override_reason,
            "an ordinary walk at low fps must not be misread as running",
        )

    def test_genuine_sprint_still_forces_red_at_low_fps(self):
        """The other half of the same guard: normalization must not also
        hide a real sprint just because the camera is running slow."""
        scorer = self._scorer()
        frame = self._frame()
        low_fps = 8.0
        nominal_sprint_speed = self._fast_speed(scorer) + 5
        raw_speed_at_low_fps = nominal_sprint_speed * (app_module.NOMINAL_KINEMATICS_FPS / low_fps)
        det = _FakeDet(box=(50, 50, 120, 250), speed=raw_speed_at_low_fps)

        score = app_module.draw_threat_score_overlay(
            frame, det, scorer, dwell_seconds=0.0, group_count=1, fps=low_fps
        )
        self.assertIsNotNone(score.override_reason)
        self.assertIn("running", score.override_reason)

    def test_two_simultaneous_runners_stack_insets_without_overlapping(self):
        scorer = self._scorer()
        # Tall enough for two stacked 220px insets (10 + 220+34 + 220 < 700).
        frame = np.zeros((700, 400, 3), dtype=np.uint8)
        fast = self._fast_speed(scorer) + 5
        det_a = _FakeDet(box=(20, 20, 60, 100), speed=fast)
        det_b = _FakeDet(box=(200, 20, 240, 100), speed=fast)

        app_module.draw_threat_score_overlay(frame, det_a, scorer, dwell_seconds=0.0, group_count=1)
        app_module.draw_threat_score_overlay(frame, det_b, scorer, dwell_seconds=0.0, group_count=1)
        app_module._draw_running_high_alert(frame, det_a.box, slot=0)
        app_module._draw_running_high_alert(frame, det_b.box, slot=1)

        # Slot 1's inset must land below slot 0's, not on top of it.
        slot0_top = 10
        slot1_top = 10 + (app_module.RUNNING_ALERT_ZOOM_SIZE + 34)
        h, w = frame.shape[:2]
        if slot1_top + 10 < h:
            self.assertTrue((frame[slot1_top:slot1_top + 10, w - 30:w - 10] != 0).any())
        self.assertTrue((frame[slot0_top:slot0_top + 10, w - 30:w - 10] != 0).any())


class TestRunningAlertHold(unittest.TestCase):
    """The actual feature request this covers: a running person's zoom inset
    must stay on screen for RUNNING_ALERT_HOLD_SECONDS after they were last
    seen running, not vanish the instant a single frame reads them as slower
    - see should_show_running_alert in app.py."""

    def test_stays_visible_after_running_stops_within_hold_window(self):
        hold = {}
        key = ("person", 1)
        self.assertTrue(app_module.should_show_running_alert(hold, key, running_now=True, now=100.0))
        # Not running anymore this frame, but well inside the hold window.
        self.assertTrue(app_module.should_show_running_alert(hold, key, running_now=False, now=102.0))
        self.assertTrue(
            app_module.should_show_running_alert(
                hold, key, running_now=False, now=100.0 + app_module.RUNNING_ALERT_HOLD_SECONDS
            )
        )

    def test_disappears_once_the_hold_window_expires(self):
        hold = {}
        key = ("person", 1)
        app_module.should_show_running_alert(hold, key, running_now=True, now=100.0)
        past_hold = 100.0 + app_module.RUNNING_ALERT_HOLD_SECONDS + 0.01
        self.assertFalse(app_module.should_show_running_alert(hold, key, running_now=False, now=past_hold))
        # And the expired key is pruned, not left growing the dict forever.
        self.assertNotIn(key, hold)

    def test_running_again_resets_the_hold_window(self):
        hold = {}
        key = ("person", 1)
        app_module.should_show_running_alert(hold, key, running_now=True, now=100.0)
        app_module.should_show_running_alert(hold, key, running_now=True, now=104.0)
        # 5s after the *first* running frame would have expired, but only
        # ~1s after the second - still within the hold window.
        self.assertTrue(
            app_module.should_show_running_alert(
                hold, key, running_now=False, now=104.0 + app_module.RUNNING_ALERT_HOLD_SECONDS - 0.5
            )
        )

    def test_different_tracks_hold_independently(self):
        hold = {}
        app_module.should_show_running_alert(hold, ("person", 1), running_now=True, now=100.0)
        # A different track that was never running gets no hold at all.
        self.assertFalse(app_module.should_show_running_alert(hold, ("person", 2), running_now=False, now=100.0))


if __name__ == "__main__":
    unittest.main()
