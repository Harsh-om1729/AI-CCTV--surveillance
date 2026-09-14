"""Virtual boundaries (tripwires) — kept deliberately separate from zones.

A zone answers "which region is this in?" (zones/zone_engine.py). A boundary
answers "did this track just cross a specific line?" — a different question
with a different answer shape, so it gets its own engine rather than being
folded into ZoneEngine. Geometry is reused wholesale from
zones/border_line.py's BorderLine (distance/side math already implemented
and used by the kinematic model) instead of reimplementing it; this module
only adds identity (id/label/enabled) and per-track crossing detection on
top.

Detection here is display-only: BoundaryEngine.check_crossing() reports that
a crossing happened, it does not touch ThreatScorer or AlertManager.
"""
import json
import logging
import os

from zones.border_line import BorderLine

log = logging.getLogger("ibvap.zones")


class Boundary:
    """One named, enable-able tripwire line for a camera."""

    def __init__(self, id: str, label: str, p1, p2, enabled: bool = True):
        self.id = id
        self.label = label
        self.line = BorderLine(p1, p2)
        self.enabled = enabled

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "p1": list(self.line.p1),
            "p2": list(self.line.p2),
            "enabled": self.enabled,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Boundary":
        return cls(
            id=data["id"],
            label=data.get("label", ""),
            p1=data["p1"],
            p2=data["p2"],
            enabled=data.get("enabled", True),
        )


class BoundaryEngine:
    """Per-camera list of named boundaries, persisted to
    config/boundaries_<camera>.json — same load/save shape as ZoneEngine's
    polygons, deliberately a separate file so zones and boundaries can be
    edited and cleared independently.
    """

    def __init__(self, config_path: "str | None" = None):
        self.config_path = config_path
        self.boundaries: list[Boundary] = []
        # (track_id, boundary_id) -> last-seen signed side. A sign flip
        # between calls is a crossing; this is the only state kept, and it
        # is keyed on the track_id the caller already computed — no new
        # tracking or movement logic here.
        self._last_side: dict[tuple, float] = {}
        if self.config_path:
            self.load()

    def load(self) -> None:
        if not self.config_path or not os.path.exists(self.config_path):
            return
        try:
            with open(self.config_path) as f:
                data = json.load(f)
        except (OSError, ValueError) as exc:
            log.warning("Could not read boundaries %s: %s", self.config_path, exc)
            return
        if isinstance(data, list):
            self.boundaries = [Boundary.from_dict(b) for b in data]
            log.info("Loaded %d boundary(ies) from %s", len(self.boundaries), self.config_path)

    def save(self) -> None:
        if not self.config_path:
            return
        os.makedirs(os.path.dirname(self.config_path) or ".", exist_ok=True)
        with open(self.config_path, "w") as f:
            json.dump([b.to_dict() for b in self.boundaries], f, indent=2)

    def add_boundary(self, boundary: Boundary) -> None:
        self.boundaries.append(boundary)
        self.save()

    def remove_boundary(self, boundary_id: str) -> None:
        self.boundaries = [b for b in self.boundaries if b.id != boundary_id]
        self._last_side = {
            key: side for key, side in self._last_side.items() if key[1] != boundary_id
        }
        self.save()

    def clear(self) -> None:
        self.boundaries = []
        self._last_side = {}
        self.save()

    def check_crossing(self, track_id, point: tuple) -> list[dict]:
        """Returns a list of {"boundaryId", "label", "direction"} events —
        one per enabled boundary this track just crossed. `direction` is
        "positive->negative" or "negative->positive", named after
        BorderLine.signed_side()'s sign; which side is "inward" is for the
        caller/operator to interpret, same as ZoneEngine leaves direction
        interpretation to the config that drew the zone.
        """
        if track_id is None:
            return []
        events = []
        for boundary in self.boundaries:
            if not boundary.enabled:
                continue
            key = (track_id, boundary.id)
            side = boundary.line.signed_side(point)
            prev = self._last_side.get(key)
            self._last_side[key] = side
            if prev is None or prev == 0.0 or side == 0.0:
                continue
            if (prev > 0) != (side > 0):
                events.append(
                    {
                        "boundaryId": boundary.id,
                        "label": boundary.label,
                        "direction": "positive->negative" if side < 0 else "negative->positive",
                    }
                )
        return events
