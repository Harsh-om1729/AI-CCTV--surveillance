import logging
import os
import sys
import time
from collections import deque
from datetime import datetime

# Must be set BEFORE cv2 is imported — OpenCV reads this when it initialises
# its FFmpeg backend.
#
# timeout;5000000 — 5s, in microseconds, instead of FFmpeg's 30s default. A
# dropped RTSP stream otherwise blocks the producer thread inside a single
# cap.read() for 30s ("Stream timeout triggered after 30100 ms"), far past the
# ~2.5s CameraStream.MAX_CONSECUTIVE_FAILURES budget meant to spot a dead
# camera quickly. "timeout" is the current option name and "stimeout" the
# pre-FFmpeg-5.0 one; both are passed so the limit applies whichever build
# OpenCV was linked against.
#
# rtsp_transport;tcp — measured, not assumed. Against this project's phone
# camera (Android IP Webcam, 1080p over Wi-Fi), 150 consecutive frames each way:
#   UDP (FFmpeg default): 68 and 108 decode errors across two runs, 5 frames lost
#   TCP                 : 0 decode errors across two runs, 0 frames lost
# UDP's losses arrive as "error while decoding MB" and "intra mode" corruption —
# garbled macroblocks handed straight to the detector, which is far worse for
# tracking than TCP's lower throughput. TCP is slower on a 1080p stream (~11-19
# fps vs UDP's buffered ~60), so the real win is lowering the *sender's*
# resolution: fewer bits makes TCP both clean and fast.
os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "rtsp_transport;tcp|timeout;5000000|stimeout;5000000",
)

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from activity_gate.gate import ActivityGate
from alerts.alert_manager import AlertManager
from alerts.dispatch import AlertDispatcher
from camera.health import CameraErrorIsolator, CameraHealth
from camera.stream_manager import StreamManager
from config.settings import (
    ALERT_CONFIRM_FRACTION,
    ALERT_CONFIRM_SECONDS,
    ALERT_COOLDOWN_SECONDS,
    ALERT_MAX_COOLDOWN_SECONDS,
    ALERT_DISPATCH_QUEUE_SIZE,
    BRIGHTNESS_THRESHOLD,
    CAMERA_HEIGHT,
    CAMERA_SOURCES,
    CAMERA_WIDTH,
    CAMERA_ZONE_TIERS,
    _parse_camera_sources,
    CURFEW_END_HOUR,
    CURFEW_START_HOUR,
    DETECTION_CONFIDENCE,
    DETECTION_MODEL_PATH,
    HARDWARE_PROFILE,
    IDLE_MIN_FPS,
    MAX_TIER_HOLD_SECONDS,
    MOTION_THRESHOLD,
    RUNNING_ALERT_HOLD_SECONDS,
    REID_FACE_CHECK_INTERVAL,
    REID_MATCH_MARGIN,
    REID_MODEL_PATH,
    REID_SIMILARITY_THRESHOLD,
    REID_TTL_SECONDS,
    SYSLOG_HOST,
    SYSLOG_PORT,
    WATCHLIST_SIMILARITY_THRESHOLD,
    WEBHOOK_URL,
    configure_logging,
)
from config.providers import select_providers
from database.incident_store import IncidentStore
from detection.draw import draw_detections
from face.face_recognizer import FaceRecognizer
from face.watchlist import WatchlistDB, WatchlistMatcher
from filtering.false_alarm import FalseAlarmFilter
from integration.syslog_notifier import SyslogNotifier
from integration.runtime_state import PipelinePublisher, read_health
from integration.webhook import WebhookNotifier
from intelligence.loiter import LoiterTracker
from intelligence.threat_rules import ThreatRulesDB
from intelligence.threat_score import ThreatScorer
from preprocessing.enhance import Preprocessor
from profiling.stage_profiler import StageProfiler
from reid.embedder import OSNetEmbedder
from reid.reid import PersonGallery
from runtime.startup_check import StartupValidator
from tracking.tracker import Tracker
from zones.boundary_engine import BoundaryEngine
from zones.drawer import ZoneDrawer
from zones.zone_engine import ZoneEngine
from demo.demo_engine import get_demo_engine

configure_logging()
log = logging.getLogger("ibvap")



def cli_camera_sources(argv: list) -> "dict[str, int | str] | None":
    """Lets camera sources be given directly on the command line instead of
    only via CAMERA_SOURCES in .env — e.g.:

        python app.py rtsp://192.168.1.46:8080/h264_ulaw.sdp
        python app.py 0 rtsp://192.168.1.46:8080/h264_ulaw.sdp   # webcam + phone, both live
        python app.py cam_phone=rtsp://192.168.1.46:8080/h264_ulaw.sdp

    Each positional argument is one camera: a bare RTSP/URL or webcam index
    is auto-named cam0, cam1, ...; name=source gives it a custom name. Reuses
    config.settings' own parser so the two entry points parse identically.
    Returns None (meaning "use CAMERA_SOURCES from .env") if no camera
    arguments were given.
    """
    positional = [a for a in argv if not a.startswith("--")]
    if not positional:
        return None

    parts = []
    for i, entry in enumerate(positional):
        name, _, _value = entry.partition("=")
        # A real name=value split has a plain identifier before the "=". If
        # that part looks like a URL scheme or a webcam index instead, the
        # "=" almost certainly belongs to the URL itself (e.g. a query
        # string, "...?user=admin"), so treat the whole entry as bare.
        is_valid_name = "=" in entry and name and "://" not in name and not name.isdigit()
        parts.append(entry if is_valid_name else f"cam{i}={entry}")
    return _parse_camera_sources(",".join(parts))


def draw_debug_overlay(frame, preprocessor: Preprocessor, active: bool, motion_score: float):
    boost_status = "LOW-LIGHT BOOST: ON" if preprocessor.last_boost_applied else "LOW-LIGHT BOOST: OFF"
    boost_color = (0, 0, 255) if preprocessor.last_boost_applied else (0, 200, 0)
    boost_label = (
        f"{boost_status}  brightness={preprocessor.last_brightness:.1f} "
        f"(threshold={BRIGHTNESS_THRESHOLD:.0f})"
    )
    cv2.putText(frame, boost_label, (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, boost_color, 2)

    activity_status = "ACTIVITY: HIGH (full pipeline)" if active else "ACTIVITY: LOW (keep-alive)"
    activity_color = (0, 0, 255) if active else (255, 150, 0)
    activity_label = f"{activity_status}  motion={motion_score:.2f} (threshold={MOTION_THRESHOLD:.1f})"
    cv2.putText(frame, activity_label, (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.6, activity_color, 2)


def draw_fps_overlay(frame, fps: float):
    cv2.putText(
        frame, f"FPS: {fps:.1f}", (10, 75), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2
    )


TIER_COLORS = {"green": (0, 200, 0), "yellow": (0, 220, 220), "red": (0, 0, 255)}

# The movement thresholds in threat_rules.py (walk_max, fast_speed, ...) are
# tuned in raw pixels/FRAME, which implicitly assumes a roughly-constant
# capture rate close to this value (matching kinematic_score.py's own
# nominal_fps default). px/frame for the SAME real-world speed scales
# inversely with fps: drop the pipeline to ~8fps (e.g. two cameras sharing
# one CPU-bound sequential loop) and an ordinary walker's per-frame
# displacement roughly triples, tripping the "running" band on nothing more
# than an ordinary walk. Rescaling to this nominal rate before scoring keeps
# the thresholds meaning the same real-world speed regardless of how fast or
# slow the camera is actually being sampled this moment.
NOMINAL_KINEMATICS_FPS = 20.0


def zone_group_count(detections: list) -> int:
    """How many people are inside a zone in this frame.

    Group risk is a property of the frame, not of one detection, so it is
    counted once here and handed to every person's score — a lone walker and
    one of five people at the line must not read the same.

    Only counts a detection whose track has survived to a second frame
    (`direction is not None` — TrackHistory.update returns None for a
    track's very first appearance, see tracking/history.py). A one-frame
    YOLO false positive (shadow, reflection, motion blur) would otherwise
    get counted as a person the instant it appears, briefly inflating the
    group count — and therefore G= — for a scene that has no extra person
    in it at all."""
    return sum(
        1 for d in detections
        if d.category() == "person" and d.zone_tier and d.zone_tier != "none"
        and d.direction is not None
    )


def draw_threat_score_overlay(
    frame, det, scorer: ThreatScorer, dwell_seconds: float, group_count: int,
    fps: "float | None" = None,
):
    # Normalize px/frame to what it would be at NOMINAL_KINEMATICS_FPS, so a
    # slow-sampled camera doesn't read an ordinary walk as a sprint (see
    # NOMINAL_KINEMATICS_FPS above). A cold/implausible fps reading falls
    # back to the nominal rate itself (i.e. no rescaling) rather than
    # dividing by a near-zero number.
    effective_fps = fps if (fps and fps > 1.0) else NOMINAL_KINEMATICS_FPS
    # px/frame * fps = px/second (the true, fps-independent speed); dividing
    # that back by the nominal fps re-expresses it as "px/frame if this had
    # been captured at the nominal rate" — the quantity the thresholds are
    # actually calibrated against. Lower effective_fps means each captured
    # frame spans more real time, so the SAME true speed reads as a smaller
    # normalized value here, not a larger one.
    normalized_speed = det.speed * (effective_fps / NOMINAL_KINEMATICS_FPS)

    score = scorer.score(
        zone_tier=det.zone_tier,
        hour=datetime.now().hour,
        speed_px_per_frame=normalized_speed,
        category=det.category(),
        zone_direction=det.zone_direction,
        dwell_seconds=dwell_seconds,
        group_count=group_count,
        # The watchlist escalation used to be applied here, after scoring, which
        # put a scoring rule inside a drawing function and let it bypass the
        # Phase 18 no-zone ceiling. The scorer owns it now, so the override and
        # the ceiling that qualifies it are decided in one place.
        watchlist_match=det.watchlist_match,
        watchlist_similarity=det.watchlist_similarity,
    )

    x1, y1, x2, y2 = det.box
    color = TIER_COLORS[score.tier]
    label = (
        f"T={score.total:.0f} ({score.tier.upper()})  "
        f"S={score.sector_risk:.0f} T={score.time_risk:.0f} "
        f"K={score.kinematics_risk:.0f} C={score.class_confidence:.0f} "
        f"D={score.direction_risk:.0f} L={score.loiter_risk:.0f} G={score.group_risk:.0f}"
    )
    cv2.putText(frame, label, (x1, y2 + 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1)
    if score.override_reason is not None:
        banner = (
            f"FORCED RED: {score.override_reason}"
            if score.tier_ceiling is None
            else f"{score.tier.upper()} (capped): {score.override_reason}"
        )
        cv2.putText(
            frame, banner, (x1, y2 + 32),
            cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1,
        )

    return score


def is_running_alert(score) -> bool:
    """A running person is the clearest anomaly on the feed - see
    ThreatScorer._running_override. Only true when the tier actually landed
    on red - a tier_ceiling can pull an override back down to yellow, and the
    heavy "still running" treatment should agree with the real, possibly-
    capped severity, not the raw override."""
    return (
        score.tier == "red"
        and score.override_reason is not None
        and "running" in score.override_reason
    )


def should_show_running_alert(hold_state: dict, key, running_now: bool, now: float) -> bool:
    """Whether to draw the running zoom-inset THIS frame: either the person
    is running right now, or they were within the last RUNNING_ALERT_HOLD_SECONDS
    (per-track, via `key` - the same dwell_key used for loitering, so it
    survives a ByteTrack id churn the same way). Drawn fresh every frame off
    the raw per-frame override, this used to vanish the instant one frame's
    speed reading dipped back under the sprint threshold - a runner slowing
    mid-stride, or one noisy tracker frame, could flash it for under a
    second. `hold_state` is one camera's dict of key -> last-seen timestamp,
    self-pruning: an expired key is removed here rather than swept separately.
    """
    if running_now:
        hold_state[key] = now
        return True
    last_seen = hold_state.get(key)
    if last_seen is None:
        return False
    if now - last_seen <= RUNNING_ALERT_HOLD_SECONDS:
        return True
    del hold_state[key]
    return False


# Deliberately dark/heavy and visually distinct from the ordinary green/red/
# yellow category and zone boxes, so a running person reads as "different"
# at a glance instead of blending into the usual overlay clutter.
RUNNING_ALERT_BORDER_COLOR = (12, 12, 12)  # near-black
RUNNING_ALERT_TEXT_COLOR = (0, 0, 255)     # red, for contrast against the dark border
RUNNING_ALERT_PAD = 12
RUNNING_ALERT_THICKNESS = 7
RUNNING_ALERT_ZOOM_SIZE = 220  # px, square inset in the frame corner


def _draw_running_high_alert(frame, box, slot: int = 0) -> None:
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = box

    # Padded, heavy dark border around the person - bigger and darker than
    # the ordinary per-category box.
    bx1, by1 = max(0, x1 - RUNNING_ALERT_PAD), max(0, y1 - RUNNING_ALERT_PAD)
    bx2, by2 = min(w - 1, x2 + RUNNING_ALERT_PAD), min(h - 1, y2 + RUNNING_ALERT_PAD)
    if bx2 <= bx1 or by2 <= by1:
        return
    cv2.rectangle(frame, (bx1, by1), (bx2, by2), RUNNING_ALERT_BORDER_COLOR, RUNNING_ALERT_THICKNESS)
    banner_y = by1 - 14 if by1 - 14 > 18 else by2 + 46
    cv2.putText(
        frame, "HIGH ALERT: RUNNING", (bx1, banner_y),
        cv2.FONT_HERSHEY_SIMPLEX, 0.7, RUNNING_ALERT_TEXT_COLOR, 2,
    )

    # Zoomed inset of the person, pasted top-right (stacked downward per
    # slot when more than one person is running in the same frame) - an
    # operator watching the wide shot sees the runner up close without
    # switching views. Aspect ratio is preserved and letterboxed onto a
    # dark square rather than stretched, so the crop still looks like them.
    crop = frame[by1:by2, bx1:bx2]
    if crop.size == 0:
        return
    crop_h, crop_w = crop.shape[:2]
    scale = RUNNING_ALERT_ZOOM_SIZE / max(crop_h, crop_w)
    resized = cv2.resize(
        crop, (max(1, int(crop_w * scale)), max(1, int(crop_h * scale))),
        interpolation=cv2.INTER_LINEAR,
    )
    inset = np.full((RUNNING_ALERT_ZOOM_SIZE, RUNNING_ALERT_ZOOM_SIZE, 3), RUNNING_ALERT_BORDER_COLOR, dtype=frame.dtype)
    rh, rw = resized.shape[:2]
    off_y, off_x = (RUNNING_ALERT_ZOOM_SIZE - rh) // 2, (RUNNING_ALERT_ZOOM_SIZE - rw) // 2
    inset[off_y:off_y + rh, off_x:off_x + rw] = resized

    ix1 = w - RUNNING_ALERT_ZOOM_SIZE - 10
    iy1 = 10 + slot * (RUNNING_ALERT_ZOOM_SIZE + 34)
    ix2, iy2 = ix1 + RUNNING_ALERT_ZOOM_SIZE, iy1 + RUNNING_ALERT_ZOOM_SIZE
    if ix1 < 0 or iy2 > h:
        return  # frame too small, or too many stacked insets - skip rather than corrupt the frame
    frame[iy1:iy2, ix1:ix2] = inset
    cv2.rectangle(frame, (ix1, iy1), (ix2, iy2), RUNNING_ALERT_BORDER_COLOR, RUNNING_ALERT_THICKNESS)
    cv2.putText(
        frame, "HIGH ALERT", (ix1, iy2 + 20),
        cv2.FONT_HERSHEY_SIMPLEX, 0.6, RUNNING_ALERT_TEXT_COLOR, 2,
    )


def main() -> None:
    log.info("IBVAP starting up")
    validator = StartupValidator()
    if not validator.print_summary():
        log.error("Critical startup checks failed - aborting")
        sys.exit(1)

    # A second instance can't open a webcam the first one already holds - it
    # just retries forever and the dashboard shows that camera stuck on
    # "Connecting to camera..." with no explanation why. Refuse up front
    # instead, since the running PID is right there in the health file.
    existing = read_health()
    if existing and existing.get("running") and existing.get("pid") != os.getpid():
        log.error(
            "Another IBVAP pipeline is already running (pid %s, last heartbeat %.1fs ago) "
            "and holds the camera(s) - stop it first (kill %s) before starting a new one.",
            existing.get("pid"), existing.get("ageSeconds", 0), existing.get("pid"),
        )
        sys.exit(1)

    if os.getenv("DEMO_MODE", "false").strip().lower() in ("true", "1", "yes"):
        log.info("DEMO_MODE=true active: running deterministic 15-step demonstration")
        demo = get_demo_engine()
        demo.run_all(delay_seconds=0.1)
        log.info("Demo complete. Live incident recorded: #%s", demo.current_incident_id)
        return

    window_names = {name: f"IBVAP - {name} (press q to quit)" for name in CAMERA_SOURCES}
    for window_name in window_names.values():
        cv2.namedWindow(window_name)

    manager = StreamManager(CAMERA_SOURCES, width=CAMERA_WIDTH, height=CAMERA_HEIGHT)
    manager.start_all()
    preprocessors = {
        name: Preprocessor(name, brightness_threshold=BRIGHTNESS_THRESHOLD)
        for name in CAMERA_SOURCES
    }
    gates = {name: ActivityGate(motion_threshold=MOTION_THRESHOLD) for name in CAMERA_SOURCES}
    frame_counters = {name: 0 for name in CAMERA_SOURCES}
    trackers = {
        name: Tracker(model_path=DETECTION_MODEL_PATH, confidence=DETECTION_CONFIDENCE)
        for name in CAMERA_SOURCES
    }
    false_alarm_filters = {name: FalseAlarmFilter() for name in CAMERA_SOURCES}
    embedder = OSNetEmbedder(REID_MODEL_PATH)
    person_gallery = PersonGallery(
        embed_fn=embedder.embed,
        similarity_threshold=REID_SIMILARITY_THRESHOLD,
        ttl_seconds=REID_TTL_SECONDS,
        match_margin=REID_MATCH_MARGIN,
    )

    def _zones_file(cam_name):
        p1 = f"config/zones/{cam_name}.json"
        return p1 if os.path.exists(p1) else f"config/zones_{cam_name}.json"

    zone_engines = {
        name: ZoneEngine(
            config_path=_zones_file(name),
            curfew_start_hour=CURFEW_START_HOUR,
            curfew_end_hour=CURFEW_END_HOUR,
            fixed_tier=CAMERA_ZONE_TIERS.get(name),
        )
        for name in CAMERA_SOURCES
    }
    zone_drawers = {
        name: ZoneDrawer(window_names[name], zone_engines[name]) for name in CAMERA_SOURCES
    }
    # Boundaries are display-only here (see camera_state["boundaryEvents"]
    # below) - detected independently of zone entry, never fed into scoring.
    boundary_engines = {
        name: BoundaryEngine(config_path=f"config/boundaries_{name}.json")
        for name in CAMERA_SOURCES
    }

    loiter_trackers = {name: LoiterTracker() for name in CAMERA_SOURCES}

    for name in CAMERA_SOURCES:
        if zone_engines[name].fixed_tier is None:
            log.warning(
                "[%s] No fixed_tier assigned via CAMERA_ZONE_TIERS. "
                "Defaulting to 'green' (interior) behavior.", name
            )
    face_recognizer = FaceRecognizer()
    watchlist_db = WatchlistDB()
    watchlist_matcher = WatchlistMatcher(watchlist_db, similarity_threshold=WATCHLIST_SIMILARITY_THRESHOLD)
    threat_rules = ThreatRulesDB()
    threat_scorer = ThreatScorer(threat_rules)
    incident_store = IncidentStore()
    webhook = WebhookNotifier(url=WEBHOOK_URL)
    syslog = SyslogNotifier(host=SYSLOG_HOST, port=SYSLOG_PORT)
    # Webhook POSTs and evidence persistence run on this bounded background
    # worker so a slow/unreachable C2 host or disk cannot stall the camera loop.
    alert_dispatcher = AlertDispatcher(maxsize=ALERT_DISPATCH_QUEUE_SIZE)
    alert_manager = AlertManager(
        cooldown_seconds=ALERT_COOLDOWN_SECONDS,
        confirm_seconds=ALERT_CONFIRM_SECONDS,
        confirm_fraction=ALERT_CONFIRM_FRACTION,
        max_cooldown_seconds=ALERT_MAX_COOLDOWN_SECONDS,
        incident_store=incident_store,
        webhook=webhook,
        syslog=syslog,
        dispatcher=alert_dispatcher,
        watchlist_db=watchlist_db,
    )
    # Seconds between full pipeline passes while a scene is idle. Guard against
    # a zero/negative setting turning the floor into a division error.
    idle_min_period = 1.0 / IDLE_MIN_FPS if IDLE_MIN_FPS > 0 else 0.0

    # Inert unless IBVAP_PROFILE=1 — stage() then returns a shared no-op, so an
    # unprofiled run does the same work it always did.
    profiler = StageProfiler()
    if profiler.enabled:
        log.info("Stage profiling ENABLED — report prints on exit (q)")

    frame_buffers = {name: deque(maxlen=3) for name in CAMERA_SOURCES}
    last_frame_time = {name: None for name in CAMERA_SOURCES}
    fps_ema = {name: 0.0 for name in CAMERA_SOURCES}
    # Displayed max-tier hold: (tier, expires_at) per camera. See
    # MAX_TIER_HOLD_SECONDS - this is the dashboard's live status, separate
    # from AlertManager's own (already debounced) incident-recording tier.
    tier_hold: dict[str, tuple[str, float]] = {}
    TIER_RANK = {None: -1, "green": 0, "yellow": 1, "red": 2}
    # Per-camera caches so a throttled (skipped) frame still shows the last
    # known identity/watchlist result instead of blanking it out.
    person_id_cache = {name: {} for name in CAMERA_SOURCES}
    watchlist_cache = {name: {} for name in CAMERA_SOURCES}
    # Per-camera, per-track "last seen running" timestamps backing the
    # running zoom-inset's hold window - see should_show_running_alert.
    running_alert_hold = {name: {} for name in CAMERA_SOURCES}

    isolator = CameraErrorIsolator()
    last_health: dict[str, str] = {}

    # Live frames and health for the dashboard (integration/runtime_state.py).
    # The dashboard reads these instead of opening the camera itself, so the
    # operator sees exactly what the model sees while it keeps alerting.
    publisher = PipelinePublisher()
    camera_state = {name: {} for name in CAMERA_SOURCES}
    last_health_publish = 0.0
    models_info = {
        "detector": DETECTION_MODEL_PATH,
        "reid": REID_MODEL_PATH,
        "face": "insightface/buffalo_s",
        "profile": HARDWARE_PROFILE,
        "providers": ", ".join(select_providers()),
    }

    def process_camera_frame(name: str, frame) -> None:
        """The full per-camera pipeline for one frame.

        Runs behind `isolator` below, so anything raised in here costs this
        one frame on this one camera instead of the whole loop.

        The body is the full pipeline — profiler stages, the IDLE_MIN_FPS
        floor, the Re-ID/face check throttle, loiter dwell and group count.
        Where the loop used `continue` to skip the rest of a frame, this
        returns instead.
        """
        with profiler.stage("activity_gate"):
            active, motion_score = gates[name].is_active(frame)
        frame_counters[name] += 1
        camera_state[name]["active"] = bool(active)
        camera_state[name]["motion"] = round(float(motion_score), 2)

        # High activity: run the full pipeline every frame.
        # Idle: hold a floor of IDLE_MIN_FPS full passes per second, so
        # a still scene still updates the window and keeps tracks alive.
        # Timed off the last processed frame rather than a frame count,
        # because a count makes the idle rate a function of the camera's
        # own fps — two cameras at different rates idled at different
        # speeds from one setting.
        now = time.perf_counter()
        last_processed = last_frame_time[name]
        due = last_processed is None or (now - last_processed) >= idle_min_period
        if not (active or due):
            # Was `continue` when this body lived inside the camera loop;
            # inside process_camera_frame the equivalent is returning, which
            # skips the rest of this frame's pipeline exactly as before.
            return

        if last_processed is not None:
            instant_fps = 1.0 / max(now - last_processed, 1e-6)
            fps_ema[name] = (0.9 * fps_ema[name]) + (0.1 * instant_fps)
        last_frame_time[name] = now

        preprocessor = preprocessors[name]
        with profiler.stage("preprocess"):
            processed = preprocessor.process(frame)

        with profiler.stage("detect_track"):
            detections = trackers[name].track(processed)
        with profiler.stage("false_alarm_filter"):
            detections = false_alarm_filters[name].filter(detections)
        # Reset once per frame (not accumulated across frames) so this
        # reflects what's crossing right now, not an ever-growing log -
        # camera_state is republished every frame regardless.
        camera_state[name]["boundaryEvents"] = []
        for det in detections:
            if det.track_id is not None and det.category() == "person":
                track_id = det.track_id
                # A brand-new track is checked every frame (Re-ID
                # needs consecutive samples to decide an identity at
                # all — resolve() returns None while still buffering,
                # so check *value*, not key presence, or a track
                # stuck buffering would get throttled before it ever
                # resolves); once resolved, re-checking every Nth
                # frame is enough — appearance doesn't change frame-to-frame.
                already_resolved = person_id_cache[name].get(track_id) is not None
                due_for_check = frame_counters[name] % REID_FACE_CHECK_INTERVAL == 0
                if not already_resolved or due_for_check:
                    with profiler.stage("reid_resolve"):
                        det.person_id = person_gallery.resolve(
                            (name, track_id), processed, det.box
                        )
                    person_id_cache[name][track_id] = det.person_id
                else:
                    det.person_id = person_id_cache[name][track_id]

                if not already_resolved or due_for_check:
                    with profiler.stage("face_embed"):
                        _face_box, embedding = face_recognizer.embed(processed, det.box)
                    if embedding is not None:
                        with profiler.stage("watchlist_match"):
                            match_name, similarity = watchlist_matcher.match(embedding)
                        prev_match, prev_similarity = watchlist_cache[name].get(
                            track_id, (None, 0.0)
                        )
                        # Keep the best match ever seen for this track. A face
                        # is only re-checked every REID_FACE_CHECK_INTERVAL
                        # frames, and a single later check catching a worse
                        # angle/lighting moment must not erase a genuine match
                        # found earlier — that silently dropped real matches
                        # the pipeline had already made.
                        if prev_match is None or (
                            match_name is not None and similarity > prev_similarity
                        ):
                            watchlist_cache[name][track_id] = (match_name, similarity)
                cached_match, cached_similarity = watchlist_cache[name].get(
                    track_id, (None, 0.0)
                )
                det.watchlist_match = cached_match
                det.watchlist_similarity = cached_similarity

            det.camera_name = name
            x1, y1, x2, y2 = det.box
            ground_point = ((x1 + x2) // 2, y2)
            with profiler.stage("zone_classify"):
                zone_result = zone_engines[name].classify(ground_point, det.direction)
            det.zone_tier = zone_result["tier"]
            det.zone_direction = zone_result["direction"]

            # Boundary crossings are a separate signal from zone entry above:
            # detected and surfaced for the dashboard only, not fed into
            # scores/detections/incidents (see zones/boundary_engine.py).
            with profiler.stage("boundary_check"):
                crossings = boundary_engines[name].check_crossing(det.track_id, ground_point)
            if crossings:
                camera_state[name]["boundaryEvents"].extend(crossings)

        draw_detections(processed, detections)

        group_count = zone_group_count(detections)
        scores = []
        running_alert_slot = 0
        for det in detections:
            # Dwell is keyed on the Re-ID person_id where we have one,
            # so standing still behind cover — which makes ByteTrack
            # churn the track_id — doesn't keep resetting the clock.
            dwell_key = (
                ("person", det.person_id) if det.person_id is not None
                else ("track", det.track_id)
            )
            dwell = loiter_trackers[name].update(dwell_key, det.zone_tier)
            score = draw_threat_score_overlay(
                processed, det, threat_scorer, dwell, group_count, fps=fps_ema[name],
            )
            if should_show_running_alert(
                running_alert_hold[name], dwell_key, is_running_alert(score), now
            ):
                _draw_running_high_alert(processed, det.box, running_alert_slot)
                # Next runner in this frame (if any) gets its own zoom inset
                # stacked below this one instead of drawing on top of it.
                running_alert_slot += 1
            scores.append(score)

        with profiler.stage("draw_overlays"):
            draw_debug_overlay(processed, preprocessor, active, motion_score)
            draw_fps_overlay(processed, fps_ema[name])
            zone_drawers[name].draw_overlay(processed)


        with profiler.stage("publish_live"):
            publisher.publish_frame(name, processed)
        tiers = [s.tier for s in scores]
        raw_tier = "red" if "red" in tiers else "yellow" if "yellow" in tiers else "green" if tiers else None

        # Hold the displayed tier at its highest recent value for
        # MAX_TIER_HOLD_SECONDS instead of reporting the raw per-frame value,
        # which flickers yellow/red for a single frame at a time whenever a
        # score sits near a tier boundary. Rising immediately, decaying slowly.
        now_ts = time.time()
        held_tier, held_until = tier_hold.get(name, (None, 0.0))
        if TIER_RANK[raw_tier] >= TIER_RANK[held_tier] or now_ts >= held_until:
            tier_hold[name] = (raw_tier, now_ts + MAX_TIER_HOLD_SECONDS)
            displayed_tier = raw_tier
        else:
            displayed_tier = held_tier

        camera_state[name].update(
            lastFrameAt=time.time(),
            fps=round(fps_ema[name], 1),
            detections=len(detections),
            persons=sum(1 for d in detections if d.category() == "person"),
            vehicles=sum(1 for d in detections if d.category() == "vehicle"),
            maxTier=displayed_tier,
            lowLightBoost=bool(preprocessor.last_boost_applied),
            brightness=round(float(preprocessor.last_brightness), 1),
        )

        with profiler.stage("frame_buffer_copy"):
            frame_buffers[name].append(processed.copy())
        with profiler.stage("alert_handle"):
            for det, score in zip(detections, scores):
                alert_manager.handle(det, score, list(frame_buffers[name]))

        with profiler.stage("display"):
            cv2.imshow(window_names[name], processed)
        profiler.frame_done()

    try:
        while True:
            health = manager.health()
            if health != last_health:
                degraded = {n: s for n, s in health.items() if s != CameraHealth.ONLINE}
                if degraded:
                    log.warning("Camera health changed — degraded: %s (all: %s)", degraded, health)
                else:
                    log.info("Camera health changed — all cameras ONLINE")
                last_health = health

            now_wall = time.time()
            if now_wall - last_health_publish >= 1.0:
                last_health_publish = now_wall
                publisher.publish_health({
                    "cameras": {
                        name: {
                            "health": health.get(name),
                            **camera_state[name],
                        }
                        for name in CAMERA_SOURCES
                    },
                    "models": models_info,
                    "alertDispatchQueue": ALERT_DISPATCH_QUEUE_SIZE,
                })

            frames = manager.read_all()
            for name, frame in frames.items():
                if frame is None:
                    continue
                # Per-camera failure boundary: a pipeline exception on one
                # camera drops that frame, is logged with the camera id and a
                # traceback, and leaves every other camera still processing.
                isolator.run(
                    name, process_camera_frame, name, frame, stage="frame-pipeline"
                )

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break

    finally:
        report = profiler.report()
        if report:
            print(report)
        publisher.close()
        manager.stop_all()
        # Drain queued webhook/evidence work before closing the stores it uses.
        alert_dispatcher.stop()
        threat_rules.close()
        incident_store.close()
        watchlist_db.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    cli_sources = cli_camera_sources(sys.argv[1:])
    if cli_sources is not None:
        CAMERA_SOURCES = cli_sources
        log.info("Using camera source(s) from command line: %s", CAMERA_SOURCES)
    main()
