"""Offline unit tests for the threat scoring engine — no camera required.
Run from ibvap/: python -m unittest tests.test_threat_score
"""

import tempfile
import unittest
from pathlib import Path

from intelligence.threat_rules import ThreatRulesDB
from intelligence.threat_score import GREEN_MAX, YELLOW_MAX, ThreatScore, ThreatScorer, ZONE_TIER_THRESHOLDS


def _steps(start: float, end: float, count: int) -> list:
    """`count` evenly spaced speeds from start to end, inclusive."""
    return [start + (end - start) * i / (count - 1) for i in range(count)]


class TestThreatScore(unittest.TestCase):
    def test_total_is_sum_of_components(self):
        score = ThreatScore(sector_risk=10, time_risk=5, kinematics_risk=3, class_confidence=2)
        self.assertEqual(score.total, 20)

    def test_tier_boundaries(self):
        self.assertEqual(ThreatScore(0, 0, 0, 0).tier, "green")
        self.assertEqual(ThreatScore(30, 0, 0, 0).tier, "green")
        self.assertEqual(ThreatScore(31, 0, 0, 0).tier, "yellow")
        self.assertEqual(ThreatScore(69, 0, 0, 0).tier, "yellow")
        self.assertEqual(ThreatScore(70, 0, 0, 0).tier, "red")
        self.assertEqual(ThreatScore(100, 0, 0, 0).tier, "red")

    def test_ceiling_caps_tier_and_total(self):
        score = ThreatScore(100, 0, 0, 0, tier_ceiling="yellow", ceiling_reason="no zone")
        self.assertEqual(score.tier, "yellow")
        self.assertEqual(score.total, 69, "total must stay consistent with the capped tier")

    def test_ceiling_never_raises_a_tier(self):
        score = ThreatScore(10, 0, 0, 0, tier_ceiling="red", ceiling_reason="irrelevant")
        self.assertEqual(score.tier, "green")
        self.assertEqual(score.total, 10)

    def test_green_and_no_zone_thresholds_are_unchanged(self):
        """The zone sensitivity policy must not move the two longest-tested,
        most-tuned bands: GREEN and no-zone-drawn keep exactly today's
        30/69 split."""
        self.assertEqual(ZONE_TIER_THRESHOLDS["green"], (float(GREEN_MAX), float(YELLOW_MAX)))
        self.assertEqual(ZONE_TIER_THRESHOLDS["none"], (float(GREEN_MAX), float(YELLOW_MAX)))

    def test_same_total_escalates_faster_in_a_more_sensitive_zone(self):
        """RED = high sensitivity, YELLOW = medium, GREEN = low: the exact
        same total score must classify at least as severely in a more
        sensitive zone, and strictly more severely somewhere in the range."""
        totals_seen = set()
        for total in (15.0, 25.0, 35.0, 45.0, 65.0):
            tiers = {
                zone: ThreatScore(total, 0, 0, 0, zone_tier=zone).tier
                for zone in ("green", "yellow", "red")
            }
            rank = {"green": 0, "yellow": 1, "red": 2}
            self.assertLessEqual(rank[tiers["green"]], rank[tiers["yellow"]])
            self.assertLessEqual(rank[tiers["yellow"]], rank[tiers["red"]])
            totals_seen.add(tuple(sorted(set(tiers.values()))))
        self.assertGreater(
            len(totals_seen), 1,
            "sweeping totals never produced a case where zones disagreed on tier",
        )

    def test_ceiling_binds_an_override(self):
        """The design decision behind Phase 18's no-zone ceiling: an override
        says the pattern matters, the ceiling says we cannot tell where it is
        happening, and the ceiling qualifies the override rather than the other
        way round."""
        score = ThreatScore(
            0, 0, 0, 0,
            override_reason="watchlist match: Test Subject (similarity=0.51)",
            tier_ceiling="yellow", ceiling_reason="no zone defined for this camera",
        )
        self.assertEqual(score.tier, "yellow")
        self.assertIn("forced RED", score.breakdown(), "the reason must survive the cap")
        self.assertIn("capped at YELLOW", score.breakdown())


class TestThreatScorer(unittest.TestCase):
    def _scorer(self) -> ThreatScorer:
        tmp_dir = tempfile.mkdtemp()
        rules = ThreatRulesDB(db_path=str(Path(tmp_dir) / "threat_rules.db"))
        return ThreatScorer(rules)

    def test_kinematics_stationary_is_max_risk(self):
        """The U-curve's whole point: a near-stationary subject is a man lying
        up at the fence, not an absence of threat. The old linear rule scored
        this as zero, which is backwards for a border."""
        scorer = self._scorer()
        config = scorer.rules.get_movement_config()
        max_risk = config["max_movement_risk"]
        self.assertEqual(scorer._kinematics_risk(0.0), max_risk)
        self.assertEqual(
            scorer._kinematics_risk(config["still_speed_px_per_frame"]), max_risk
        )

    def test_kinematics_above_fast_threshold_is_max_risk(self):
        scorer = self._scorer()
        config = scorer.rules.get_movement_config()
        self.assertEqual(scorer._kinematics_risk(config["fast_speed_px_per_frame"]), config["max_movement_risk"])
        self.assertEqual(scorer._kinematics_risk(1000.0), config["max_movement_risk"])

    def test_kinematics_walking_band_is_zero_risk(self):
        """An ordinary walking pace is the least interesting thing on the feed
        — the trough of the U."""
        scorer = self._scorer()
        config = scorer.rules.get_movement_config()
        walk_min = config["walk_min_px_per_frame"]
        walk_max = config["walk_max_px_per_frame"]
        self.assertEqual(scorer._kinematics_risk(walk_min), 0.0)
        self.assertEqual(scorer._kinematics_risk((walk_min + walk_max) / 2), 0.0)
        self.assertEqual(scorer._kinematics_risk(walk_max), 0.0)

    def test_kinematics_ramps_monotonically_out_of_each_extreme(self):
        """Between the extremes and the walking band the curve must ramp, not
        step — otherwise a subject slowing to a halt jumps from 0 to max in one
        frame and drags the tier with it."""
        scorer = self._scorer()
        config = scorer.rules.get_movement_config()
        still, walk_min = config["still_speed_px_per_frame"], config["walk_min_px_per_frame"]
        walk_max, fast = config["walk_max_px_per_frame"], config["fast_speed_px_per_frame"]

        slowing = [scorer._kinematics_risk(s) for s in _steps(walk_min, still, 6)]
        self.assertEqual(slowing, sorted(slowing), "risk must rise as speed falls to still")

        speeding = [scorer._kinematics_risk(s) for s in _steps(walk_max, fast, 6)]
        self.assertEqual(speeding, sorted(speeding), "risk must rise as speed rises to fast")

    def test_person_in_red_zone_at_night_moving_fast_scores_red(self):
        """Formerly audit finding A1 (KNOWN GAP, scheduled for Phase 19 as a
        planned "sustained-presence override"): person + red zone + 2am +
        running, with no direction label, totals 25+18+10+12 = 65, which
        under the flat global thresholds (<=69 -> Yellow) capped at a soft
        chime — the textbook infiltration posture a stationary or distant
        subject can never escape, since it never gets a direction label.

        A RED zone's own thresholds (<=12 Green, <=40 Yellow, else Red) mean
        65 is Red there on the additive path alone, with no override needed
        — and separately, sprinting speed now also fires _running_override
        (see test_running_person_forces_red_regardless_of_zone), so this
        case reaches Red by both paths at once. Only the tier is asserted
        here; which mechanism gets there is covered by the dedicated tests
        below.
        """
        scorer = self._scorer()
        score = scorer.score(zone_tier="red", hour=2, speed_px_per_frame=50.0, category="person")
        self.assertEqual(score.tier, "red")

    def test_moderate_speed_in_red_zone_reaches_red_via_zone_sensitivity_alone(self):
        """The original point of the test above, isolated from the running
        override: a speed inside the ramping band (below the sprint
        threshold) still reaches Red in a RED zone purely through additive
        zone sensitivity, with no override firing.

        Uses RED's own (more sensitive) movement config — RED zones now have
        their own zone-specific speed thresholds (see DEFAULT_MOVEMENT_CONFIG_BY_ZONE),
        lower than the global/YELLOW ones, so "moderate" has to be computed
        relative to RED's own walk_max/fast band, not the global one, or this
        speed could already cross RED's (lower) sprint threshold."""
        scorer = self._scorer()
        config = scorer.rules.get_movement_config("red")
        moderate_speed = (config["walk_max_px_per_frame"] + config["fast_speed_px_per_frame"]) / 2
        score = scorer.score(zone_tier="red", hour=2, speed_px_per_frame=moderate_speed, category="person")
        self.assertEqual(score.tier, "red")
        self.assertIsNone(score.override_reason, "reached Red via zone sensitivity, not an override")

    def test_running_person_forces_red_regardless_of_zone(self):
        """A sprinting person is the clearest anomaly a sentry reacts to on
        sight — this forces Red the same way a watchlist hit or a red-zone
        crossing does, instead of being capped at the same +10 a motionless
        person also gets from the additive kinematics term. Checked in a
        YELLOW zone by day specifically because the additive total alone
        (yellow(12) + day(4) + kinematics(10) + person(12) = 38) would only
        reach Yellow without the override."""
        scorer = self._scorer()
        config = scorer.rules.get_movement_config()
        score = scorer.score(
            zone_tier="yellow", hour=14,
            speed_px_per_frame=config["fast_speed_px_per_frame"], category="person",
        )
        self.assertEqual(score.tier, "red")
        self.assertIsNotNone(score.override_reason)
        self.assertIn("running", score.override_reason)

    def test_running_override_ignores_non_person_categories(self):
        """A vehicle or animal moving fast is still covered by the ordinary
        additive kinematics term — the override is person-specific, matching
        a sentry's instinct to react to a running person, not a running dog
        or a fast-moving car (already scored on its own terms elsewhere)."""
        scorer = self._scorer()
        config = scorer.rules.get_movement_config()
        for category in ("vehicle", "animal"):
            score = scorer.score(
                zone_tier="yellow", hour=14,
                speed_px_per_frame=config["fast_speed_px_per_frame"], category=category,
            )
            self.assertIsNone(score.override_reason, f"{category} should not trip the running override")

    def test_running_override_is_capped_at_yellow_with_no_zone(self):
        """Mirrors the watchlist override's behaviour outside any zone: the
        pattern is real (override_reason is still set) but Phase 18's
        no-zone ceiling still applies, since there is no zone to say where it
        happened — matches test_watchlist_match_outside_any_zone_is_capped_at_yellow."""
        scorer = self._scorer()
        config = scorer.rules.get_movement_config()
        score = scorer.score(
            zone_tier="none", hour=14,
            speed_px_per_frame=config["fast_speed_px_per_frame"], category="person",
        )
        self.assertEqual(score.tier, "yellow")
        self.assertIsNotNone(score.override_reason)
        self.assertIn("no zone defined", score.breakdown())

    def test_walking_speed_does_not_trigger_running_override(self):
        scorer = self._scorer()
        config = scorer.rules.get_movement_config()
        walking_speed = (config["walk_min_px_per_frame"] + config["walk_max_px_per_frame"]) / 2
        score = scorer.score(
            zone_tier="yellow", hour=14, speed_px_per_frame=walking_speed, category="person",
        )
        self.assertIsNone(score.override_reason)

    def test_person_in_red_zone_at_night_crossing_inward_scores_red(self):
        """The path that does reach Red today, so the gap above is bounded:
        with a direction label the crossing override fires."""
        scorer = self._scorer()
        score = scorer.score(
            zone_tier="red", hour=2, speed_px_per_frame=50.0,
            category="person", zone_direction="inward",
        )
        self.assertEqual(score.tier, "red")
        self.assertGreaterEqual(score.total, 70)
        self.assertIsNotNone(score.override_reason)

    def test_person_crossing_yellow_zone_is_elevated_to_yellow_not_red(self):
        """Medium sensitivity: the same crossing motion that forces RED in a
        red zone only guarantees Yellow (Caution) in a yellow buffer/approach
        zone — a real siren is still reserved for the restricted core."""
        scorer = self._scorer()
        score = scorer.score(
            zone_tier="yellow", hour=14, speed_px_per_frame=5.0,
            category="person", zone_direction="inward",
        )
        self.assertEqual(score.tier, "yellow")
        self.assertIsNotNone(score.elevate_reason)
        self.assertIsNone(score.override_reason)
        self.assertIn("raised to YELLOW", score.breakdown())

    def test_yellow_elevate_never_downgrades_an_already_higher_tier(self):
        """A watchlist hit in a yellow zone must stay Red — elevate only
        raises a tier that would otherwise land below Yellow."""
        scorer = self._scorer()
        score = scorer.score(
            zone_tier="yellow", hour=14, speed_px_per_frame=5.0, category="person",
            zone_direction="inward", watchlist_match="Test Subject", watchlist_similarity=0.9,
        )
        self.assertEqual(score.tier, "red")
        self.assertIsNotNone(score.override_reason)

    def test_yellow_elevate_does_not_apply_outside_a_yellow_zone(self):
        scorer = self._scorer()
        green = scorer.score(
            zone_tier="green", hour=14, speed_px_per_frame=5.0,
            category="person", zone_direction="inward",
        )
        self.assertIsNone(green.elevate_reason)

    def test_score_level_always_agrees_with_tier(self):
        """A "Red" tier reading "Threat level: MEDIUM" would look like a bug
        — level is derived from tier, not re-computed independently."""
        scorer = self._scorer()
        for zone_tier, speed, hour in (
            ("red", 50.0, 2), ("yellow", 5.0, 14), ("green", 0.0, 14),
        ):
            score = scorer.score(zone_tier=zone_tier, hour=hour, speed_px_per_frame=speed, category="person")
            expected = {"green": "LOW", "yellow": "MEDIUM", "red": "HIGH"}
            if score.tier == "red" and score.total >= 90.0:
                expected["red"] = "CRITICAL"
            self.assertEqual(score.level, expected[score.tier])

    def test_animal_in_green_zone_by_day_standing_still_scores_green(self):
        scorer = self._scorer()
        score = scorer.score(zone_tier="green", hour=14, speed_px_per_frame=0.0, category="animal")
        self.assertEqual(score.tier, "green")

    def test_yellow_zone_person_moving_moderately_scores_yellow(self):
        scorer = self._scorer()
        # yellow(15) + daytime(5) + person(15) = 35 baseline, comfortably yellow
        # even with zero kinematics risk added.
        score = scorer.score(zone_tier="yellow", hour=14, speed_px_per_frame=0.0, category="person")
        self.assertEqual(score.tier, "yellow")

    def test_watchlist_match_in_a_zone_forces_red(self):
        scorer = self._scorer()
        score = scorer.score(
            zone_tier="yellow", hour=2, speed_px_per_frame=3.0, category="person",
            watchlist_match="Test Subject", watchlist_similarity=0.83,
        )
        self.assertEqual(score.tier, "red")
        self.assertIn("watchlist match: Test Subject", score.breakdown())

    def test_watchlist_match_outside_any_zone_is_capped_at_yellow(self):
        """The live failure this fixes: with config/zones_cam0.json empty, every
        watchlist hit logged "score=70 zone=none" and sounded the siren, on
        similarities as low as 0.50. Un-zoned footage has no sector, no line to
        cross and nothing to loiter at, so it tops out at Yellow — logged and
        snapshotted, not screamed about."""
        scorer = self._scorer()
        score = scorer.score(
            zone_tier="none", hour=2, speed_px_per_frame=3.0, category="person",
            watchlist_match="Test Subject", watchlist_similarity=0.51,
        )
        self.assertEqual(score.tier, "yellow")
        self.assertLessEqual(score.total, 69)
        self.assertIn("watchlist match: Test Subject", score.breakdown())
        self.assertIn("no zone defined", score.breakdown())

    def test_no_zone_never_reaches_red_on_ordinary_terms(self):
        scorer = self._scorer()
        for hour in range(24):
            for speed in (0.0, 1.0, 5.0, 50.0):
                score = scorer.score(
                    zone_tier="none", hour=hour,
                    speed_px_per_frame=speed, category="person",
                )
                self.assertNotEqual(
                    score.tier, "red",
                    f"un-zoned person at hour={hour} speed={speed} reached Red",
                )

    def test_unknown_zone_tier_behaves_like_none(self):
        scorer = self._scorer()
        score = scorer.score(zone_tier=None, hour=14, speed_px_per_frame=0.0, category="animal")
        self.assertEqual(score.sector_risk, 0.0)


if __name__ == "__main__":
    unittest.main()
