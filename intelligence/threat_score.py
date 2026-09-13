from intelligence.threat_rules import ThreatRulesDB

GREEN_MAX = 30
YELLOW_MAX = 69


class ThreatScore:
    __slots__ = (
        "sector_risk", "time_risk", "kinematics_risk", "class_confidence",
        "direction_risk", "loiter_risk", "group_risk", "total", "tier",
        "override_reason", "tier_ceiling", "ceiling_reason",
    )

    # A breach of the border line is a priority event whatever the clock says.
    # An additive score can't express that through weights alone without
    # distorting every other case, so it is an explicit override — the same
    # pattern the watchlist match already uses. The component breakdown is
    # still reported, so the escalation stays transparent rather than magic.
    OVERRIDE_MIN_TOTAL = 70.0

    TIER_RANK = {"green": 0, "yellow": 1, "red": 2}
    TIER_MAX_TOTAL = {"green": float(GREEN_MAX), "yellow": float(YELLOW_MAX), "red": 100.0}

    def __init__(
        self,
        sector_risk: float,
        time_risk: float,
        kinematics_risk: float,
        class_confidence: float,
        direction_risk: float = 0.0,
        loiter_risk: float = 0.0,
        group_risk: float = 0.0,
        override_reason: "str | None" = None,
        tier_ceiling: "str | None" = None,
        ceiling_reason: "str | None" = None,
    ):
        self.sector_risk = sector_risk
        self.time_risk = time_risk
        self.kinematics_risk = kinematics_risk
        self.class_confidence = class_confidence
        self.direction_risk = direction_risk
        self.loiter_risk = loiter_risk
        self.group_risk = group_risk
        self.total = min(
            100.0,
            sector_risk + time_risk + kinematics_risk + class_confidence
            + direction_risk + loiter_risk + group_risk,
        )
        if self.total <= GREEN_MAX:
            self.tier = "green"
        elif self.total <= YELLOW_MAX:
            self.tier = "yellow"
        else:
            self.tier = "red"

        self.override_reason = override_reason
        if override_reason is not None:
            self.tier = "red"
            self.total = max(self.total, self.OVERRIDE_MIN_TOTAL)

        # Phase 18: the ceiling is applied last, so it binds the overrides too.
        # An override says "this pattern matters"; the ceiling says "we cannot
        # tell where this is happening", and the second qualifies the first —
        # otherwise un-zoned footage still emits Red on a borderline match,
        # which is the alert flood Phase 18 exists to stop. The reason is kept
        # and reported, so a capped alert reads as a deliberate downgrade
        # rather than a missing detection.
        self.tier_ceiling = tier_ceiling
        self.ceiling_reason = ceiling_reason
        if tier_ceiling is not None and self.TIER_RANK[self.tier] > self.TIER_RANK[tier_ceiling]:
            self.tier = tier_ceiling
            self.total = min(self.total, self.TIER_MAX_TOTAL[tier_ceiling])

    @property
    def level(self) -> str:
        if self.total <= GREEN_MAX:
            return "LOW"
        if self.total <= YELLOW_MAX:
            return "MEDIUM"
        if self.total < 90.0:
            return "HIGH"
        return "CRITICAL"

    @property
    def threat_level(self) -> str:
        return self.level

    @property
    def reasons(self) -> list[str]:
        items = []
        if self.override_reason:
            items.append(f"Override: {self.override_reason}")
        if self.sector_risk >= 25 or (self.override_reason and "border" in self.override_reason.lower()):
            items.append(f"Entered RED zone (+{self.sector_risk:.0f})")
        elif self.sector_risk > 0:
            items.append(f"In active zone sector (+{self.sector_risk:.0f})")
        if self.direction_risk > 0:
            items.append(f"Moving INWARD toward border (+{self.direction_risk:.0f})")
        if self.time_risk >= 20:
            items.append(f"Curfew window active (+{self.time_risk:.0f})")
        elif self.time_risk > 0:
            items.append(f"Time-of-day risk factor (+{self.time_risk:.0f})")
        if self.kinematics_risk >= 10:
            items.append(f"High approach speed (+{self.kinematics_risk:.0f})")
        if self.loiter_risk > 0:
            items.append(f"Loitering persistence exceeded (+{self.loiter_risk:.0f})")
        if self.group_risk > 0:
            items.append(f"Group movement detected (+{self.group_risk:.0f})")
        if self.class_confidence > 0:
            items.append(f"Confirmed target classification (+{self.class_confidence:.0f})")
        return items

    def breakdown(self) -> str:
        """One-line "why", for the log and the on-screen overlay. Only the
        components that actually contributed are listed, so a sentry reads the
        cause of a Red at a glance instead of seven mostly-zero numbers."""
        parts = [
            ("sector", self.sector_risk), ("time", self.time_risk),
            ("move", self.kinematics_risk), ("class", self.class_confidence),
            ("direction", self.direction_risk), ("loiter", self.loiter_risk),
            ("group", self.group_risk),
        ]
        summary = " + ".join(f"{n} {v:.0f}" for n, v in parts if v > 0) or "none"
        if self.override_reason is not None:
            summary += f"  [forced RED: {self.override_reason}]"
        if self.ceiling_reason is not None and self.tier_ceiling is not None:
            summary += f"  [capped at {self.tier_ceiling.upper()}: {self.ceiling_reason}]"
        return summary


class ThreatScorer:
    """Combines the offline rule lookups into one transparent 0-100 score:

        T = S_sector + T_time + K_kinematics + C_class
            + D_direction + L_loiter + G_group

    0-30 -> Green (log), 31-69 -> Yellow (warn+snapshot), 70-100 -> Red
    (priority). Deliberately transparent: a sentry sees *why* something scored
    Red — which component drove it — not just a black-box alert.

    The last three terms are what make this a *border* rule set rather than a
    generic intrusion alarm:
      - direction: crossing the line matters, and in both senses (inward is
        infiltration, outward is exfiltration/smuggling). Walking parallel to
        the fence scores lower but is not free — that is what reconnaissance
        along a fence looks like.
      - loiter: dwell time inside a zone, keyed on the Re-ID person_id so it
        survives the tracker losing and re-acquiring someone. Standing still
        at the fence is invisible to a speed-based rule.
      - group: several people at the line together is a different event from
        one person.
    """

    def __init__(self, rules: ThreatRulesDB):
        self.rules = rules

    def score(
        self,
        zone_tier: str,
        hour: int,
        speed_px_per_frame: float,
        category: str,
        zone_direction: "str | None" = None,
        dwell_seconds: float = 0.0,
        group_count: int = 1,
        watchlist_match: "str | None" = None,
        watchlist_similarity: "float | None" = None,
    ) -> ThreatScore:
        sector_risk = self.rules.get_sector_risk(zone_tier or "none")
        time_risk = self.rules.get_time_risk(hour)
        class_confidence = self.rules.get_class_confidence(category)
        kinematics_risk = self._kinematics_risk(speed_px_per_frame)

        # The border-specific terms apply to people inside a defined zone.
        # Outside any zone there is no border line to cross, loiter at, or
        # gather on, so charging for them would just re-create the alert flood
        # the old rule set produced on un-zoned footage.
        in_zone = bool(zone_tier) and zone_tier != "none"
        is_person = category == "person"
        direction_risk = self.rules.get_direction_risk(zone_direction) if in_zone else 0.0
        loiter_risk = (
            self._loiter_risk(dwell_seconds) if in_zone and is_person else 0.0
        )
        group_risk = (
            self.rules.get_group_risk(group_count) if in_zone and is_person else 0.0
        )

        # A watchlist hit outranks a crossing: it names *who* this is, not just
        # what they did. Both are reported the same way so the log states the
        # cause either way.
        override_reason = self._watchlist_override(
            watchlist_match, watchlist_similarity
        ) or self._crossing_override(zone_tier, zone_direction, category)

        return ThreatScore(
            sector_risk, time_risk, kinematics_risk, class_confidence,
            direction_risk, loiter_risk, group_risk,
            override_reason=override_reason,
            tier_ceiling=None if in_zone else self.NO_ZONE_CEILING,
            ceiling_reason=None if in_zone else "no zone defined for this camera",
        )

    # Animals are deliberately exempt: livestock and strays cross a border line
    # constantly, and forcing every one of them to Red is exactly the false-alarm
    # source that gets a system switched off.
    CROSSING_DIRECTIONS = ("inward", "outward", "crossing")
    OVERRIDE_CATEGORIES = ("person", "vehicle")

    # Phase 18: with no zones drawn, every geographic term in the score is
    # unavailable — there is no sector, no line to cross, nothing to loiter at.
    # Scoring anything Red on the remaining time/speed/class terms alone claims
    # a certainty the system does not have, so un-zoned footage tops out at
    # Yellow: still logged, still snapshotted, no siren.
    NO_ZONE_CEILING = "yellow"

    def _watchlist_override(
        self, match_name: "str | None", similarity: "float | None"
    ) -> "str | None":
        if match_name is None:
            return None
        if similarity is None:
            return f"watchlist match: {match_name}"
        return f"watchlist match: {match_name} (similarity={similarity:.2f})"

    def _crossing_override(
        self, zone_tier: str, zone_direction: "str | None", category: str
    ) -> "str | None":
        if zone_tier != "red":
            return None
        if category not in self.OVERRIDE_CATEGORIES:
            return None
        if zone_direction not in self.CROSSING_DIRECTIONS:
            return None
        return f"{category} crossing the border line ({zone_direction})"

    def _kinematics_risk(self, speed: float) -> float:
        r"""U-curve: both near-stationary and running score high, an ordinary
        walking pace scores lowest.

            risk
             max |\                    /
                 | \                  /
               0 |  \________________/
                 +--|----|--------|--|----> speed
                  still walk_min walk_max fast

        The old rule was a straight line with "faster = worse", which scored a
        man lying still at the fence — the textbook infiltration posture — as
        zero risk.
        """
        config = self.rules.get_movement_config()
        still = config["still_speed_px_per_frame"]
        walk_min = config["walk_min_px_per_frame"]
        walk_max = config["walk_max_px_per_frame"]
        fast = config["fast_speed_px_per_frame"]
        max_risk = config["max_movement_risk"]

        if speed <= still:
            return max_risk
        if speed < walk_min:
            # Ramping down out of "stationary" into the walking band.
            fraction = (speed - still) / (walk_min - still)
            return (1.0 - fraction) * max_risk
        if speed <= walk_max:
            return 0.0
        if speed >= fast:
            return max_risk
        fraction = (speed - walk_max) / (fast - walk_max)
        return fraction * max_risk

    def _loiter_risk(self, dwell_seconds: float) -> float:
        config = self.rules.get_loiter_config()
        if dwell_seconds >= config["alert_seconds"]:
            return config["alert_risk"]
        if dwell_seconds >= config["warn_seconds"]:
            return config["warn_risk"]
        return 0.0
