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
import time

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

    # A track that stops crossing this boundary (left frame, went idle) must
    # eventually drop out of `_last_side`, or a long-running camera with
    # steady foot traffic accumulates one entry per track_id ever seen for
    # the life of the process — unbounded memory and an ever-growing dict
    # scanned on every frame, which is exactly the kind of thing that shows
    # up as FPS quietly declining over a long session. 30s matches the other
    # per-track TTLs in the pipeline (see REID_TTL_SECONDS).
    DEFAULT_TTL_SECONDS = 30.0

    def __init__(
        self,
        config_path: "str | None" = None,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        now_fn=time.monotonic,
    ):
        self.config_path = config_path
        self.ttl_seconds = ttl_seconds
        self._now = now_fn
        self.boundaries: list[Boundary] = []
        # (track_id, boundary_id) -> {"side": last signed side, "seen": last
        # time this key was touched}. A sign flip between calls is a
        # crossing; the side is the only value the crossing logic needs, and
        # it is keyed on the track_id the caller already computed — no new
        # tracking or movement logic here. `seen` exists purely to let
        # _purge_stale() evict entries for tracks that are gone for good.
        self._last_side: dict[tuple, dict] = {}
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
            key: entry for key, entry in self._last_side.items() if key[1] != boundary_id
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
        now = self._now()
        events = []
        for boundary in self.boundaries:
            if not boundary.enabled:
                continue
            key = (track_id, boundary.id)
            side = boundary.line.signed_side(point)
            prev_entry = self._last_side.get(key)
            prev = prev_entry["side"] if prev_entry is not None else None
            self._last_side[key] = {"side": side, "seen": now}
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
        self._purge_stale(now)
        return events

    def _purge_stale(self, now: float) -> None:
        stale = [
            key for key, entry in self._last_side.items()
            if now - entry["seen"] > self.ttl_seconds
        ]
        for key in stale:
            del self._last_side[key]
