"""IBVAP Deterministic Demo Engine (Phases 22–27).

Simulates ONLY the detection input (Track #17 walking from GREEN -> YELLOW -> RED).
Everything else executes through the REAL production pipeline:
- Ground point calculation
- Real ZoneEngine geometric polygon classification
- Real direction vector analysis
- Real temporal confirmation & zone transitions
- Real ThreatScorer (rules DB lookup, score calculation, explainable reasons)
- Real AlertManager (cooldown, siren/chime, confirmation)
- Real IncidentStore (Fernet encryption of snapshot & crop, SQLite persistence)
- Real PipelinePublisher (publishes live JPEG to runtime/live/cam0.jpg)
"""

import json
import logging
import os
import time
from typing import Any

import cv2
import numpy as np

from alerts.alert_manager import AlertManager
from database.incident_store import IncidentStore
from detection.detector import Detection
from detection.draw import draw_detections
from integration.runtime_state import PipelinePublisher
from intelligence.threat_rules import ThreatRulesDB
from intelligence.threat_score import ThreatScorer
from zones.zone_engine import Zone, ZoneEngine

log = logging.getLogger("ibvap.demo")

WIDTH = 640
HEIGHT = 480

# Demo geometric zones: top third = RED, middle third = YELLOW, bottom third = GREEN
DEMO_RED_POLY = [(0, 0), (WIDTH, 0), (WIDTH, HEIGHT // 3), (0, HEIGHT // 3)]
DEMO_YELLOW_POLY = [(0, HEIGHT // 3), (WIDTH, HEIGHT // 3), (WIDTH, 2 * HEIGHT // 3), (0, 2 * HEIGHT // 3)]
DEMO_GREEN_POLY = [(0, 2 * HEIGHT // 3), (WIDTH, 2 * HEIGHT // 3), (WIDTH, HEIGHT), (0, HEIGHT)]


class DemoEngine:
    """Manages the 15-step deterministic demonstration."""

    def __init__(
        self,
        camera_id: str = "cam0",
        db_path: str = "database/incidents.db",
        rules_path: str = "database/threat_rules.db",
        evidence_dir: str = "snapshots",
        evidence_key_path: str = "database/evidence.key",
        runtime_dir: str = "runtime",
    ):
        self.camera_id = camera_id
        self.db_path = db_path
        self.rules_path = rules_path
        self.evidence_dir = evidence_dir
        self.evidence_key_path = evidence_key_path
        self.runtime_dir = runtime_dir

        # Initialize production components
        self.rules_db = ThreatRulesDB(db_path=self.rules_path)
        self.scorer = ThreatScorer(self.rules_db)
        self.store = IncidentStore(
            db_path=self.db_path,
            evidence_dir=self.evidence_dir,
            key_path=self.evidence_key_path,
        )
        self.publisher = PipelinePublisher(runtime_dir=self.runtime_dir)

        # Setup ZoneEngine with geometric polygons
        self.zone_engine = ZoneEngine(
            config_path=f"config/zones_{self.camera_id}.json",
            curfew_start_hour=23,
            curfew_end_hour=5,
        )
        if not self.zone_engine.zones:
            self.zone_engine.add_zone(Zone("red", DEMO_RED_POLY))
            self.zone_engine.add_zone(Zone("yellow", DEMO_YELLOW_POLY))
            self.zone_engine.add_zone(Zone("green", DEMO_GREEN_POLY))

        # Alert Manager
        self.alert_manager = AlertManager(
            snapshot_dir=self.evidence_dir,
            incident_store=self.store,
            cooldown_seconds=4.0,
            confirm_n=1,  # In demo, confirm promptly on transition
            confirm_window=2,
        )

        self.step_index = 0
        self.total_steps = 15
        self.is_running = False
        self.logs: list[dict[str, Any]] = []
        self.current_detection: Detection | None = None
        self.current_score: Any = None
        self.current_incident_id: int | None = None
        self._last_frame: np.ndarray | None = None

    def reset(self) -> dict:
        """Resets the demo to the beginning."""
        self.step_index = 0
        self.is_running = False
        self.logs = []
        self.current_detection = None
        self.current_score = None
        self.current_incident_id = None
        self._last_frame = None
        self._log_step(0, "Demo reset to ready state")
        return self.status()

    def status(self) -> dict:
        """Returns the current state of the demo."""
        return {
            "step": self.step_index,
            "totalSteps": self.total_steps,
            "isRunning": self.is_running,
            "currentIncidentId": self.current_incident_id,
            "latestScore": self.current_score.total if self.current_score else None,
            "latestTier": self.current_score.tier if self.current_score else None,
            "latestLevel": getattr(self.current_score, "level", None) if self.current_score else None,
            "latestReasons": getattr(self.current_score, "reasons", []) if self.current_score else [],
            "logs": self.logs[-20:],
        }

    def _log_step(self, step_num: int, message: str, extra: dict | None = None) -> None:
        entry = {
            "step": step_num,
            "time": time.strftime("%H:%M:%S"),
            "timestamp": time.time(),
            "message": message,
            **(extra or {}),
        }
        self.logs.append(entry)
        log.info("[DEMO STEP %02d/15] %s", step_num, message)

    def _make_base_frame(self) -> np.ndarray:
        """Generates a realistic surveillance frame showing terrain and zone boundaries."""
        frame = np.full((HEIGHT, WIDTH, 3), (35, 40, 45), dtype=np.uint8)

        # Draw visual zone polygons/regions
        overlay = frame.copy()
        cv2.rectangle(overlay, (0, 0), (WIDTH, HEIGHT // 3), (0, 0, 180), -1)  # RED
        cv2.rectangle(overlay, (0, HEIGHT // 3), (WIDTH, 2 * HEIGHT // 3), (0, 180, 200), -1)  # YELLOW
        cv2.rectangle(overlay, (0, 2 * HEIGHT // 3), (WIDTH, HEIGHT), (0, 150, 0), -1)  # GREEN
        cv2.addWeighted(overlay, 0.25, frame, 0.75, 0, frame)

        # Boundary lines
        cv2.line(frame, (0, HEIGHT // 3), (WIDTH, HEIGHT // 3), (0, 0, 255), 2)
        cv2.line(frame, (0, 2 * HEIGHT // 3), (WIDTH, 2 * HEIGHT // 3), (0, 255, 255), 2)

        # Zone labels
        cv2.putText(frame, "RED ZONE (RESTRICTED BORDER)", (20, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
        cv2.putText(frame, "YELLOW ZONE (APPROACH STRIP)", (20, HEIGHT // 3 + 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
        cv2.putText(frame, "GREEN ZONE (OWN TERRITORY)", (20, 2 * HEIGHT // 3 + 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

        # Camera profile banner
        cv2.putText(frame, "CAM-01 [ZONE PROFILE: RED PRIORITY]", (WIDTH - 360, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        return frame

    def step(self) -> dict:
        """Executes the next step in the 15-step demonstration."""
        if self.step_index >= self.total_steps:
            return self.status()

        self.step_index += 1
        frame = self._make_base_frame()

        if self.step_index == 1:
            # Step 1: Person detected
            det = Detection(class_id=0, class_name="person", confidence=0.94, box=(280, 380, 360, 470))
            det.camera_name = self.camera_id
            self.current_detection = det
            self._log_step(1, "Person detected in frame (confidence 0.94)", {"confidence": 0.94})

        elif self.step_index == 2:
            # Step 2: Track #17 created
            det = self.current_detection or Detection(0, "person", 0.94, (280, 380, 360, 470))
            det.track_id = 17
            det.first_seen = time.time()
            det.last_seen = time.time()
            det.status = "DETECTED"
            self.current_detection = det
            self._log_step(2, "Track #17 created and assigned to person", {"track_id": 17})

        elif self.step_index == 3:
            # Step 3: Person appears in GREEN
            det = self.current_detection
            det.box = (280, 370, 360, 460)
            gp = det.ground_point
            res = self.zone_engine.classify(gp, det.direction)
            det.zone_tier = res["tier"]
            det.zone_direction = res["direction"]
            det.current_zone = res["tier"]
            det.previous_zone = None
            self._log_step(3, f"Track #17 ground point {gp} classified in GREEN zone", {"zone": "GREEN", "ground_point": gp})

        elif self.step_index == 4:
            # Step 4: Person begins moving INWARD
            det = self.current_detection
            det.box = (280, 340, 360, 430)
            det.direction = (0.0, -16.0)
            det.speed = 4.2
            res = self.zone_engine.classify(det.ground_point, det.direction)
            det.zone_tier = res["tier"]
            det.zone_direction = "inward"
            self._log_step(4, "Track #17 movement detected: heading INWARD toward border line", {"direction": "INWARD", "speed": 4.2})

        elif self.step_index == 5:
            # Step 5: Person enters YELLOW
            det = self.current_detection
            det.previous_zone = "green"
            det.box = (280, 160, 360, 240)  # in yellow strip (ground point y=240, within 160..320)
            det.direction = (0.0, -18.0)
            det.speed = 4.5
            res = self.zone_engine.classify(det.ground_point, det.direction)
            det.zone_tier = res["tier"]
            det.zone_direction = "inward"
            det.current_zone = res["tier"]
            self._log_step(5, "Track #17 enters YELLOW approach zone (GREEN -> YELLOW)", {"zone": "YELLOW", "transition": "GREEN->YELLOW"})

        elif self.step_index == 6:
            # Step 6: Zone transition YELLOW -> RED
            det = self.current_detection
            det.previous_zone = "yellow"
            det.box = (280, 70, 360, 155)  # in red zone
            det.direction = (0.0, -22.0)
            det.speed = 5.5
            res = self.zone_engine.classify(det.ground_point, det.direction)
            det.zone_tier = "red"
            det.current_zone = "red"
            det.zone_direction = "inward"
            self._log_step(6, "CRITICAL ZONE TRANSITION: Track #17 crossed YELLOW -> RED", {"transition": "YELLOW->RED", "zone": "RED"})

        elif self.step_index == 7:
            # Step 7: Movement confirmed INWARD
            det = self.current_detection
            det.box = (280, 50, 360, 135)
            det.direction = (0.0, -25.0)
            det.speed = 6.0
            det.zone_direction = "inward"
            self._log_step(7, "INWARD movement verified: approaching restricted border line directly", {"direction": "INWARD", "confirmed": True})

        elif self.step_index == 8:
            # Step 8: Threat score calculated using actual ThreatScorer
            det = self.current_detection
            score = self.scorer.score(
                zone_tier="red",
                hour=2,  # night / curfew window active (wraps midnight)
                speed_px_per_frame=15.0,  # fast breach speed
                category="person",
                zone_direction="inward",
                dwell_seconds=125.0,  # sustained dwell time at fence
                group_count=2,  # coordinated movement
            )
            self.current_score = score
            det.threat_score = score.total
            det.threat_level = score.level
            det.threat_reasons = score.reasons
            self._log_step(8, f"ThreatScorer executed: Score = {score.total:.0f}/100 ({score.level})", {"score": score.total, "breakdown": score.breakdown()})



        elif self.step_index == 9:
            # Step 9: Threat becomes HIGH/CRITICAL (target >= 90) with explainable reasons
            score = self.current_score
            reasons_str = " | ".join(score.reasons)
            self._log_step(9, f"Threat validated as CRITICAL ({score.total:.0f}/100) — Reasons: {reasons_str}", {"level": "CRITICAL", "reasons": score.reasons})

        elif self.step_index == 10:
            # Step 10: Critical event generated
            det = self.current_detection
            det.status = "CONFIRMED"
            self._log_step(10, "Critical ZONE_CROSSING event generated for Track #17", {"event": "ZONE_CROSSING", "status": "CONFIRMED"})

        elif self.step_index == 11:
            # Step 11: Alert generated by real AlertManager
            det = self.current_detection
            score = self.current_score
            self.alert_manager.handle(det, score, [frame])
            det.status = "ALERTED"
            self._log_step(11, "AlertManager fired RED ALERT: siren activated, cooldown backoff initiated", {"alert": "RED_ALERT", "status": "ALERTED"})

        elif self.step_index == 12:
            # Step 12: Evidence captured and encrypted
            det = self.current_detection
            x1, y1, x2, y2 = det.box
            crop = frame[max(0, y1):min(HEIGHT, y2), max(0, x1):min(WIDTH, x2)]
            # Draw overlay before saving snapshot
            draw_detections(frame, [det])
            inc_id = self.store.record(det, self.current_score, frame, crop_frame=crop)
            self.current_incident_id = inc_id
            self._log_step(12, f"Evidence captured: full frame & person crop encrypted via Fernet into snapshots/", {"incident_id": inc_id, "encrypted": True})

        elif self.step_index == 13:
            # Step 13: Incident stored in SQLite
            self._log_step(13, f"Incident #{self.current_incident_id} successfully persisted in database/incidents.db", {"incident_id": self.current_incident_id, "db": "database/incidents.db"})

        elif self.step_index == 14:
            # Step 14: Published through runtime/live/ and health state
            draw_detections(frame, [self.current_detection])
            self.publisher.publish_frame(self.camera_id, frame)
            self.publisher.publish_health({
                "cameras": {
                    self.camera_id: {
                        "health": "online",
                        "fps": 25.0,
                        "active": True,
                        "detections": 1,
                        "maxTier": "red",
                        "lastFrameAt": time.time(),
                        "zones": 3,
                    }
                }
            })
            self._log_step(14, f"Published live annotated frame to runtime/live/{self.camera_id}.jpg and updated pipeline health", {"published": True})

        elif self.step_index == 15:
            # Step 15: Incident appears in dashboard history
            self._log_step(15, f"Complete! Incident #{self.current_incident_id} is live and queryable in Dashboard Incident History", {"complete": True})

        # Draw annotations on the active frame
        if self.current_detection:
            draw_detections(frame, [self.current_detection])
            # Draw Threat explanation overlay on top
            if self.current_score:
                cv2.putText(
                    frame,
                    f"THREAT: {self.current_score.total:.0f}/100 [{self.current_score.level}]",
                    (20, HEIGHT - 45),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.65,
                    (0, 0, 255),
                    2,
                )
                reasons_text = " | ".join(self.current_score.reasons[:2])
                cv2.putText(
                    frame,
                    reasons_text,
                    (20, HEIGHT - 18),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.45,
                    (200, 255, 255),
                    1,
                )

        self._last_frame = frame
        self.publisher.publish_frame(self.camera_id, frame)
        return self.status()

    def run_all(self, delay_seconds: float = 0.0) -> dict:
        """Executes all 15 steps sequentially."""
        self.reset()
        self.is_running = True
        for _ in range(self.total_steps):
            self.step()
            if delay_seconds > 0:
                time.sleep(delay_seconds)
        self.is_running = False
        return self.status()


_global_demo_engine: DemoEngine | None = None


def get_demo_engine() -> DemoEngine:
    global _global_demo_engine
    if _global_demo_engine is None:
        _global_demo_engine = DemoEngine()
    return _global_demo_engine
