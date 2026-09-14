import cv2
import numpy as np

from zones.zone_engine import ZoneEngine

ZONE_COLORS = {"red": (0, 0, 255), "yellow": (0, 255, 255), "green": (0, 255, 0)}
BORDER_COLOR = (255, 0, 255)


class ZoneDrawer:
    """Read-only on-screen rendering of a camera's configured zones.

    Interactive drawing (mouse clicks + r/y/g/b/c keys) used to live here
    too; it's gone. Zones are configured through config/zones_<camera>.json
    or CAMERA_ZONE_TIERS now, not drawn live on the OpenCV window.
    """

    def __init__(self, window_name: str, engine: ZoneEngine, border_store=None):
        self.window_name = window_name
        self.engine = engine
        self.border_store = border_store

    def draw_overlay(self, frame) -> None:
        if self.engine.fixed_tier is not None:
            # This camera is pinned to one tier via CAMERA_ZONE_TIERS - any
            # polygons still sitting in its zones.json are leftovers from
            # before that switch and are no longer used for scoring at all
            # (see ZoneEngine.classify). Drawing them would show boundaries
            # that don't mean anything anymore, so a label replaces the lines.
            color = ZONE_COLORS[self.engine.fixed_tier]
            cv2.putText(
                frame, f"FIXED TIER: {self.engine.fixed_tier.upper()}", (10, 24),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2,
            )
        else:
            for zone in self.engine.zones:
                color = ZONE_COLORS[zone.zone_type]
                pts = np.array(zone.polygon, dtype=np.int32)
                cv2.polylines(frame, [pts], True, color, 2)

        # A saved border line stays visible so the operator can see the geometry
        # the kinematic score is measuring against.
        if self.border_store is not None and self.border_store.line is not None:
            line = self.border_store.line
            p1 = (int(line.p1[0]), int(line.p1[1]))
            p2 = (int(line.p2[0]), int(line.p2[1]))
            cv2.line(frame, p1, p2, BORDER_COLOR, 2)
            cv2.putText(frame, "BORDER", (p1[0] + 4, p1[1] - 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, BORDER_COLOR, 1)
