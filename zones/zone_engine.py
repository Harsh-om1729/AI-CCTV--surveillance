import json
import logging
import math
import os
from datetime import datetime

import cv2
import numpy as np

log = logging.getLogger("ibvap.zones")

ZONE_PRIORITY = {"none": 0, "green": 1, "yellow": 2, "red": 3}


class Zone:
    """A simple polygon region in camera pixel coordinates."""

    def __init__(self, zone_type: str, polygon: list, enabled: bool = True):
        if zone_type not in ("red", "yellow", "green"):
            raise ValueError(f"Unknown zone_type: {zone_type!r}, expected red/yellow/green")
        self.zone_type = zone_type  # "red" | "yellow" | "green"
        self.polygon = polygon  # list of (x, y) pixel points
        self.enabled = enabled  # disabled zones are kept (saved) but ignored by classify()
        self._area = None  # lazily computed and cached by area()

    def contains(self, point: tuple) -> bool:
        """Evaluates whether point (x, y) lies inside or on the polygon contour."""
        if not self.polygon or len(self.polygon) < 3:
            return False
        contour = np.array(self.polygon, dtype=np.int32)
        pt = (float(point[0]), float(point[1]))
        return cv2.pointPolygonTest(contour, pt, False) >= 0

    def centroid(self) -> tuple:
        xs = [p[0] for p in self.polygon]
        ys = [p[1] for p in self.polygon]
        if not xs or not ys:
            return (0.0, 0.0)
        return (sum(xs) / len(xs), sum(ys) / len(ys))

    def area(self) -> float:
        """Polygon area in px^2, via cv2 (already used by contains()) — the
        specificity tiebreak for overlapping same-tier zones: a smaller,
        more specific zone wins over a larger one it happens to sit inside,
        regardless of which was drawn/loaded first. Cached: polygon is fixed
        for the life of the Zone, and this is recomputed on every classify()
        call for every overlapping same-tier zone in the live per-frame path."""
        if self._area is not None:
            return self._area
        if len(self.polygon) < 3:
            self._area = 0.0
        else:
            contour = np.array(self.polygon, dtype=np.float32)
            self._area = abs(cv2.contourArea(contour))
        return self._area

    def to_dict(self) -> dict:
        return {"zone_type": self.zone_type, "polygon": self.polygon, "enabled": self.enabled}

    @classmethod
    def from_dict(cls, data: dict) -> "Zone":
        return cls(
            data["zone_type"],
            [tuple(p) for p in data["polygon"]],
            enabled=data.get("enabled", True),
        )


class ZoneEngine:
    """Classifies a detection's ground position into a Red/Yellow/Green zone
    tier.
    
    Supports:
    1. Fixed Tier (CAMERA_ZONE_TIERS): for cameras viewing an entire sector of
       one tier (e.g., fence-line mounted cameras). Authoritative when set -
       takes precedence over any polygons loaded from configuration below.
    2. Real Geometric Polygons (loaded from config/zones_<camera>.json), used
       only when no fixed tier is set for this camera. A detection's ground
       position ((x1 + x2)/2, y2) is tested via point-in-polygon. Priority:
       Red > Yellow > Green, then — for overlapping zones of the same tier —
       the smaller (more specific) polygon. If outside all polygons, returns
       'none'. Zones only ever carry a raw tier here; an operator-facing
       "role" (Restricted/Buffer/Transit/Authorized) is resolved to a tier
       one layer up, in integration/api.py, via zones/zone_policy.py — this
       class never sees a role name.
    3. Direction analysis: Direction vector compared against border geometry or
       configurable inward_vector.
    4. Curfew re-tiering: Green zones re-tier to Yellow overnight (wraps midnight).
    """

    MIN_DIRECTION_MAGNITUDE = 4.0

    def __init__(
        self,
        config_path: "str | None" = None,
        curfew_start_hour: int = 23,
        curfew_end_hour: int = 5,
        now_fn=datetime.now,
        fixed_tier: "str | None" = None,
        inward_vector: "tuple | None" = None,
    ):
        self.config_path = config_path
        self.curfew_start_hour = curfew_start_hour
        self.curfew_end_hour = curfew_end_hour
        self._now_fn = now_fn
        self.fixed_tier = fixed_tier
        self.inward_vector = inward_vector
        self.zones: list[Zone] = []
        if self.config_path:
            self.load()

    def add_zone(self, zone: Zone) -> None:
        self.zones.append(zone)
        self.save()

    def clear(self) -> None:
        self.zones = []
        self.save()

    def load(self) -> None:
        if not self.config_path or not os.path.exists(self.config_path):
            return
        try:
            with open(self.config_path) as f:
                data = json.load(f)
            self.zones = [Zone.from_dict(z) for z in data if "polygon" in z and "zone_type" in z]
            log.info("Loaded %d zone(s) from %s", len(self.zones), self.config_path)
        except Exception as exc:
            log.warning("Failed loading zones from %s: %s", self.config_path, exc)

    def save(self) -> None:
        if not self.config_path:
            return
        os.makedirs(os.path.dirname(self.config_path) or ".", exist_ok=True)
        with open(self.config_path, "w") as f:
            json.dump([z.to_dict() for z in self.zones], f, indent=2)

    def _is_curfew(self) -> bool:
        hour = self._now_fn().hour
        if self.curfew_start_hour > self.curfew_end_hour:
            return hour >= self.curfew_start_hour or hour < self.curfew_end_hour
        return self.curfew_start_hour <= hour < self.curfew_end_hour

    def classify(self, ground_point: tuple, direction: "tuple | None" = None) -> dict:
        """Returns {"tier": "red"|"yellow"|"green"|"none", "direction": "inward"|"outward"|"parallel"|None}"""
        # A fixed tier (CAMERA_ZONE_TIERS) is authoritative when set - "so its
        # entire view is always that tier" per .env's own documentation. It
        # must win over any polygons still sitting in config/zones_<cam>.json
        # from before the camera was pinned; those are drawn-zone leftovers
        # with no editor left to clear them (the drawing UI was removed), so
        # letting them silently override the operator's explicit setting is
        # exactly the confusing bug this order used to produce: a camera
        # pinned "red" scoring detections as whatever old polygon they fall
        # in, with nothing on screen explaining why.
        if self.fixed_tier is not None:
            tier = self.fixed_tier
            direction_label = self._direction_label_fixed(direction)
        elif self.zones:
            matches = [z for z in self.zones if z.enabled and z.contains(ground_point)]
            if not matches:
                # Outside all defined zones
                return {"tier": "none", "direction": None}
            best = self._select_most_specific(matches)
            tier = best.zone_type
            direction_label = self._direction_label(best, tier, direction)
        else:
            return {"tier": "none", "direction": None}

        if tier == "green" and self._is_curfew():
            tier = "yellow"

        return {"tier": tier, "direction": direction_label}

    @staticmethod
    def _select_most_specific(matches: list) -> Zone:
        """Explicit priority + specificity, not polygon load order: highest
        tier wins first; among zones tied on tier, the smaller (more
        specific) polygon wins, regardless of which was added first."""
        return max(matches, key=lambda z: (ZONE_PRIORITY[z.zone_type], -z.area()))

    def _direction_label(self, zone: Zone, tier: str, direction: "tuple | None") -> "str | None":
        if direction is None:
            return None
        dx, dy = direction
        magnitude = math.hypot(dx, dy)
        if magnitude < self.MIN_DIRECTION_MAGNITUDE:
            return None  # stationary / noise

        # If an explicit camera inward_vector is configured, prioritize it
        if self.inward_vector is not None:
            ix, iy = self.inward_vector
            imag = math.hypot(ix, iy)
            if imag > 0:
                dot = (dx * ix + dy * iy) / (magnitude * imag)
                if abs(dot) < 0.35:
                    return "parallel"
                return "inward" if dot > 0 else "outward"

        if tier == "red":
            reference = self._nearest_centroid(zone, "green")
            if reference is None:
                return "crossing"
            zx, zy = zone.centroid()
            axis = (zx - reference[0], zy - reference[1])
            label_positive, label_negative = "outward", "inward"
        elif tier == "yellow":
            reference = self._nearest_centroid(zone, "red")
            if reference is None:
                # Fallback to fixed directional projection
                return self._direction_label_fixed(direction)
            zx, zy = zone.centroid()
            axis = (reference[0] - zx, reference[1] - zy)
            label_positive, label_negative = "inward", "outward"
        else:
            return None

        axis_magnitude = math.hypot(axis[0], axis[1])
        if axis_magnitude == 0:
            return None
        cosine = (dx * axis[0] + dy * axis[1]) / (magnitude * axis_magnitude)
        if abs(cosine) < 0.35:
            return "parallel"
        return label_positive if cosine > 0 else label_negative

    def _direction_label_fixed(self, direction: "tuple | None") -> "str | None":
        if direction is None:
            return None
        dx, dy = direction
        magnitude = math.hypot(dx, dy)
        if magnitude < self.MIN_DIRECTION_MAGNITUDE:
            return None

        if self.inward_vector is not None:
            ix, iy = self.inward_vector
            imag = math.hypot(ix, iy)
            if imag > 0:
                dot = (dx * ix + dy * iy) / (magnitude * imag)
                if abs(dot) < 0.35:
                    return "parallel"
                return "inward" if dot > 0 else "outward"

        if abs(dy) < abs(dx):
            return "parallel"
        return "inward" if dy > 0 else "outward"

    def _nearest_centroid(self, zone: Zone, zone_type: str) -> "tuple | None":
        candidates = [z for z in self.zones if z.zone_type == zone_type and z is not zone]
        if not candidates:
            return None
        zx, zy = zone.centroid()
        return min(
            (z.centroid() for z in candidates),
            key=lambda c: (c[0] - zx) ** 2 + (c[1] - zy) ** 2,
        )
