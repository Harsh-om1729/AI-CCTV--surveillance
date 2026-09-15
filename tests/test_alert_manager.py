"""Offline unit tests for the alert manager's tiering/rate-limit logic — no
camera, audio device, or real file I/O required (snapshot/play calls are
monkeypatched to record invocations instead of doing real work).
Run from ibvap/: python -m unittest tests.test_alert_manager
"""

import tempfile
import time
import unittest
from pathlib import Path

from alerts.alert_manager import AlertManager
from detection.detector import Detection
from intelligence.threat_score import ThreatScore


def make_detection(track_id=1, person_id=1, category_class_id=0) -> Detection:
    det = Detection(class_id=category_class_id, class_name="person", confidence=0.9, box=(0, 0, 50, 100))
    det.track_id = track_id
    det.person_id = person_id
    det.zone_tier = "red"
    return det


def make_score(tier: str) -> ThreatScore:
    totals = {"green": 10, "yellow": 40, "red": 85}
    # Reverse-engineer a ThreatScore with the right tier by giving it all the
    # risk in one bucket — simplest way to get a specific tier deterministically.
    return ThreatScore(sector_risk=totals[tier], time_risk=0, kinematics_risk=0, class_confidence=0)


class RecordingAlertManager(AlertManager):
    """Same logic as AlertManager, but records calls instead of doing real
    audio playback or disk writes."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.play_calls = []
        self.snapshot_calls = []

    def _play(self, sound) -> None:
        self.play_calls.append(sound)

    def _save_snapshot(self, frames, tier, det, track_key) -> None:
        self.snapshot_calls.append((tier, track_key, len(frames)))


class Clock:
    """A controllable fake clock — confirmation is now keyed on real elapsed
    seconds (not a count of scoring cycles), so tests that exercise it must
    control time explicitly rather than relying on back-to-back calls being
    "instant"."""

    def __init__(self, t: float = 0.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> float:
        self.t += seconds
        return self.t


class TestAlertManager(unittest.TestCase):
    def _manager(self, **kwargs) -> RecordingAlertManager:
        tmp_dir = tempfile.mkdtemp()
        return RecordingAlertManager(snapshot_dir=str(Path(tmp_dir) / "snapshots"), **kwargs)

    @staticmethod
    def _confirm(mgr, det, tier, clock, frames=("f",)):
        """Feeds two observations spaced a full confirm_seconds apart — the
        minimum real-time pattern that confirms a tier (see _confirmed_tier):
        the window must span at least confirm_seconds before any candidate is
        even considered."""
        mgr.handle(det, make_score(tier), recent_frames=list(frames))
        clock.advance(mgr.confirm_seconds)
        mgr.handle(det, make_score(tier), recent_frames=list(frames))

    # --- tier behaviour -------------------------------------------------

    def test_green_never_plays_or_snapshots(self):
        clock = Clock()
        mgr = self._manager(now_fn=clock)
        det = make_detection()
        for _ in range(5):
            clock.advance(1.0)
            mgr.handle(det, make_score("green"), recent_frames=["f"])
        self.assertEqual(mgr.play_calls, [])
        self.assertEqual(mgr.snapshot_calls, [])

    def test_confirmed_yellow_plays_and_snapshots_once_frame(self):
        clock = Clock()
        mgr = self._manager(confirm_seconds=1.0, now_fn=clock)
        det = make_detection()
        self._confirm(mgr, det, "yellow", clock, frames=("f1", "f2", "f3"))
        self.assertEqual(len(mgr.play_calls), 1)
        self.assertEqual(mgr.snapshot_calls, [("yellow", 1, 1)])  # only the latest frame

    def test_confirmed_red_plays_and_snapshots_full_burst(self):
        clock = Clock()
        mgr = self._manager(confirm_seconds=1.0, now_fn=clock)
        det = make_detection()
        self._confirm(mgr, det, "red", clock, frames=("f1", "f2", "f3"))
        self.assertEqual(len(mgr.play_calls), 1)
        self.assertEqual(mgr.snapshot_calls, [("red", 1, 3)])  # all buffered frames

    # --- Phase 18: sustained-presence confirmation -----------------------

    def test_single_observation_does_not_alert(self):
        """The core of Phase 18: one borderline frame — a face similarity
        landing on 0.50 — must not be able to start an incident, no matter
        how the clock is set up (a window of one sample has zero span)."""
        mgr = self._manager()
        det = make_detection()
        mgr.handle(det, make_score("red"), recent_frames=["f"])
        self.assertEqual(mgr.play_calls, [])
        self.assertEqual(mgr.snapshot_calls, [])

    def test_confirmation_needs_the_full_window_of_real_time(self):
        """A second observation short of confirm_seconds must not confirm —
        only once the window actually spans confirm_seconds does it count."""
        clock = Clock()
        mgr = self._manager(confirm_seconds=2.0, now_fn=clock)
        det = make_detection()

        mgr.handle(det, make_score("red"), recent_frames=["f"])
        clock.advance(1.0)  # only half of confirm_seconds has elapsed
        mgr.handle(det, make_score("red"), recent_frames=["f"])
        self.assertEqual(mgr.play_calls, [], "1s of 2s required must not confirm")

        clock.advance(1.0)  # now 2.0s span since the first observation
        mgr.handle(det, make_score("red"), recent_frames=["f"])
        self.assertEqual(len(mgr.play_calls), 1)

    def test_confirm_seconds_is_configurable(self):
        clock = Clock()
        mgr = self._manager(confirm_seconds=0.2, now_fn=clock)
        det = make_detection()
        self._confirm(mgr, det, "red", clock)
        self.assertEqual(len(mgr.play_calls), 1)

    def test_negative_confirm_seconds_is_rejected(self):
        """A negative window makes no sense — fail loudly at construction
        rather than at 2am on a border post."""
        with self.assertRaises(ValueError):
            self._manager(confirm_seconds=-1.0)

    def test_borderline_flapping_signal_still_confirms_once(self):
        """A signal genuinely oscillating between two tiers (e.g. a watchlist
        similarity landing right on its threshold, flipping red/green every
        frame) must not be read as "never sustained" and go silent forever —
        elevated at least half the time over the window is enough to confirm
        it once, matching the default confirm_fraction=0.5."""
        clock = Clock()
        mgr = self._manager(cooldown_seconds=100.0, confirm_seconds=1.5, now_fn=clock)
        det = make_detection()

        for i in range(20):
            clock.t = i * 0.1  # ~10fps of flapping, all inside one cooldown
            mgr.handle(det, make_score("red" if i % 2 == 0 else "green"), recent_frames=["f"])

        self.assertEqual(
            len(mgr.play_calls), 1,
            f"flapping produced {len(mgr.play_calls)} alerts; expected exactly one",
        )

    # --- Phase 18: hysteresis -------------------------------------------

    def test_tier_releases_only_after_sustained_time_below_it(self):
        clock = Clock()
        mgr = self._manager(cooldown_seconds=100.0, confirm_seconds=1.0, now_fn=clock)
        det = make_detection()

        self._confirm(mgr, det, "red", clock)  # confirmed red
        self.assertEqual(mgr._last_tier[1], "red")

        clock.advance(0.1)
        mgr.handle(det, make_score("green"), recent_frames=["f"])  # just started dipping
        self.assertEqual(mgr._last_tier[1], "red", "a brief dip must not release immediately")

        # Sustained green, sampled densely - as the real per-frame pipeline
        # would - until the window is entirely green and spans confirm_seconds.
        for _ in range(15):
            clock.advance(0.1)
            mgr.handle(det, make_score("green"), recent_frames=["f"])
        self.assertEqual(mgr._last_tier[1], "green")

    def test_confirmed_escalation_alerts_inside_cooldown(self):
        """Escalation still bypasses the cooldown — but only once the higher
        tier is *itself* sustained for confirm_seconds, not merely because
        the track has existed that long (a stale lower-tier sample sitting
        in the window must not let one new higher-tier frame confirm it)."""
        clock = Clock()
        mgr = self._manager(cooldown_seconds=100.0, confirm_seconds=1.0, now_fn=clock)
        det = make_detection()

        self._confirm(mgr, det, "yellow", clock)
        self.assertEqual(len(mgr.play_calls), 1)

        clock.advance(0.1)  # well within cooldown, but escalating yellow -> red
        mgr.handle(det, make_score("red"), recent_frames=["f"])
        self.assertEqual(len(mgr.play_calls), 1, "one red frame must not confirm off a stale yellow window")

        clock.advance(1.0)  # red now sustained for a full confirm_seconds
        mgr.handle(det, make_score("red"), recent_frames=["f"])
        self.assertEqual(len(mgr.play_calls), 2)

    # --- Phase 18: backoff ----------------------------------------------

    def test_same_tier_within_cooldown_does_not_re_alert(self):
        clock = Clock()
        mgr = self._manager(cooldown_seconds=10.0, confirm_seconds=1.0, now_fn=clock)
        det = make_detection()

        self._confirm(mgr, det, "yellow", clock)
        clock.advance(2.0)  # within cooldown, same tier
        mgr.handle(det, make_score("yellow"), recent_frames=["f"])

        self.assertEqual(len(mgr.play_calls), 1)  # second call suppressed

    def test_repeat_cooldown_doubles_each_time(self):
        clock = Clock()
        mgr = self._manager(cooldown_seconds=10.0, max_cooldown_seconds=1000.0,
                             confirm_seconds=1.0, now_fn=clock)
        det = make_detection()

        self._confirm(mgr, det, "yellow", clock)          # alert 1
        clock.t = 10.0 + mgr.confirm_seconds
        mgr.handle(det, make_score("yellow"), recent_frames=["f"])  # alert 2 — 10s elapsed
        self.assertEqual(len(mgr.play_calls), 2)

        clock.t += 15.0                                    # only 15s since alert 2
        mgr.handle(det, make_score("yellow"), recent_frames=["f"])
        self.assertEqual(len(mgr.play_calls), 2, "second repeat must wait 20s, not 10s")

        clock.t += 5.0                                      # 20s since alert 2
        mgr.handle(det, make_score("yellow"), recent_frames=["f"])
        self.assertEqual(len(mgr.play_calls), 3)

    def test_backoff_is_capped(self):
        mgr = self._manager(cooldown_seconds=10.0, max_cooldown_seconds=15.0)
        mgr._repeats[1] = 8  # would be 10 * 2**8 = 2560s uncapped
        self.assertEqual(mgr._effective_cooldown(1), 15.0)

    def test_escalation_resets_backoff(self):
        clock = Clock()
        mgr = self._manager(cooldown_seconds=10.0, confirm_seconds=1.0, now_fn=clock)
        det = make_detection()

        self._confirm(mgr, det, "yellow", clock)
        clock.t = 10.0 + mgr.confirm_seconds
        mgr.handle(det, make_score("yellow"), recent_frames=["f"])  # repeat -> backoff now 20s
        self.assertEqual(mgr._repeats[1], 1)

        clock.advance(1.0)
        mgr.handle(det, make_score("red"), recent_frames=["f"])
        clock.advance(1.0)
        mgr.handle(det, make_score("red"), recent_frames=["f"])  # new confirmed tier
        self.assertEqual(mgr._repeats[1], 0)
        self.assertEqual(len(mgr.play_calls), 3)

    # --- bookkeeping -----------------------------------------------------

    def test_different_tracks_alert_independently(self):
        clock = Clock()
        mgr = self._manager(cooldown_seconds=100.0, confirm_seconds=1.0, now_fn=clock)
        det_a = make_detection(track_id=1, person_id=1)
        det_b = make_detection(track_id=2, person_id=2)

        self._confirm(mgr, det_a, "yellow", clock)
        self._confirm(mgr, det_b, "yellow", clock)

        self.assertEqual(len(mgr.play_calls), 2)

    def test_forget_clears_per_track_state(self):
        clock = Clock()
        mgr = self._manager(confirm_seconds=1.0, now_fn=clock)
        det = make_detection()
        self._confirm(mgr, det, "red", clock)
        self.assertIn(1, mgr._history)

        mgr.forget(1)
        for state in (mgr._last_tier, mgr._last_alert_time, mgr._history, mgr._repeats):
            self.assertNotIn(1, state)


class TestIdentityResolutionDoesNotDuplicateAlerts(unittest.TestCase):
    """The bug this closes: track_key is det.track_id until Re-ID resolves a
    person_id, then it switches to that person_id. Confirmed live: a person
    alerted once as "T8", then again as "#2" within the same second, same
    continuous presence - the key switch silently started a brand-new
    confirmation/cooldown history for someone already mid-alert."""

    def _manager(self, **kwargs) -> RecordingAlertManager:
        tmp_dir = tempfile.mkdtemp()
        return RecordingAlertManager(snapshot_dir=str(Path(tmp_dir) / "snapshots"), **kwargs)

    def test_first_identity_resolution_carries_state_forward(self):
        clock = Clock()
        mgr = self._manager(confirm_seconds=1.0, now_fn=clock)
        det = make_detection(track_id=8, person_id=None)
        mgr.handle(det, make_score("yellow"), recent_frames=["f"])
        clock.advance(1.0)
        mgr.handle(det, make_score("yellow"), recent_frames=["f"])  # confirms + fires once as "T8"
        self.assertEqual(len(mgr.play_calls), 1)

        det.person_id = 2  # Re-ID resolves mid-presence - same physical person
        clock.advance(0.1)
        # Without the fix this reconfirms yellow from a blank history within
        # these two calls and fires again as "#2".
        mgr.handle(det, make_score("yellow"), recent_frames=["f"])
        clock.advance(1.0)
        mgr.handle(det, make_score("yellow"), recent_frames=["f"])
        self.assertEqual(
            len(mgr.play_calls), 1,
            "same physical person must not re-alert just because their key changed",
        )

    def test_reacquiring_an_already_known_person_keeps_their_state(self):
        clock = Clock()
        mgr = self._manager(confirm_seconds=1.0, now_fn=clock)
        det_known = make_detection(track_id=1, person_id=2)
        mgr.handle(det_known, make_score("yellow"), recent_frames=["f"])
        clock.advance(1.0)
        mgr.handle(det_known, make_score("yellow"), recent_frames=["f"])
        self.assertEqual(len(mgr.play_calls), 1)

        # A different, brand-new track starts unresolved...
        clock.advance(0.1)
        det_new = make_detection(track_id=50, person_id=None)
        mgr.handle(det_new, make_score("red"), recent_frames=["f"])
        # ...then immediately resolves to the SAME already-known person - the
        # temporary track_id=50 state must be dropped, not overwrite #2's.
        det_new.person_id = 2
        clock.advance(0.1)
        mgr.handle(det_new, make_score("yellow"), recent_frames=["f"])
        clock.advance(1.0)
        mgr.handle(det_new, make_score("yellow"), recent_frames=["f"])
        self.assertEqual(
            len(mgr.play_calls), 1,
            "an established person's cooldown must survive being re-acquired under a new track_id",
        )

    def test_key_for_track_id_is_purged_with_its_state(self):
        # state_ttl_seconds is floored at cooldown_seconds, so both must be
        # tiny for the sleep below to actually cross the eviction threshold.
        mgr = self._manager(cooldown_seconds=0.01, state_ttl_seconds=0.01, confirm_seconds=0.0)
        det = make_detection(track_id=8, person_id=None)
        mgr.handle(det, make_score("yellow"), recent_frames=["f"])
        det.person_id = 2
        mgr.handle(det, make_score("yellow"), recent_frames=["f"])
        self.assertIn(8, mgr._key_for_track_id)

        time.sleep(0.02)
        mgr.handle(make_detection(track_id=999, person_id=999), make_score("green"), recent_frames=["f"])
        self.assertNotIn(8, mgr._key_for_track_id)


class TestAlertStateIsBounded(unittest.TestCase):
    """Issue E: `_last_tier` / `_last_alert_time` are keyed by an identity that
    churns (ByteTrack mints a new id on every re-acquisition), and nothing ever
    removed entries - including the green path, which writes state for every
    detection that never alerts at all.

    Eviction must not change rate limiting for a track that is still around,
    so the TTL is floored at the cooldown; these tests pin both halves.
    """

    def _manager(self, **kwargs) -> RecordingAlertManager:
        tmp_dir = tempfile.mkdtemp()
        # confirm_seconds=0 unless a test asks otherwise. These cases are
        # about TTL, eviction and cooldown; the Phase 18 confirmation window
        # (default confirm_seconds=1.5) is a separate behaviour with its own
        # tests above. Left at the default it silently changes what these
        # measure — a single detection would no longer alert, so "one alert"
        # assertions would read zero and the bounded-growth cases would stop
        # exercising the alerting path they exist to bound.
        kwargs.setdefault("confirm_seconds", 0.0)
        return RecordingAlertManager(snapshot_dir=str(Path(tmp_dir) / "snapshots"), **kwargs)

    def test_state_ttl_is_never_shorter_than_the_cooldown(self):
        """A TTL below the cooldown would let eviction reset an in-flight
        cooldown and fire a duplicate alert."""
        mgr = self._manager(cooldown_seconds=30.0, state_ttl_seconds=5.0)
        self.assertGreaterEqual(mgr.state_ttl_seconds, 30.0)

    def test_green_only_traffic_does_not_grow_state_without_bound(self):
        """The worst leak: most detections are green and never alert, yet each
        one still wrote a permanent entry."""
        clock = {"t": 0.0}
        mgr = self._manager(cooldown_seconds=8.0, state_ttl_seconds=60.0, now_fn=lambda: clock["t"])

        for track_id in range(3000):
            clock["t"] = float(track_id)
            mgr.handle(make_detection(track_id=track_id, person_id=track_id),
                       make_score("green"), recent_frames=["f"])

        self.assertLessEqual(len(mgr._last_tier), 130)
        self.assertLessEqual(len(mgr._last_seen), 130)

    def test_many_alerting_tracks_stay_bounded(self):
        clock = {"t": 0.0}
        mgr = self._manager(cooldown_seconds=8.0, state_ttl_seconds=60.0, now_fn=lambda: clock["t"])

        for track_id in range(2000):
            clock["t"] = float(track_id)
            mgr.handle(make_detection(track_id=track_id, person_id=track_id),
                       make_score("red"), recent_frames=["f"])

        self.assertLessEqual(len(mgr._last_alert_time), 130)
        self.assertLessEqual(len(mgr._last_tier), 130)

    def test_stale_identity_state_is_actually_removed(self):
        clock = {"t": 0.0}
        mgr = self._manager(cooldown_seconds=8.0, state_ttl_seconds=60.0, now_fn=lambda: clock["t"])
        mgr.handle(make_detection(track_id=1, person_id=1), make_score("yellow"), recent_frames=["f"])
        self.assertIn(1, mgr._last_tier)

        clock["t"] = 500.0  # long gone; another track drives the sweep
        mgr.handle(make_detection(track_id=2, person_id=2), make_score("yellow"), recent_frames=["f"])

        self.assertNotIn(1, mgr._last_tier)
        self.assertNotIn(1, mgr._last_alert_time)
        self.assertIn(2, mgr._last_tier)

    def test_active_track_keeps_its_cooldown_across_a_purge_sweep(self):
        """A track that keeps being seen must never have its state evicted -
        that would let it re-alert inside its own cooldown."""
        clock = {"t": 0.0}
        mgr = self._manager(cooldown_seconds=100.0, state_ttl_seconds=60.0, now_fn=lambda: clock["t"])

        mgr.handle(make_detection(), make_score("yellow"), recent_frames=["f"])
        self.assertEqual(len(mgr.play_calls), 1)

        # Seen continuously for well past the TTL, so sweeps do run.
        for step in range(1, 10):
            clock["t"] = step * 10.0
            mgr.handle(make_detection(), make_score("yellow"), recent_frames=["f"])

        # cooldown is 100s and only 90s have passed: still exactly one alert.
        self.assertEqual(len(mgr.play_calls), 1, "eviction reset an active track's cooldown")

    def test_eviction_at_the_ttl_boundary_does_not_duplicate_an_alert(self):
        """TTL and cooldown expiring together: the track alerts again because
        its cooldown elapsed, not twice because state was dropped."""
        clock = {"t": 0.0}
        mgr = self._manager(cooldown_seconds=60.0, state_ttl_seconds=60.0, now_fn=lambda: clock["t"])

        mgr.handle(make_detection(), make_score("yellow"), recent_frames=["f"])
        clock["t"] = 60.0  # cooldown and TTL boundary reached at the same instant
        mgr.handle(make_detection(), make_score("yellow"), recent_frames=["f"])
        clock["t"] = 60.1
        mgr.handle(make_detection(), make_score("yellow"), recent_frames=["f"])

        self.assertEqual(len(mgr.play_calls), 2)

    def test_escalation_behaviour_survives_a_purge_sweep(self):
        clock = {"t": 0.0}
        mgr = self._manager(cooldown_seconds=100.0, state_ttl_seconds=60.0, now_fn=lambda: clock["t"])
        det = make_detection()

        mgr.handle(det, make_score("yellow"), recent_frames=["f"])
        clock["t"] = 70.0  # past the TTL, but the track has been seen throughout
        mgr.handle(det, make_score("yellow"), recent_frames=["f"])
        clock["t"] = 71.0
        mgr.handle(det, make_score("red"), recent_frames=["f"])  # escalation

        self.assertEqual(len(mgr.play_calls), 2)
        self.assertEqual(mgr.snapshot_calls[-1][0], "red")

    def test_a_backwards_clock_step_does_not_disable_cleanup(self):
        """An NTP correction must not leave the next sweep permanently in the
        future, which would quietly restore the unbounded growth."""
        clock = {"t": 1000.0}
        mgr = self._manager(cooldown_seconds=8.0, state_ttl_seconds=60.0, now_fn=lambda: clock["t"])
        mgr.handle(make_detection(track_id=1, person_id=1), make_score("green"), recent_frames=["f"])

        clock["t"] = 0.0  # clock steps back
        mgr.handle(make_detection(track_id=2, person_id=2), make_score("green"), recent_frames=["f"])
        clock["t"] = 200.0
        mgr.handle(make_detection(track_id=3, person_id=3), make_score("green"), recent_frames=["f"])

        # Sweeps are still happening: track 2 aged out normally.
        self.assertNotIn(2, mgr._last_tier)
        self.assertIn(3, mgr._last_tier)
        # Track 1 was last seen at a timestamp now in the future, so it is not
        # stale yet - it is retained (never wrongly evicted) and released once
        # the clock passes it, so nothing is stranded permanently.
        self.assertIn(1, mgr._last_tier)
        clock["t"] = 1100.0
        mgr.handle(make_detection(track_id=4, person_id=4), make_score("green"), recent_frames=["f"])
        self.assertNotIn(1, mgr._last_tier)


if __name__ == "__main__":
    unittest.main()
