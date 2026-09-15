import logging
import os

from dotenv import load_dotenv

load_dotenv()

# --- Hardware profile ------------------------------------------------------
# One switch for the four settings that decide whether the pipeline keeps up
# on a weak box. "standard" is the Apple-M4 tuning every earlier phase was
# measured on; "low" is Phase 26's Intel-i3/i5-with-no-GPU tuning, measured
# CPU-only with scripts/bench_pipeline.py --cpu-only (16.1 -> 33.8 fps, 220%
# -> 96% of one core) and scripts/accuracy_eval.py --replay (no precision or
# recall loss on the reviewed frames). A value set explicitly in the
# environment still wins, so the profile never overrides a deliberate choice.
HARDWARE_PROFILES = {
    "standard": {
        "DETECTION_MODEL_PATH": "models/yolov8s.onnx",
        "ORT_NUM_THREADS": "2",
        "REID_FACE_CHECK_INTERVAL": "5",
        "IDLE_MIN_FPS": "20",
    },
    "low": {
        "DETECTION_MODEL_PATH": "models/yolov8n_416.onnx",
        "ORT_NUM_THREADS": "1",
        "REID_FACE_CHECK_INTERVAL": "10",
        "IDLE_MIN_FPS": "5",
    },
}
HARDWARE_PROFILE = (os.getenv("HARDWARE_PROFILE") or "standard").strip().lower()
if HARDWARE_PROFILE not in HARDWARE_PROFILES:
    logging.getLogger("ibvap").warning(
        "HARDWARE_PROFILE=%r is not one of %s - using 'standard'",
        HARDWARE_PROFILE, sorted(HARDWARE_PROFILES),
    )
    HARDWARE_PROFILE = "standard"


def _profiled(name: str) -> str:
    return os.getenv(name) or HARDWARE_PROFILES[HARDWARE_PROFILE][name]


# --- ONNX Runtime thread limits --------------------------------------------
# MUST be set before onnxruntime is imported, which is why it lives here: both
# app.py and scripts/bench_pipeline.py import config.settings before any module
# that pulls in ORT (face/, reid/, tracking/).
#
# The pipeline runs three independent ORT sessions per frame — YOLO, OSNet
# Re-ID, InsightFace. Left to itself each one sizes its intra-op pool to the
# whole machine (10 cores here), so three sessions oversubscribe the CPU and
# spend their time contending rather than computing. Measured over 3 passes of
# scripts/bench_pipeline.py on this machine, running the three interleaved:
#
#   threads   ms/frame   fps    CPU (100% = 1 core)
#   default      41.6    24.0        696%
#   2            25.5    39.3        362%      <- chosen
#   1            31.7    31.6        101%
#
# 2 is the latency optimum. Set ORT_NUM_THREADS=1 instead on a machine that has
# to share its CPU with other work: 24% slower than 2, but a seventh of the CPU
# and still faster than the unbounded default. 0 restores ORT's own choice.
ORT_NUM_THREADS = int(_profiled("ORT_NUM_THREADS"))
if ORT_NUM_THREADS > 0:
    for _var in (
        "OMP_NUM_THREADS", "ORT_INTRA_OP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    ):
        os.environ.setdefault(_var, str(ORT_NUM_THREADS))

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

# Comma-separated name=source pairs, e.g. "cam0=0,cam1=rtsp://user:pass@host/stream"
def _parse_camera_sources(raw: str) -> dict[str, int | str]:
    sources: dict[str, int | str] = {}
    for pair in raw.split(","):
        name, _, value = pair.partition("=")
        name = name.strip()
        value = value.strip()
        if not name:
            continue
        sources[name] = int(value) if value.isdigit() else value
    return sources


CAMERA_SOURCES: dict[str, int | str] = _parse_camera_sources(
    os.getenv("CAMERA_SOURCES", "cam0=0")
)

# Comma-separated name=tier pairs, e.g. "cam0=red,cam1=yellow,cam2=green".
# A camera physically mounted at one point along the border sees one tier for
# its whole frame - there is no sub-region to draw. Naming it here skips
# ZoneEngine's polygon classification entirely for that camera (see
# ZoneEngine.__init__'s fixed_tier argument): every detection from it just
# inherits the assigned tier, and direction is read from raw on-screen motion
# instead of a vector toward another zone's centroid. A camera not listed
# here is unaffected and keeps using its drawn config/zones_<camera>.json.
def _parse_camera_zone_tiers(raw: str) -> dict[str, str]:
    tiers: dict[str, str] = {}
    for pair in raw.split(","):
        name, _, value = pair.partition("=")
        name = name.strip()
        value = value.strip().lower()
        if not name or not value:
            continue
        if value not in ("red", "yellow", "green"):
            logging.getLogger("ibvap").warning(
                "CAMERA_ZONE_TIERS: ignoring %s=%s - tier must be red, yellow or green",
                name, value,
            )
            continue
        tiers[name] = value
    return tiers


CAMERA_ZONE_TIERS: dict[str, str] = _parse_camera_zone_tiers(
    os.getenv("CAMERA_ZONE_TIERS", "")
)

# 0-255 scale; frames measured below this trigger a CLAHE + gamma low-light boost
BRIGHTNESS_THRESHOLD = float(os.getenv("BRIGHTNESS_THRESHOLD", "90"))

# Mean grayscale frame-diff above this counts as "activity detected"
MOTION_THRESHOLD = float(os.getenv("MOTION_THRESHOLD", "2.0"))

# When idle, run the full pipeline at (at least) this many frames per second —
# a keep-alive floor, not a cap: as soon as the activity gate sees motion, every
# frame is processed again. This was a frame-count divisor ("every Nth frame"),
# which made the idle rate depend on the camera: the same divisor of 10 gave
# 3 fps on a 30 fps webcam and 1.5 fps on a 15 fps one. A rate in fps is what
# an operator actually wants to specify, and it holds across mismatched cameras.
IDLE_MIN_FPS = float(_profiled("IDLE_MIN_FPS"))

# Minimum YOLO confidence to keep a detection
DETECTION_CONFIDENCE = float(os.getenv("DETECTION_CONFIDENCE", "0.5"))

# Path to the model file the detector loads (.pt, .onnx, or an int8 .onnx)
DETECTION_MODEL_PATH = _profiled("DETECTION_MODEL_PATH")

# Requested camera capture resolution. Cameras often default to a much higher
# resolution (e.g. 1080p) which inflates every downstream stage for no benefit.
CAMERA_WIDTH = int(os.getenv("CAMERA_WIDTH", "640"))
CAMERA_HEIGHT = int(os.getenv("CAMERA_HEIGHT", "480"))

# Re-ID: cosine similarity (0-1) above which a reappearing track is matched
# back to an existing person instead of being treated as a new one
# Measured on real pedestrian crops with the OSNet embedder: unrelated people
# score at most ~0.50, the same person under box jitter at least ~0.87. 0.70
# sits in the middle of that gap. (It was also 0.70 under the old ImageNet
# ResNet-18, but there unrelated people reached 0.795 — above the gate — which
# is what merged strangers onto one person_id.)
REID_SIMILARITY_THRESHOLD = float(os.getenv("REID_SIMILARITY_THRESHOLD", "0.70"))

# Re-ID: how far the best-matching person must beat the second-best before the
# match is trusted. Near-tied candidates mean the embedding isn't actually
# telling those people apart, so the gallery mints a new id rather than guess.
REID_MATCH_MARGIN = float(os.getenv("REID_MATCH_MARGIN", "0.05"))

# Person Re-ID appearance model (OSNet x0.25 / MSMT17). Bundled in models/ and
# never fetched at runtime, so air-gapped operation still works.
REID_MODEL_PATH = os.getenv("REID_MODEL_PATH", "models/osnet_x0_25_msmt17.onnx")

# Re-ID: how long (seconds) a disappeared person stays eligible for matching
REID_TTL_SECONDS = float(os.getenv("REID_TTL_SECONDS", "30"))

# Green zones are re-tiered to "yellow" during this hour window (wraps midnight)
CURFEW_START_HOUR = int(os.getenv("CURFEW_START_HOUR", "23"))
CURFEW_END_HOUR = int(os.getenv("CURFEW_END_HOUR", "5"))

# --- threat model selection -------------------------------------------------
# "tiered"    — the 7-component sector/time/kinematics/class/direction/loiter/
#               group score in intelligence/threat_score.py (default; unchanged)
# "kinematic" — the continuous predictive model in intelligence/kinematic_score.py
# Both emit a 0-100 score on the same Green/Yellow/Red boundaries, so alerting,
# the incident DB and the dashboard work identically either way.
SCORING_MODEL = os.getenv("SCORING_MODEL", "tiered").strip().lower()

# --- predictive kinematic model ---------------------------------------------
#   S = (alpha*exp(-lambda*d) + beta*max(0, 1/(TTB+eps)) + gamma*ln(1+L_t))
#       * W_class * C_det
# Budget, so the 0-100 scale stays legible: proximity 45 at the line, TTB up to
# 25 at the moment of breach, loiter ~28 after five minutes. A vehicle at the
# line with a short TTB therefore saturates, while a confident person merely
# nearby lands mid-yellow.
KINEMATIC_ALPHA = float(os.getenv("KINEMATIC_ALPHA", "45"))
# Decay per pixel. 0.010 puts the half-way point near 69px and ~2 points left at
# 300px. Retune per camera: pixels-per-metre depends on lens and mounting, so a
# wide field of view wants a smaller lambda.
KINEMATIC_LAMBDA = float(os.getenv("KINEMATIC_LAMBDA", "0.010"))
KINEMATIC_BETA = float(os.getenv("KINEMATIC_BETA", "25"))
KINEMATIC_GAMMA = float(os.getenv("KINEMATIC_GAMMA", "5"))
# Guards the division and caps the TTB term at beta/epsilon as TTB -> 0.
KINEMATIC_EPSILON = float(os.getenv("KINEMATIC_EPSILON", "1.0"))
# W_class. Animals are damped hard for the same reason the tiered model exempts
# them from the crossing override: livestock cross constantly, and a system that
# screams at every cow gets switched off.
KINEMATIC_W_VEHICLE = float(os.getenv("KINEMATIC_W_VEHICLE", "1.5"))
KINEMATIC_W_PERSON = float(os.getenv("KINEMATIC_W_PERSON", "1.0"))
KINEMATIC_W_ANIMAL = float(os.getenv("KINEMATIC_W_ANIMAL", "0.4"))
# Frame rate assumed when the measured FPS is still cold or implausible; TTB is
# in seconds, so it needs a px/frame -> px/second conversion.
KINEMATIC_NOMINAL_FPS = float(os.getenv("KINEMATIC_NOMINAL_FPS", "20"))

# Seconds between repeat alerts for the same track at the same tier
ALERT_COOLDOWN_SECONDS = float(os.getenv("ALERT_COOLDOWN_SECONDS", "8"))
# Bounded queue for off-thread alert side effects (webhook + evidence).
ALERT_DISPATCH_QUEUE_SIZE = int(os.getenv("ALERT_DISPATCH_QUEUE_SIZE", "64"))

# Phase 18 (alert discipline): a tier must be observed for at least this many
# REAL SECONDS (not scoring cycles - at 15-30fps a handful of frames is well
# under a second) before it can raise an alert, and is only released once it
# has sat continuously below that tier for the same duration. This is what
# stops a score oscillating around a threshold - or a person merely passing
# through a zone for an instant - from buying a free siren.
ALERT_CONFIRM_SECONDS = float(os.getenv("ALERT_CONFIRM_SECONDS", "1.5"))
# Fraction of the confirm-window's observations that must sit at or above a
# candidate tier for it to confirm - 0.5 means "elevated at least half the
# time over ALERT_CONFIRM_SECONDS", so a genuinely borderline/flapping signal
# still confirms once instead of being read as "never sustained".
ALERT_CONFIRM_FRACTION = float(os.getenv("ALERT_CONFIRM_FRACTION", "0.5"))

# Repeat alerts for a track parked at the same tier back off 8s -> 16s -> 32s,
# stopping at this ceiling, so a sustained presence is reported and then quiet.
ALERT_MAX_COOLDOWN_SECONDS = float(os.getenv("ALERT_MAX_COOLDOWN_SECONDS", "64"))

# The ALERT_CONFIRM_* / cooldown settings above only govern when an incident
# is *recorded*. The per-camera status shown live on the dashboard (the
# camera tile badge, the Normal/Under Watch/Critical counts, "Selected
# Camera") is a separate number — the raw max tier across this frame's
# detections, recomputed every frame with none of that smoothing. A track
# hovering at a tier boundary flickers that status yellow/red for a single
# frame at a time even when no incident is ever recorded for it. This holds
# the *displayed* tier at its highest recent value for this many seconds
# before letting it decay, so an operator has time to actually see it.
MAX_TIER_HOLD_SECONDS = float(os.getenv("MAX_TIER_HOLD_SECONDS", "6"))

# Cosine similarity (0-1) above which a face is treated as a watchlist match.
# 0.5 was matching almost any face against a stored embedding (observed hits
# as low as 0.51-0.55 against an unrelated person) - raised to cut false
# positives while still catching a genuine match, which typically scores well
# above 0.7 with InsightFace embeddings.
WATCHLIST_SIMILARITY_THRESHOLD = float(os.getenv("WATCHLIST_SIMILARITY_THRESHOLD", "0.7"))

# Outbound webhook URL for alert events (empty = disabled)
WEBHOOK_URL = os.getenv("WEBHOOK_URL", "")

# Syslog target for alert events (UDP; fire-and-forget, safe if unreachable)
# Bearer token guarding the integration REST API (integration/api.py). Unset
# means the API refuses every request rather than serving the incident feed
# openly: this endpoint exposes person/vehicle sightings with timestamps, so
# failing closed is the only safe default on an unset value.
IBVAP_API_TOKEN = os.getenv("IBVAP_API_TOKEN", "").strip()

# Browser origins allowed to call the /api/v1 dashboard routes. The React app
# in frontend/ runs on Vite's :5173 while this API serves :8000, so the
# defaults cover local development. An explicit allowlist, never "*" — these
# routes carry a bearer token, and a wildcard would let any page the operator
# has open read the incident feed. Set to the real dashboard origin on deploy.
# Set to 1 to also accept dashboard origins from private LAN addresses, so a
# phone or a second laptop on the same network can open the dashboard. Off by
# default: it widens who may call the API from a browser. The bearer token is
# still required either way, and this never permits public addresses.
IBVAP_ALLOW_LAN = os.getenv("IBVAP_ALLOW_LAN", "0").strip() in ("1", "true", "yes")

IBVAP_CORS_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "IBVAP_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if o.strip()
]

SYSLOG_HOST = os.getenv("SYSLOG_HOST", "localhost")
SYSLOG_PORT = int(os.getenv("SYSLOG_PORT", "514"))

# Re-run Re-ID embedding + face/watchlist recognition for an already-resolved
# track only every Nth frame, not every frame. Measured cost: ~7.6ms (Re-ID)
# + ~6.4ms (face) per person per frame — real, avoidable weight once an
# identity is already known, since appearance barely changes frame-to-frame.
# A brand-new (not-yet-resolved) track is never throttled by this — it still
# gets checked every frame, since PersonGallery needs consecutive samples to
# decide an identity in the first place.
REID_FACE_CHECK_INTERVAL = int(_profiled("REID_FACE_CHECK_INTERVAL"))

# Fernet key protecting watchlist face embeddings at rest (face/watchlist.py).
# Same mechanism as the evidence store; kept in its own file so biometric data
# and evidence data do not share one key. The file is gitignored and created
# on first use — an existing watchlist.db written before encryption still
# reads, because _decrypt_embedding falls back to plain JSON.
WATCHLIST_KEY_PATH = os.getenv("WATCHLIST_KEY_PATH", "database/watchlist.key")

# API_TOKEN is the name main used for the same environment variable that
# IBVAP_API_TOKEN above already reads. Aliased rather than duplicated so the
# two can never drift to different values.
API_TOKEN = IBVAP_API_TOKEN


def configure_logging() -> None:
    logging.basicConfig(
        level=LOG_LEVEL,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
