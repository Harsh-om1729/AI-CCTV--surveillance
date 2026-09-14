"""Phase 16 — lightweight REST endpoint exposing the incident feed as JSON,
so any C2/SIEM system a deploying force already runs can poll this platform
without needing to know its internals (ONNX/ByteTrack/etc. stay invisible).

Access requires a bearer token (Phase 0B, item 2). The incident feed carries
operational surveillance data, so it is not served to unauthenticated callers.
Set the token in the environment before starting the service:

    IBVAP_API_TOKEN=<a long random secret>

Run from ibvap/: uvicorn integration.api:app --port 8000
Then:           curl -H "Authorization: Bearer $IBVAP_API_TOKEN" \
                     http://localhost:8000/incidents

Authentication (Phase 17): every endpoint requires the bearer token in
IBVAP_API_TOKEN. With the token unset the API refuses everything rather than
serving openly — this feed lists person and vehicle sightings with
timestamps and zones, so failing closed is the only safe default. Generate
one with: python -c "import secrets; print(secrets.token_urlsafe(32))"

Phase 19 — the /api/v1 surface backing the React dashboard in frontend/.
Two route families share this app deliberately:

  /status, /incidents        legacy flat feed. External C2/SIEM pollers are
                             already pointed at these paths, so their shape
                             is frozen — snake_case, as first shipped.
  /api/v1/...                the browser dashboard. camelCase, because that
                             is the contract frontend/src/lib/api/ was
                             written against.

Serialising twice is cheaper than breaking either consumer.
"""

import asyncio
import hmac
import json
import logging
import os
import re
import shutil
import sqlite3
import threading
import time
from datetime import datetime

from fastapi import (
    APIRouter,
    Body,
    Depends,
    FastAPI,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from config.settings import (
    ALERT_COOLDOWN_SECONDS,
    IBVAP_ALLOW_LAN,
    BRIGHTNESS_THRESHOLD,
    CAMERA_HEIGHT,
    CAMERA_SOURCES,
    CAMERA_WIDTH,
    CURFEW_END_HOUR,
    CURFEW_START_HOUR,
    DETECTION_CONFIDENCE,
    DETECTION_MODEL_PATH,
    IBVAP_API_TOKEN,
    IBVAP_CORS_ORIGINS,
    IDLE_MIN_FPS,
    MOTION_THRESHOLD,
    REID_MODEL_PATH,
    REID_SIMILARITY_THRESHOLD,
    SYSLOG_HOST,
    SYSLOG_PORT,
    WATCHLIST_SIMILARITY_THRESHOLD,
    WEBHOOK_URL,
    configure_logging,
)
import os
os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "rtsp_transport;tcp|timeout;5000000|stimeout;5000000",
)
import cv2
from cryptography.fernet import InvalidToken

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from config.settings import API_TOKEN
from database.incident_store import RESOLUTION_REASONS, IncidentStore
from integration import runtime_state
from integration.live_stream import CameraBusyError, LiveCameraRegistry
from intelligence.threat_score import GREEN_MAX, YELLOW_MAX, ZONE_TIER_THRESHOLDS
from zones.boundary_engine import Boundary, BoundaryEngine
from zones.zone_policy import VALID_TIERS, ZONE_ROLES, ZonePolicy

# Without this the API process emits no ibvap.* logs at all, so camera
# open/release, detector readiness and per-frame detector faults all happen
# silently — the first two are exactly what you need when a tile stays black.
configure_logging()
log = logging.getLogger("ibvap.api")

log = logging.getLogger("ibvap.integration.api")

app = FastAPI(title="IBVAP Integration API")

# The dashboard is served from Vite (:5173) while the API runs on :8000 — a
# different origin, so without this every browser fetch fails preflight even
# though curl works. Origins are an explicit allowlist, never "*": these
# routes carry a bearer token, and "*" plus credentials is exactly the
# combination that lets any page a viewer opens read this feed.
# Any port on localhost/127.0.0.1 is always allowed, regardless of
# IBVAP_ALLOW_LAN: Vite falls back to 5174/5175/... the moment 5173 is
# taken (confirmed live - "Port 5173 is in use, trying another one"), and
# IBVAP_CORS_ORIGINS below is a fixed list that doesn't track that. This
# isn't a security relaxation: it's still the same machine, and every route
# still requires the bearer token regardless of origin.
#
# With IBVAP_ALLOW_LAN=1, also accept private-range origins so the dashboard
# opens on a phone or a second laptop. Deliberately a regex over RFC1918
# addresses rather than "*": a public origin still cannot call this API, and
# the bearer token is required regardless of where the page was served from.
_LOCALHOST_ORIGIN_RE = r"localhost|127\.0\.0\.1|\[::1\]"
_LAN_ORIGIN_RE = (
    r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
    r"192\.168\.\d{1,3}\.\d{1,3}|"
    r"172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
)
_allowed_hosts = _LOCALHOST_ORIGIN_RE + (f"|{_LAN_ORIGIN_RE}" if IBVAP_ALLOW_LAN else "")
_CORS_ORIGIN_REGEX = rf"^https?://({_allowed_hosts})(:\d+)?$"

app.add_middleware(
    CORSMiddleware,
    allow_origins=IBVAP_CORS_ORIGINS,
    allow_origin_regex=_CORS_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# auto_error=False so a missing header reaches this handler and gets the same
# generic 401 as a malformed one — the caller learns only that it is
# unauthorized, never which part of its credential was wrong.
_bearer = HTTPBearer(auto_error=False)

# One shared instance: every failed-credential path raises exactly this, so no
# branch can accidentally describe which check failed.
_UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Unauthorized",
    headers={"WWW-Authenticate": "Bearer"},
)


def require_token(
    credentials: "HTTPAuthorizationCredentials | None" = Depends(_bearer),
) -> None:
    """Fail closed. An unset IBVAP_API_TOKEN is a deployment error, not an
    invitation — reported as 503 so an operator can tell "nobody configured
    this" apart from "your token is wrong" (401). That distinction is made to
    the *operator*, never to the caller: every credential failure returns the
    same opaque 401.
    """
    if not IBVAP_API_TOKEN:
        # Logged because an operator otherwise has no way to see why every
        # call 503s. The token value itself is never logged, here or anywhere.
        log.error(
            "IBVAP_API_TOKEN is not configured - refusing all API requests. "
            "Set it in the environment to enable the integration API."
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="API authentication is not configured",
        )
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _UNAUTHORIZED
    # compare_digest, not ==, so a wrong token can't be recovered a character
    # at a time from response timing.
    if not hmac.compare_digest(credentials.credentials, IBVAP_API_TOKEN):
        raise _UNAUTHORIZED


# --------------------------------------------------------------------------
# Legacy flat feed — shape frozen for existing C2/SIEM pollers.
# --------------------------------------------------------------------------



@app.get("/status")
def status_endpoint(_: None = Depends(require_token)) -> dict:
    # NOTE (audit finding C2, scheduled for Phase 20): this reports the API
    # process being alive, NOT pipeline or camera health — it shares no state
    # with app.py. Do not treat it as a camera-liveness check until Phase 20
    # adds the per-camera heartbeat.
    return {"status": "ok", "service": "IBVAP", "scope": "api-process-only"}


@app.get("/incidents")
def incidents(limit: int = 20, _: None = Depends(require_token)) -> dict:
    store = IncidentStore()
    try:
        rows = store.list_incidents(limit=limit)
    finally:
        store.close()
    return {"count": len(rows), "incidents": rows}


# --------------------------------------------------------------------------
# /api/v1 — the contract frontend/src/lib/api/ was written against.
# --------------------------------------------------------------------------

v1 = APIRouter(prefix="/api/v1")

# Fields the dashboard renders that the incidents table does not yet store.
# They are surfaced as explicit empty values rather than invented ones: a
# zeroed breakdown reads as "not recorded" in the UI, whereas a plausible
# S/T/K/C split would read as a real score this system never computed.
# Persisting them is a schema migration — see README "Known gaps".
_UNRECORDED_BREAKDOWN = {
    "sectorRisk": 0,
    "timeRisk": 0,
    "kinematicsRisk": 0,
    "classConfidence": 0,
}


def _breakdown(row: dict) -> dict:
    """Threat-score components for one incident.

    Incidents recorded before the breakdown column existed have none; they
    return zeros with recorded=False so the dashboard can say "not recorded"
    instead of presenting 0/0/0/0 as if the model had computed it.
    """
    try:
        raw = json.loads(row.get("breakdown") or "null")
    except (TypeError, ValueError):
        raw = None
    if not isinstance(raw, dict) or not raw:
        return {**_UNRECORDED_BREAKDOWN, "recorded": False}
    return {
        "sectorRisk": raw.get("sector_risk", 0),
        "timeRisk": raw.get("time_risk", 0),
        "kinematicsRisk": raw.get("kinematics_risk", 0),
        "classConfidence": raw.get("class_confidence", 0),
        "directionRisk": raw.get("direction_risk", 0),
        "loiterRisk": raw.get("loiter_risk", 0),
        "groupRisk": raw.get("group_risk", 0),
        "overrideReason": raw.get("override_reason"),
        "elevateReason": raw.get("elevate_reason"),
        "tierCeiling": raw.get("tier_ceiling"),
        "ceilingReason": raw.get("ceiling_reason"),
        "recorded": True,
    }


def _what_he_she_is_doing(row: dict, breakdown: dict) -> str:
    tier = str(row.get("tier") or row.get("zone_tier") or "green").lower()
    override = breakdown.get("overrideReason") or ""
    elevate = breakdown.get("elevateReason") or ""
    direction_risk = float(breakdown.get("directionRisk", 0))
    kinematics_risk = float(breakdown.get("kinematicsRisk", 0))
    loiter_risk = float(breakdown.get("loiterRisk", 0))
    time_risk = float(breakdown.get("timeRisk", 0))
    group_risk = float(breakdown.get("groupRisk", 0))

    actions = []
    if "border" in override.lower() or "cross" in override.lower():
        actions.append("Breached restricted border line")
    elif "cross" in elevate.lower():
        actions.append("Crossing detected in YELLOW approach zone")
    elif tier == "red":
        actions.append("Intruded into RED restricted perimeter")
    elif tier == "yellow":
        actions.append("Entered YELLOW approach buffer zone")
    else:
        actions.append("Detected in GREEN outer monitoring zone")

    if direction_risk > 0:
        actions.append("moving inward directly towards boundary fence")
    if kinematics_risk >= 10:
        actions.append("at rapid approach speed")
    if loiter_risk > 0:
        actions.append("suspicious prolonged loitering")
    if time_risk >= 18:
        actions.append("during restricted night curfew hours (11 PM - 5 AM)")
    if group_risk > 0:
        actions.append("coordinated group movement")

    if len(actions) == 1:
        return actions[0] + " — routine monitoring."
    return actions[0] + " — " + ", ".join(actions[1:]) + "."


def _serialise(row: dict) -> dict:
    """One incidents row -> the camelCase Incident the dashboard expects.

    burst_paths is stored as a JSON array string; a row written before that
    column existed reads back as NULL, so both are tolerated rather than
    letting one legacy row 500 the whole listing.
    """
    try:
        burst = json.loads(row.get("burst_paths") or "[]")
    except (TypeError, ValueError):
        burst = []

    person_id = row.get("person_id")
    bd = _breakdown(row)
    what_doing = _what_he_she_is_doing(row, bd)
    score_val = row.get("score") or 0
    threat_level = "CRITICAL" if score_val >= 90 or row.get("tier") == "red" else ("HIGH" if score_val >= 70 else ("MEDIUM" if score_val >= 31 else "LOW"))

    return {
        "id": row["id"],
        "trackId": row.get("track_id"),
        "personId": person_id,
        "category": row.get("category") or "unknown",
        "zoneTier": row.get("zone_tier") or "green",
        "score": score_val,
        "tier": row.get("tier") or "green",
        "threatLevel": threat_level,
        "whatHeIsDoing": what_doing,
        "timestamp": row.get("timestamp") or 0,
        # NULL on incidents recorded before the pipeline stored it.
        "cameraName": row.get("camera_name") or "unknown",
        # API paths, not file paths. Evidence is Fernet-encrypted on disk, so
        # the stored path was never loadable by a browser; these routes
        # decrypt it (see v1_evidence). The dashboard appends the base URL
        # and token.
        "snapshotUrl": f"/incidents/{row['id']}/evidence/snapshot" if row.get("snapshot_path") else None,
        "cropUrl": f"/incidents/{row['id']}/evidence/crop" if row.get("crop_path") else None,
        "burstUrls": (
            [f"/incidents/{row['id']}/evidence/burst/{i}" for i in range(len(burst))]
            if isinstance(burst, list) else []
        ),
        "watchlistMatch": row.get("watchlist_match"),
        "breakdown": bd,
        "reidGalleryId": f"PG-{person_id}" if person_id is not None else "",
        "encryption": {
            "cipher": "FERNET-AES128-CBC",
            "keyPath": "database/evidence.key",
            "verified": bool(row.get("snapshot_path")),
        },
        "status": row.get("status"),
        "acknowledgedBy": row.get("acknowledged_by"),
        "acknowledgedAt": row.get("acknowledged_at"),
        "resolvedBy": row.get("resolved_by"),
        "resolvedAt": row.get("resolved_at"),
        "resolutionReason": row.get("resolution_reason"),
    }


@v1.get("/health")
def health() -> dict:
    """Unauthenticated on purpose: frontend/src/lib/api/client.ts polls this
    with no Authorization header to decide "backend up?" vs "fall back to
    mock data". Gating it behind the token would make a correctly-configured
    backend report itself permanently offline. It discloses only that a
    server is listening — no incident data crosses this route."""
    return {"status": "ok", "service": "IBVAP"}


@v1.get("/incidents")
def v1_incidents(
    limit: int = Query(200, ge=1, le=1000), _: None = Depends(require_token)
) -> list:
    """Returns a bare JSON array — incidentsApi.getIncidents() types the
    response as Incident[], not an envelope, so a {count, incidents} wrapper
    would land in the UI as zero incidents rather than as an error."""
    store = IncidentStore()
    try:
        rows = store.list_incidents(limit=limit)
    finally:
        store.close()
    return [_serialise(r) for r in rows]


@v1.get("/incidents/{incident_id}")
def v1_incident(incident_id: int, _: None = Depends(require_token)) -> dict:
    store = IncidentStore()
    try:
        row = store.get_incident(incident_id)
    finally:
        store.close()
    if row is None:
        raise HTTPException(status_code=404, detail=f"No incident {incident_id}.")
    return _serialise(row)


@v1.post("/incidents/{incident_id}/acknowledge")
def v1_acknowledge(incident_id: int, _: None = Depends(require_token)) -> dict:
    """Checks the row exists first: IncidentStore.acknowledge() is a bare
    UPDATE, which affects zero rows for an unknown id and reports success
    just the same. The dashboard would then grey out an incident the
    database never acknowledged."""
    store = IncidentStore()
    try:
        if store.get_incident(incident_id) is None:
            raise HTTPException(status_code=404, detail=f"No incident {incident_id}.")
        # No operator identity on this route yet — auth is a single shared
        # service token, so there is no per-user claim to attribute this to.
        store.acknowledge(incident_id, operator="dashboard")
    finally:
        store.close()
    return {"success": True, "id": incident_id}



# --------------------------------------------------------------------------
# Cameras + live MJPEG
# --------------------------------------------------------------------------

# Dashboard-owned camera metadata (location/sector labels, plus any camera
# added from the UI). CAMERA_SOURCES stays the source of truth for what the
# pipeline actually opens; this file only decorates and extends it, so
# editing .env still wins for anything already listed there.
CAMERAS_FILE = "config/cameras.json"


def _load_camera_overlay() -> dict:
    if not os.path.exists(CAMERAS_FILE):
        return {}
    try:
        with open(CAMERAS_FILE) as f:
            return {c["id"]: c for c in json.load(f)}
    except (OSError, ValueError, KeyError):
        log_broken = "config/cameras.json is unreadable — ignoring it"
        print(f"[api] {log_broken}")
        return {}


def _save_camera_overlay(by_id: dict) -> None:
    os.makedirs(os.path.dirname(CAMERAS_FILE) or ".", exist_ok=True)
    with open(CAMERAS_FILE, "w") as f:
        json.dump(list(by_id.values()), f, indent=2)


def _camera_sources() -> dict:
    """Every camera from CAMERA_SOURCES (.env), overlaid with cameras added
    or edited via config/cameras.json (the dashboard). Adding a camera in the
    UI must never make a real .env camera disappear from the list."""
    sources = dict(CAMERA_SOURCES)
    overlay = _load_camera_overlay()
    for cam_id, meta in overlay.items():
        if meta.get("source") is not None:
            sources[cam_id] = meta["source"]
    return sources


def _tracker_factory():
    from tracking.tracker import Tracker

    return Tracker(model_path=DETECTION_MODEL_PATH, confidence=DETECTION_CONFIDENCE)


def _pipeline_state() -> "dict | None":
    """The running pipeline's last published health, or None if it is not
    running. See integration/runtime_state.py."""
    health = runtime_state.read_health()
    return health if health and health.get("running") else None


def _pipeline_owns(camera_id: str) -> bool:
    state = _pipeline_state()
    return bool(state and camera_id in (state.get("cameras") or {}))


registry = LiveCameraRegistry(
    _camera_sources,
    CAMERA_WIDTH,
    CAMERA_HEIGHT,
    tracker_factory=_tracker_factory,
    yield_fn=_pipeline_owns,
)


@app.on_event("shutdown")
def _release_cameras() -> None:
    registry.shutdown()


def require_token_query(request: Request) -> None:
    """Same check as require_token, but also accepts ?token=.

    An <img src> tag cannot set an Authorization header, and CameraTile.tsx
    renders the stream as exactly that — so the MJPEG route has no way to
    receive the bearer token except in the URL. This is not a weakening in
    practice: VITE_API_TOKEN is already compiled into the browser bundle, so
    a viewer who can load the dashboard can read the token either way. It
    does mean the token reaches server access logs, which a header would not.
    """
    supplied = request.query_params.get("token", "")
    if not supplied:
        header = request.headers.get("authorization", "")
        if header.lower().startswith("bearer "):
            supplied = header[7:]
    if not IBVAP_API_TOKEN:
        raise HTTPException(status_code=503, detail="IBVAP_API_TOKEN is not set.")
    if not hmac.compare_digest(supplied, IBVAP_API_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid or missing token.")


def _zones_path(camera_id: str) -> str:
    p1 = f"config/zones/{camera_id}.json"
    if os.path.exists(p1):
        return p1
    return f"config/zones_{camera_id}.json"


def _boundaries_path(camera_id: str) -> str:
    return f"config/boundaries_{camera_id}.json"


def _zone_count(camera_id: str) -> int:
    path = _zones_path(camera_id)
    if not os.path.exists(path):
        return 0
    try:
        with open(path) as f:
            data = json.load(f)
        return len(data) if isinstance(data, list) else 0
    except (OSError, ValueError):
        return 0


def _camera_status(camera_id: str, pipeline: "dict | None") -> dict:
    """Where this camera's picture comes from, and whether it is healthy.

    source = "pipeline"  the AI pipeline owns the device; boxes, zones and
                         threat scores on the feed are the model's real
                         output, and incidents are being recorded.
             "direct"    the dashboard opened the camera itself for a preview.
                         Detection boxes are drawn, but nothing is scored or
                         recorded — no alerts will fire from this view.
             "idle"      nobody has the camera open.
    """
    cams = (pipeline or {}).get("cameras") or {}
    if camera_id in cams:
        st = cams[camera_id]
        return {
            "source": "pipeline",
            "health": st.get("health") or "offline",
            "fps": st.get("fps") or 0.0,
            "activityGate": "HIGH" if st.get("active") else "LOW",
            "lowLightBoost": bool(st.get("lowLightBoost")),
            "brightness": st.get("brightness"),
            "detections": st.get("detections", 0),
            "maxTier": st.get("maxTier"),
            "lastFrameAt": st.get("lastFrameAt"),
            "zones": st.get("zones", _zone_count(camera_id)),
        }
    live = registry.status(camera_id)
    return {
        "source": "direct" if live["live"] else "idle",
        "health": "online" if live["live"] else "idle",
        "fps": live["fps"],
        "activityGate": None,
        "lowLightBoost": None,
        "brightness": None,
        "detections": None,
        "maxTier": None,
        "lastFrameAt": None,
        "zones": _zone_count(camera_id),
    }


@v1.get("/cameras")
def v1_cameras(_: None = Depends(require_token)) -> list:
    from config.settings import CAMERA_ZONE_TIERS
    overlay = _load_camera_overlay()
    pipeline = _pipeline_state()
    out = []
    for cam_id, source in _camera_sources().items():
        meta = overlay.get(cam_id, {})
        status_ = _camera_status(cam_id, pipeline)
        tier = meta.get("zoneTier") or CAMERA_ZONE_TIERS.get(cam_id)
        if not tier:
            # Fallback guess from a trailing camera index (cam0 -> red, cam1
            # -> red, cam2 -> yellow, else green) only when no explicit tier
            # is configured anywhere. Matches on the trailing digits only —
            # "1" in cam_id would wrongly match cam10/cam12/cam01.
            trailing_digits = re.search(r"(\d+)$", cam_id)
            index = int(trailing_digits.group(1)) if trailing_digits else None
            if index in (0, 1):
                tier = "red"
            elif index == 2:
                tier = "yellow"
            else:
                tier = "green"
        tier = tier.lower()
        zone_profile = f"{tier.upper()} PRIORITY"
        is_active = status_["health"] in ("online", "idle") or str(source).lower() in ("simulated", "demo", "mock")

        out.append(
            {
                "id": cam_id,
                "name": meta.get("name") or cam_id.upper(),
                "location": meta.get("location") or f"{cam_id} (source {source})",
                "sector": meta.get("sector") or "Border Sector",
                "zoneTier": tier,
                "zoneProfile": zone_profile,
                "source": str(source),
                "streamUrl": f"/cameras/{cam_id}/stream",
                "fps": str(status_["fps"] if status_["fps"] > 0 else (25.0 if is_active else 0.0)),
                "activity": (
                    ("MOTION" if status_["activityGate"] == "HIGH" else "IDLE")
                    if status_["source"] == "pipeline"
                    else ("PREVIEW" if is_active else "STANDBY")
                ),
                "isActive": is_active,
                "resolution": f"{CAMERA_WIDTH}x{CAMERA_HEIGHT}",
                **status_,
            }
        )
    return out


@v1.post("/cameras")
def v1_add_camera(camera: dict = Body(...), _: None = Depends(require_token)) -> dict:
    from camera.source import normalize_source
    overlay = _load_camera_overlay()
    name = str(camera.get("name") or "").strip()
    cam_id = str(camera.get("id") or "").strip().lower().replace(" ", "_")
    if not cam_id:
        cam_id = f"cam_{len(overlay) + 1}"

    raw = camera.get("source") or camera.get("streamUrl") or "simulated"
    source = normalize_source(raw)
    tier = str(camera.get("zoneTier") or "yellow").lower()
    if tier not in ("red", "yellow", "green"):
        tier = "yellow"

    overlay[cam_id] = {
        "id": cam_id,
        "name": name or f"Camera {cam_id.upper()}",
        "source": source,
        "location": camera.get("location") or "Border Perimeter",
        "sector": camera.get("sector") or "Security Post",
        "zoneTier": tier,
        "zoneProfile": f"{tier.upper()} PRIORITY",
    }
    _save_camera_overlay(overlay)
    from config import settings
    settings.CAMERA_ZONE_TIERS[cam_id] = tier
    return overlay[cam_id]


@v1.patch("/cameras/{camera_id}")
def v1_update_camera(camera_id: str, updates: dict = Body(...), _: None = Depends(require_token)) -> dict:
    from camera.source import normalize_source
    overlay = _load_camera_overlay()
    if camera_id not in overlay:
        overlay[camera_id] = {"id": camera_id, "name": camera_id.upper(), "source": "simulated", "zoneTier": "yellow"}

    if "zoneTier" in updates:
        tier = str(updates["zoneTier"]).lower()
        if tier in ("red", "yellow", "green"):
            overlay[camera_id]["zoneTier"] = tier
            overlay[camera_id]["zoneProfile"] = f"{tier.upper()} PRIORITY"
            from config import settings
            settings.CAMERA_ZONE_TIERS[camera_id] = tier
    if "name" in updates:
        overlay[camera_id]["name"] = str(updates["name"])
    if "location" in updates:
        overlay[camera_id]["location"] = str(updates["location"])
    if "sector" in updates:
        overlay[camera_id]["sector"] = str(updates["sector"])
    if "source" in updates:
        overlay[camera_id]["source"] = normalize_source(updates["source"])

    _save_camera_overlay(overlay)
    return overlay[camera_id]


@v1.delete("/cameras/{camera_id}")
def v1_delete_camera(camera_id: str, _: None = Depends(require_token)) -> dict:
    if camera_id in CAMERA_SOURCES:
        raise HTTPException(
            status_code=409,
            detail=f"Camera {camera_id!r} is defined in .env (CAMERA_SOURCES) and cannot be deleted via the API.",
        )
    overlay = _load_camera_overlay()
    if camera_id not in overlay:
        raise HTTPException(status_code=404, detail=f"No camera {camera_id!r}.")
    overlay.pop(camera_id)
    _save_camera_overlay(overlay)
    registry.force_stop(camera_id)
    return {"success": True, "id": camera_id}


@v1.post("/cameras/test")
def v1_test_camera(payload: dict = Body(...), _: None = Depends(require_token)) -> dict:
    """Briefly opens a candidate source (webcam index or RTSP/HTTP URL) to
    check it is actually reachable, without registering it as a camera.
    Used by the Add/Edit Camera "Test Connection" button so a bad RTSP URL
    is caught before it is saved, instead of showing up as a dead tile later.
    """
    from camera.source import normalize_source

    raw = payload.get("source")
    if raw is None or str(raw).strip() == "":
        raise HTTPException(status_code=400, detail="No source provided.")

    source = normalize_source(raw)
    started = time.time()
    cap = cv2.VideoCapture(source)
    try:
        if not cap.isOpened():
            return {
                "ok": False,
                "detail": "Could not open the source — check the URL/index, that the "
                "camera is powered on, and that it is reachable on the network.",
                "elapsedMs": round((time.time() - started) * 1000),
            }
        # RTSP/H.264 sources often fail their first several reads while the
        # decoder resolves SPS/PPS — the same tolerance app.py's stream
        # manager uses for a live stream, just bounded for a quick check.
        width = height = None
        frame_ok = False
        for _ in range(25):
            ok, frame = cap.read()
            if ok and frame is not None and getattr(frame, "size", 0) > 0:
                frame_ok = True
                height, width = frame.shape[:2]
                break
        elapsed_ms = round((time.time() - started) * 1000)
        if not frame_ok:
            return {
                "ok": False,
                "detail": "The source opened but sent no readable video frame — "
                "check the stream path/codec, or that nothing else is using the device.",
                "elapsedMs": elapsed_ms,
            }
        return {
            "ok": True,
            "detail": f"Connected — received a {width}x{height} frame.",
            "resolution": f"{width}x{height}",
            "elapsedMs": elapsed_ms,
        }
    finally:
        cap.release()


@v1.get("/cameras/{camera_id}/live")
def v1_camera_live(camera_id: str, _: None = Depends(require_token)) -> dict:
    """Is the device actually open, and how many viewers are on it."""
    if camera_id not in _camera_sources():
        raise HTTPException(status_code=404, detail=f"No camera {camera_id!r}.")
    return {"id": camera_id, **registry.status(camera_id)}


@v1.post("/cameras/{camera_id}/stop")
def v1_camera_stop(camera_id: str, _: None = Depends(require_token)) -> dict:
    """Release the device now, without waiting for the idle timer.

    Needed because the reaper only fires once the last viewer disconnects: a
    dashboard left open on Live Feeds is a viewer, so the webcam would stay
    lit indefinitely. This also frees the device for app.py, which cannot
    open it while this process holds it.

    Any browser still pointed at the stream will reconnect on its own and
    re-open the camera — close the Live Feeds tab first for it to stay off.
    """
    if camera_id not in _camera_sources():
        raise HTTPException(status_code=404, detail=f"No camera {camera_id!r}.")
    was = registry.status(camera_id)
    registry.force_stop(camera_id)
    return {"success": True, "id": camera_id, "wasLive": was["live"]}


def _mjpeg_part(jpeg: bytes) -> bytes:
    return (
        b"--frame\r\nContent-Type: image/jpeg\r\n"
        b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n"
    )


def _pipeline_frames(camera_id: str):
    """Serves the frames app.py publishes, re-reading only when the file
    changes. Ends after 5s with no new frame so the <img> reconnects and the
    route re-decides the source — e.g. the pipeline stopped, so fall back to
    a direct preview, rather than freezing on the last frame forever."""
    path = runtime_state.frame_path(camera_id)
    poll = 0.5 / max(runtime_state.LIVE_PUBLISH_FPS, 1.0)
    last_mtime = None
    last_new = time.monotonic()
    while True:
        try:
            mtime = os.stat(path).st_mtime_ns
        except OSError:
            mtime = None
        if mtime is not None and mtime != last_mtime:
            try:
                with open(path, "rb") as f:
                    jpeg = f.read()
            except OSError:
                jpeg = b""
            if jpeg:
                last_mtime = mtime
                last_new = time.monotonic()
                yield _mjpeg_part(jpeg)
                continue
        if time.monotonic() - last_new > 5.0:
            return
        time.sleep(poll)


@v1.get("/cameras/{camera_id}/stream")
def v1_camera_stream(camera_id: str, _: None = Depends(require_token_query)):
    """multipart/x-mixed-replace — the format an <img> tag renders as video.

    Prefers the AI pipeline's own annotated frames when it is running, so the
    dashboard never competes with it for the device. Only when the pipeline
    is down does this open the camera itself as a direct preview.
    """
    if camera_id not in _camera_sources():
        raise HTTPException(status_code=404, detail=f"No camera {camera_id!r}.")
    if _pipeline_owns(camera_id):
        try:
            runtime_state.frame_path(camera_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return StreamingResponse(
            _pipeline_frames(camera_id),
            media_type="multipart/x-mixed-replace; boundary=frame",
            headers={"X-IBVAP-Source": "pipeline", "Cache-Control": "no-store"},
        )
    try:
        cam = registry.acquire(camera_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No camera {camera_id!r}.")
    except CameraBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    def frames():
        last_seq = 0
        try:
            while True:
                jpeg, last_seq = cam.wait_for_frame(last_seq, timeout=5.0)
                if jpeg is None:
                    # Camera stopped, or five seconds without a frame. Ending
                    # the response lets the <img> tag retry rather than
                    # holding a socket open on a dead feed.
                    break
                yield (
                    b"--frame\r\nContent-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n"
                    + jpeg + b"\r\n"
                )
        finally:
            # Runs on client disconnect too (the generator is closed), which
            # is what lets the idle reaper ever release the device.
            registry.release(camera_id)

    return StreamingResponse(
        frames(), media_type="multipart/x-mixed-replace; boundary=frame"
    )



# --------------------------------------------------------------------------
# Offline video replay — upload a recorded clip, then "activate" it by
# writing it into .env's CAMERA_SOURCES. Dashboard-added cameras (config/
# cameras.json, above) are preview-only: the running pipeline reads
# CAMERA_SOURCES once at startup (config/settings.py), so a video only gets
# real detection/tracking/zone/scoring once it's in .env AND the pipeline is
# restarted. This section never starts or reloads the pipeline itself — it
# only prepares the file and the .env entry, then reports needsRestart so
# the dashboard can tell the operator to run `./run.sh all`.
# --------------------------------------------------------------------------

UPLOADS_DIR = "uploads/videos"
_ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".webm"}
_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024  # 1 GiB
ENV_FILE = ".env"


def _video_camera_id(filename: str) -> str:
    """cam_id used in CAMERA_SOURCES for this file. Prefixed with replay_ so
    it can never collide with a real .env camera like cam0/cam1."""
    stem = os.path.splitext(filename)[0]
    slug = re.sub(r"[^a-z0-9]+", "_", stem.lower()).strip("_") or "clip"
    return f"replay_{slug}"


def _sanitize_video_filename(filename: str) -> str:
    name = os.path.basename(filename or "")
    stem, ext = os.path.splitext(name)
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", stem).strip("_") or "video"
    return f"{stem}{ext.lower()}"


def _read_env_camera_sources() -> dict:
    """Reads CAMERA_SOURCES straight out of .env, not the process's own
    CAMERA_SOURCES import (frozen at process start) — so "active" status
    always reflects what a restart would actually pick up."""
    if not os.path.exists(ENV_FILE):
        return {}
    with open(ENV_FILE) as f:
        for line in f:
            if line.strip().startswith("CAMERA_SOURCES="):
                from config.settings import _parse_camera_sources
                raw = line.strip()[len("CAMERA_SOURCES="):]
                return {k: str(v) for k, v in _parse_camera_sources(raw).items()}
    return {}


def _write_env_camera_sources(sources: dict) -> None:
    """Rewrites only the CAMERA_SOURCES= line in .env, preserving every
    other line (comments, ordering, blank lines) exactly."""
    new_line = "CAMERA_SOURCES=" + ",".join(f"{k}={v}" for k, v in sources.items()) + "\n"
    lines = []
    found = False
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE) as f:
            for line in f:
                if line.strip().startswith("CAMERA_SOURCES="):
                    lines.append(new_line)
                    found = True
                else:
                    lines.append(line if line.endswith("\n") else line + "\n")
    if not found:
        lines.append(new_line)
    with open(ENV_FILE, "w") as f:
        f.writelines(lines)


@v1.get("/videos")
def v1_videos(_: None = Depends(require_token)) -> list:
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    env_sources = _read_env_camera_sources()
    out = []
    for filename in sorted(os.listdir(UPLOADS_DIR)):
        path = os.path.join(UPLOADS_DIR, filename)
        if not os.path.isfile(path):
            continue
        cam_id = _video_camera_id(filename)
        is_active = cam_id in env_sources
        out.append({
            "id": filename,
            "cameraId": cam_id,
            "filename": filename,
            "sizeBytes": os.path.getsize(path),
            "uploadedAt": datetime.fromtimestamp(os.path.getmtime(path)).isoformat(),
            "isActive": is_active,
            "needsRestart": is_active and not _pipeline_owns(cam_id),
        })
    return out


@v1.post("/videos/upload")
async def v1_upload_video(
    request: Request, filename: str, _: None = Depends(require_token)
) -> dict:
    """Streams the raw request body straight to disk instead of using
    FastAPI's multipart UploadFile — this project has no python-multipart
    dependency, and base64 JSON (as the watchlist photo endpoint uses) would
    add ~33% overhead and hold a whole video in memory at once."""
    safe_name = _sanitize_video_filename(filename)
    ext = os.path.splitext(safe_name)[1].lower()
    if ext not in _ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported video type {ext!r}. Allowed: {sorted(_ALLOWED_VIDEO_EXTENSIONS)}",
        )

    os.makedirs(UPLOADS_DIR, exist_ok=True)
    stem, extension = os.path.splitext(safe_name)
    dest = os.path.join(UPLOADS_DIR, safe_name)
    counter = 1
    while os.path.exists(dest):
        safe_name = f"{stem}_{counter}{extension}"
        dest = os.path.join(UPLOADS_DIR, safe_name)
        counter += 1

    tmp_path = dest + ".part"
    written = 0
    try:
        with open(tmp_path, "wb") as f:
            async for chunk in request.stream():
                written += len(chunk)
                if written > _MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Video exceeds the 1 GiB upload limit.")
                f.write(chunk)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise
    if written == 0:
        os.remove(tmp_path)
        raise HTTPException(status_code=400, detail="Empty upload.")
    os.replace(tmp_path, dest)

    return {
        "id": safe_name,
        "cameraId": _video_camera_id(safe_name),
        "filename": safe_name,
        "sizeBytes": written,
    }


@v1.post("/videos/{video_id}/activate")
def v1_activate_video(video_id: str, _: None = Depends(require_token)) -> dict:
    path = os.path.join(UPLOADS_DIR, video_id)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail=f"No uploaded video {video_id!r}.")
    cam_id = _video_camera_id(video_id)
    sources = _read_env_camera_sources()
    sources[cam_id] = os.path.abspath(path)
    _write_env_camera_sources(sources)
    return {"cameraId": cam_id, "needsRestart": True}


@v1.post("/videos/{video_id}/deactivate")
def v1_deactivate_video(video_id: str, _: None = Depends(require_token)) -> dict:
    cam_id = _video_camera_id(video_id)
    sources = _read_env_camera_sources()
    if cam_id not in sources:
        return {"cameraId": cam_id, "needsRestart": False}
    del sources[cam_id]
    _write_env_camera_sources(sources)
    return {"cameraId": cam_id, "needsRestart": True}


@v1.delete("/videos/{video_id}")
def v1_delete_video(video_id: str, _: None = Depends(require_token)) -> dict:
    path = os.path.join(UPLOADS_DIR, video_id)
    cam_id = _video_camera_id(video_id)
    sources = _read_env_camera_sources()
    needs_restart = False
    if cam_id in sources:
        del sources[cam_id]
        _write_env_camera_sources(sources)
        needs_restart = True
    if os.path.isfile(path):
        os.remove(path)
    return {"success": True, "id": video_id, "needsRestart": needs_restart}


# --------------------------------------------------------------------------
# Zones
# --------------------------------------------------------------------------


def _to_pixels(points: list) -> list:
    return [
        [int(round(p["x"] * CAMERA_WIDTH)), int(round(p["y"] * CAMERA_HEIGHT))]
        for p in points
    ]


def _to_normalised(polygon: list) -> list:
    return [
        {"x": round(x / CAMERA_WIDTH, 6), "y": round(y / CAMERA_HEIGHT, 6)}
        for x, y in polygon
    ]


@v1.get("/zones")
def v1_zones(_: None = Depends(require_token)) -> dict:
    out = {}
    for cam_id in _camera_sources():
        path = _zones_path(cam_id)
        entries = []
        if os.path.exists(path):
            try:
                with open(path) as f:
                    entries = json.load(f)
            except (OSError, ValueError):
                entries = []
        out[cam_id] = [
            {
                "id": z.get("id", f"zone-{cam_id}-{i}"),
                "cameraName": cam_id,
                "tier": z.get("zone_type", "green"),
                # The operator-facing label (restricted/buffer/transit/
                # authorized), if this zone was saved with one. Absent/None
                # for zones saved before roles existed, or drawn directly
                # with a raw tier - those keep working exactly as before.
                "role": z.get("role"),
                "points": _to_normalised(z.get("polygon", [])),
                "label": z.get("label", f"{z.get('zone_type', 'zone')} zone"),
                "direction": z.get("direction"),
                "enabled": z.get("enabled", True),
                "tripwireEnabled": z.get("tripwireEnabled", False),
                "loiteringThresholdSeconds": z.get("loiteringThresholdSeconds"),
                "climbingDetection": z.get("climbingDetection", False),
            }
            for i, z in enumerate(entries)
        ]
    return out


@v1.put("/zones")
def v1_save_zones(zones: dict = Body(...), _: None = Depends(require_token)) -> dict:
    policy = ZonePolicy()
    written = {}
    for cam_id, cam_zones in zones.items():
        if cam_id not in _camera_sources():
            continue
        payload = []
        for i, z in enumerate(cam_zones):
            polygon = _to_pixels(z.get("points", []))
            if len(polygon) < 2:
                raise HTTPException(
                    status_code=422,
                    detail=f"Zone {z.get('id', i)} on {cam_id} has fewer than 2 points.",
                )
            role = z.get("role")
            if role is not None and role not in ZONE_ROLES:
                raise HTTPException(
                    status_code=422,
                    detail=f"Zone {z.get('id', i)} on {cam_id} has unknown role {role!r}.",
                )
            # A role resolves to a tier via the configurable policy - the
            # zone_type written to disk is always a plain red/yellow/green
            # tier either way, so ZoneEngine/ThreatScorer need no changes to
            # read a zone saved with a role. An explicit "tier" still wins
            # if no role was given, exactly as before roles existed.
            tier = policy.tier_for_role(role) or z.get("tier", "green")
            if tier not in VALID_TIERS:
                raise HTTPException(
                    status_code=422,
                    detail=f"Zone {z.get('id', i)} on {cam_id} has invalid tier {tier!r}.",
                )
            payload.append(
                {
                    "zone_type": tier,
                    "role": role,
                    "polygon": polygon,
                    "id": z.get("id", f"zone-{cam_id}-{i}"),
                    "label": z.get("label", ""),
                    "direction": z.get("direction"),
                    "enabled": z.get("enabled", True),
                    "tripwireEnabled": z.get("tripwireEnabled", False),
                    "loiteringThresholdSeconds": z.get("loiteringThresholdSeconds"),
                    "climbingDetection": z.get("climbingDetection", False),
                }
            )
        path = _zones_path(cam_id)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            json.dump(payload, f, indent=2)
        written[cam_id] = payload
    return v1_zones()


@v1.get("/zone-policy")
def v1_zone_policy(_: None = Depends(require_token)) -> dict:
    return ZonePolicy().as_dict()


@v1.put("/zone-policy")
def v1_save_zone_policy(mapping: dict = Body(...), _: None = Depends(require_token)) -> dict:
    policy = ZonePolicy()
    try:
        policy.update(mapping)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return policy.as_dict()


# --------------------------------------------------------------------------
# Boundaries (virtual tripwires) — kept separate from zones on purpose; see
# zones/boundary_engine.py. Detected and shown to the operator, never fed
# into scoring or incidents.
# --------------------------------------------------------------------------


@v1.get("/boundaries")
def v1_boundaries(_: None = Depends(require_token)) -> dict:
    out = {}
    for cam_id in _camera_sources():
        engine = BoundaryEngine(config_path=_boundaries_path(cam_id))
        out[cam_id] = [
            {
                "id": b.id,
                "cameraName": cam_id,
                "label": b.label,
                "p1": {"x": round(b.line.p1[0] / CAMERA_WIDTH, 6), "y": round(b.line.p1[1] / CAMERA_HEIGHT, 6)},
                "p2": {"x": round(b.line.p2[0] / CAMERA_WIDTH, 6), "y": round(b.line.p2[1] / CAMERA_HEIGHT, 6)},
                "enabled": b.enabled,
            }
            for b in engine.boundaries
        ]
    return out


@v1.put("/boundaries")
def v1_save_boundaries(boundaries: dict = Body(...), _: None = Depends(require_token)) -> dict:
    for cam_id, cam_boundaries in boundaries.items():
        if cam_id not in _camera_sources():
            continue
        engine = BoundaryEngine()
        for i, b in enumerate(cam_boundaries):
            p1, p2 = b.get("p1"), b.get("p2")
            if not p1 or not p2:
                raise HTTPException(
                    status_code=422,
                    detail=f"Boundary {b.get('id', i)} on {cam_id} needs both p1 and p2.",
                )
            engine.boundaries.append(
                Boundary(
                    id=b.get("id", f"boundary-{cam_id}-{i}"),
                    label=b.get("label", ""),
                    p1=(p1["x"] * CAMERA_WIDTH, p1["y"] * CAMERA_HEIGHT),
                    p2=(p2["x"] * CAMERA_WIDTH, p2["y"] * CAMERA_HEIGHT),
                    enabled=b.get("enabled", True),
                )
            )
        engine.config_path = _boundaries_path(cam_id)
        engine.save()
    return v1_boundaries()


# --------------------------------------------------------------------------
# Demo Mode Controls (Phase 22–26)
# --------------------------------------------------------------------------


@v1.get("/demo/status")
def v1_demo_status(_: None = Depends(require_token)) -> dict:
    from demo.demo_engine import get_demo_engine
    engine = get_demo_engine()
    return engine.status()


@v1.post("/demo/run")
def v1_demo_run(_: None = Depends(require_token)) -> dict:
    from demo.demo_engine import get_demo_engine
    engine = get_demo_engine()
    return engine.run_all(delay_seconds=0.0)


@v1.post("/demo/step")
def v1_demo_step(_: None = Depends(require_token)) -> dict:
    from demo.demo_engine import get_demo_engine
    engine = get_demo_engine()
    return engine.step()


@v1.post("/demo/reset")
def v1_demo_reset(_: None = Depends(require_token)) -> dict:
    from demo.demo_engine import get_demo_engine
    engine = get_demo_engine()
    return engine.reset()


# --------------------------------------------------------------------------
# Watchlist
# --------------------------------------------------------------------------



@v1.get("/watchlist")
def v1_watchlist(_: None = Depends(require_token)) -> list:
    from face.watchlist import WatchlistDB

    db = WatchlistDB()
    try:
        rows = db.all_entries()
        meta = _watchlist_meta(db)
    finally:
        db.close()
    return [
        {
            "id": pid,
            "name": name,
            "notes": meta.get(pid, {}).get("notes", ""),
            # The dashboard renders a generated SVG portrait when this is
            # empty. The real reference photo is not retained — only its
            # 512-float embedding is, which cannot be turned back into a face.
            "photoUrl": "",
            "addedAt": meta.get(pid, {}).get("added_at", 0),
            "lastMatchedAt": meta.get(pid, {}).get("last_matched_at"),
            "matchCount": meta.get(pid, {}).get("match_count", 0),
        }
        for pid, name, _emb in rows
    ]


def _watchlist_meta(db) -> dict:
    """Operator-facing columns the original table never had. Added the same
    way incident_store migrates: ADD COLUMN only, so an existing watchlist.db
    keeps its enrolled faces."""
    cur = db._conn.execute("PRAGMA table_info(watchlist)")
    existing = {row[1] for row in cur.fetchall()}
    for col, ddl in (
        ("notes", "TEXT"),
        ("added_at", "REAL"),
        ("last_matched_at", "REAL"),
        ("match_count", "INTEGER NOT NULL DEFAULT 0"),
    ):
        if col not in existing:
            db._conn.execute(f"ALTER TABLE watchlist ADD COLUMN {col} {ddl}")
    db._conn.commit()
    cur = db._conn.execute(
        "SELECT id, notes, added_at, last_matched_at, match_count FROM watchlist"
    )
    return {
        r[0]: {
            "notes": r[1] or "",
            "added_at": r[2] or 0,
            "last_matched_at": r[3],
            "match_count": r[4] or 0,
        }
        for r in cur.fetchall()
    }


# FaceRecognizer loads InsightFace (~1-2s and ~100MB). Enrolment is rare, so
# it is built on first use and then kept, rather than paid for at startup by
# every deployment that never enrols anyone.
_recognizer = None
_recognizer_lock = threading.Lock()


def _get_recognizer():
    global _recognizer
    with _recognizer_lock:
        if _recognizer is None:
            from face.face_recognizer import FaceRecognizer

            _recognizer = FaceRecognizer()
        return _recognizer


@v1.post("/watchlist")
def v1_enroll(person: dict = Body(...), _: None = Depends(require_token)) -> dict:
    """Enrol a face from an uploaded photo.

    Mirrors scripts/add_to_watchlist.py: decode the image, take the largest
    face InsightFace finds, store its 512-float embedding. The photo itself is
    never written to disk — the embedding is not reversible into a face, which
    keeps an enrolled person's image out of the system entirely.

    A name alone cannot be enrolled: with no embedding there is nothing for a
    live face to be compared against, so the row would sit in the watchlist
    looking active and never match anyone.
    """
    import base64

    import numpy as np

    name = str(person.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=422, detail="A name is required.")

    raw = person.get("photoData") or person.get("photoUrl") or ""
    if not isinstance(raw, str) or not raw.startswith("data:image"):
        raise HTTPException(
            status_code=422,
            detail=(
                "A photo is required, sent as a data: URL. A generated avatar "
                "or a blob: URL carries no face, so no embedding can be made."
            ),
        )

    try:
        encoded = raw.split(",", 1)[1]
        buf = np.frombuffer(base64.b64decode(encoded), dtype=np.uint8)
        frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    except (ValueError, IndexError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=f"Unreadable image data: {exc}")
    if frame is None:
        raise HTTPException(status_code=422, detail="Image could not be decoded.")

    h, w = frame.shape[:2]
    _, embedding = _get_recognizer().embed(frame, (0, 0, w, h))
    if embedding is None:
        raise HTTPException(
            status_code=422,
            detail="No face found in that photo — use a clearer, more frontal image.",
        )

    from face.watchlist import WatchlistDB

    db = WatchlistDB()
    try:
        _watchlist_meta(db)  # ensure the operator columns exist
        person_id = db.add_person(name, embedding)
        db._conn.execute(
            "UPDATE watchlist SET notes = ?, added_at = ? WHERE id = ?",
            (str(person.get("notes", "")), time.time(), person_id),
        )
        db._conn.commit()
    finally:
        db.close()

    log.info("Enrolled %r into the watchlist (id=%d)", name, person_id)
    return {
        "id": person_id,
        "name": name,
        "notes": person.get("notes", ""),
        "photoUrl": "",
        "addedAt": int(time.time()),
        "lastMatchedAt": None,
        "matchCount": 0,
    }


@v1.delete("/watchlist/{person_id}")
def v1_delete_person(person_id: int, _: None = Depends(require_token)) -> dict:
    from face.watchlist import WatchlistDB

    db = WatchlistDB()
    try:
        cur = db._conn.execute("DELETE FROM watchlist WHERE id = ?", (person_id,))
        db._conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail=f"No watchlist entry {person_id}.")
    finally:
        db.close()
    return {"success": True, "id": person_id}


# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------

SETTINGS_FILE = "config/dashboard_settings.json"


def _load_settings_overrides() -> dict:
    if not os.path.exists(SETTINGS_FILE):
        return {}
    try:
        with open(SETTINGS_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_settings_overrides(data: dict) -> None:
    os.makedirs(os.path.dirname(SETTINGS_FILE) or ".", exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(data, f, indent=2)


def _effective_settings() -> dict:
    """.env values, with anything the dashboard has since overridden on top."""
    thresholds = {
        "redThreshold": YELLOW_MAX + 1,
        "yellowThreshold": GREEN_MAX + 1,
        "biometricThreshold": WATCHLIST_SIMILARITY_THRESHOLD,
        "reidThreshold": REID_SIMILARITY_THRESHOLD,
        "brightnessThreshold": BRIGHTNESS_THRESHOLD,
        "motionThreshold": MOTION_THRESHOLD,
        "lowFpsInterval": IDLE_MIN_FPS,
        "detectionConfidence": DETECTION_CONFIDENCE,
        "alertCooldownSeconds": ALERT_COOLDOWN_SECONDS,
        "motionSensitivity": "medium",
        "curfewBoost": True,
        "curfewHours": f"{CURFEW_START_HOUR:02d}:00-{CURFEW_END_HOUR:02d}:00",
    }
    integrations = {
        "capWebhookUrl": WEBHOOK_URL,
        "capEnabled": bool(WEBHOOK_URL),
        "gpioSirenRelay": False,
        "siemHost": SYSLOG_HOST,
        "siemPort": SYSLOG_PORT,
        "siemProtocol": "UDP",
        "siemEnabled": bool(SYSLOG_HOST),
    }
    saved = _load_settings_overrides()
    thresholds.update(saved.get("thresholds", {}))
    integrations.update(saved.get("integrations", {}))
    return {"thresholds": thresholds, "integrations": integrations}


@v1.get("/settings")
def v1_settings(_: None = Depends(require_token)) -> dict:
    return _effective_settings()


@v1.put("/settings/thresholds")
def v1_put_thresholds(body: dict = Body(...), _: None = Depends(require_token)) -> dict:
    """Persisted for the dashboard, but NOT hot-applied: app.py reads these
    from config.settings at import, so a running pipeline keeps its old
    values until restarted. Saving here without saying so would look like a
    threshold change that silently never took effect."""
    saved = _load_settings_overrides()
    saved["thresholds"] = {**saved.get("thresholds", {}), **body}
    _save_settings_overrides(saved)
    return _effective_settings()["thresholds"]


@v1.put("/settings/integrations")
def v1_put_integrations(body: dict = Body(...), _: None = Depends(require_token)) -> dict:
    saved = _load_settings_overrides()
    saved["integrations"] = {**saved.get("integrations", {}), **body}
    _save_settings_overrides(saved)
    return _effective_settings()["integrations"]



# --------------------------------------------------------------------------
# Incident actions, evidence, system health
# --------------------------------------------------------------------------


@v1.get("/meta")
def v1_meta(_: None = Depends(require_token)) -> dict:
    """Vocabularies the dashboard must not hardcode, because the backend
    validates against them."""
    return {
        "resolutionReasons": RESOLUTION_REASONS,
        # There's no single yellow/red threshold anymore - each zone tier has
        # its own sensitivity (see ZONE_TIER_THRESHOLDS). Keeping the flat
        # "yellow"/"red" pair too, as the GREEN-zone/no-zone values, so any
        # older reader expecting the old shape still gets a sane number.
        "tierThresholds": {"yellow": GREEN_MAX + 1, "red": YELLOW_MAX + 1},
        "tierThresholdsByZone": {
            zone: {"yellow": lo + 1, "red": hi + 1}
            for zone, (lo, hi) in ZONE_TIER_THRESHOLDS.items()
        },
        "cameraResolution": f"{CAMERA_WIDTH}x{CAMERA_HEIGHT}",
        "livePublishFps": runtime_state.LIVE_PUBLISH_FPS,
    }


@v1.post("/incidents/{incident_id}/resolve")
def v1_resolve(
    incident_id: int, body: dict = Body(...), _: None = Depends(require_token)
) -> dict:
    """Close an incident with a reason from RESOLUTION_REASONS. The reason is
    what turns operator workflow into a false-alarm dataset (cattle,
    vegetation...), so free text is refused rather than stored."""
    reason = str(body.get("reason", "")).strip()
    if reason not in RESOLUTION_REASONS:
        raise HTTPException(
            status_code=422,
            detail=f"reason must be one of {RESOLUTION_REASONS}",
        )
    store = IncidentStore()
    try:
        if store.get_incident(incident_id) is None:
            raise HTTPException(status_code=404, detail=f"No incident {incident_id}.")
        # Shared service token, no per-user identity to attribute this to.
        store.resolve(incident_id, operator="dashboard", reason=reason)
        row = store.get_incident(incident_id)
    finally:
        store.close()
    return _serialise(row)


@v1.get("/incidents/{incident_id}/evidence/{kind}")
@v1.get("/incidents/{incident_id}/evidence/{kind}/{index}")
def v1_evidence(
    incident_id: int,
    kind: str,
    index: int = 0,
    _: None = Depends(require_token_query),
):
    """Decrypts one evidence image and returns it as JPEG.

    Only paths recorded in the incident row are served, and only if they
    resolve inside the evidence directory — the id and index come from the
    URL, so nothing here may be allowed to walk to an arbitrary file.
    Token in the query string for the same reason as the MJPEG stream: an
    <img> tag cannot send an Authorization header.
    """
    if kind not in ("snapshot", "crop", "burst"):
        raise HTTPException(status_code=404, detail=f"Unknown evidence kind {kind!r}.")
    store = IncidentStore()
    try:
        row = store.get_incident(incident_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"No incident {incident_id}.")
        if kind == "snapshot":
            path = row.get("snapshot_path")
        elif kind == "crop":
            path = row.get("crop_path")
        else:
            try:
                bursts = json.loads(row.get("burst_paths") or "[]")
            except (TypeError, ValueError):
                bursts = []
            path = bursts[index] if isinstance(bursts, list) and 0 <= index < len(bursts) else None
        if not path:
            raise HTTPException(status_code=404, detail=f"No {kind} evidence was recorded for this incident.")
        root = os.path.realpath(store.evidence_dir)
        real = os.path.realpath(path)
        if not real.startswith(root + os.sep):
            raise HTTPException(status_code=404, detail="Evidence path is outside the evidence store.")
        try:
            data = store.decrypt_image_bytes(real)
        except FileNotFoundError:
            raise HTTPException(status_code=410, detail="Evidence file is no longer on disk.")
        except InvalidToken:
            raise HTTPException(
                status_code=409,
                detail="Evidence cannot be decrypted with the current database/evidence.key.",
            )
    finally:
        store.close()
    # private: it is surveillance evidence; cacheable because it never changes.
    return Response(content=data, media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=3600"})


_API_STARTED_AT = time.time()

try:
    import psutil

    psutil.cpu_percent(interval=None)  # prime it: the first sample is always 0.0
except ImportError:  # pragma: no cover - psutil ships with ultralytics
    psutil = None


def _file_info(path: str) -> dict:
    """Presence and size of a model file — or a model directory (InsightFace
    ships a folder of ONNX files), whose size is the sum of its files rather
    than the few bytes of the directory entry itself."""
    if os.path.isdir(path):
        total = 0
        for root, _dirs, files in os.walk(path):
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(root, name))
                except OSError:
                    pass
        return {"path": path, "present": total > 0, "sizeMb": round(total / 1e6, 1)}
    try:
        size = os.path.getsize(path)
    except OSError:
        return {"path": path, "present": False, "sizeMb": None}
    return {"path": path, "present": True, "sizeMb": round(size / 1e6, 1)}


def _incident_stats() -> dict:
    try:
        store = IncidentStore()
        try:
            total, open_, acked, resolved, open_red, open_yellow, last = store._conn.execute(
                "SELECT COUNT(*),"
                " SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END),"
                " SUM(CASE WHEN status = 'acknowledged' THEN 1 ELSE 0 END),"
                " SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END),"
                " SUM(CASE WHEN status = 'open' AND tier = 'red' THEN 1 ELSE 0 END),"
                " SUM(CASE WHEN status = 'open' AND tier = 'yellow' THEN 1 ELSE 0 END),"
                " MAX(timestamp) FROM incidents"
            ).fetchone()
        finally:
            store.close()
    except sqlite3.Error as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "total": total or 0,
        "open": open_ or 0,
        "acknowledged": acked or 0,
        "resolved": resolved or 0,
        "openRed": open_red or 0,
        "openYellow": open_yellow or 0,
        "lastIncidentAt": last,
    }


def _watchlist_count() -> "int | None":
    # Read-only and bypassing WatchlistDB on purpose: constructing it creates
    # an encryption key on a fresh install, and a health check must not have
    # side effects.
    path = "database/watchlist.db"
    if not os.path.exists(path):
        return 0
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            return conn.execute("SELECT COUNT(*) FROM watchlist").fetchone()[0]
        finally:
            conn.close()
    except sqlite3.Error:
        return None


def _evidence_stats(evidence_dir: str = "snapshots") -> dict:
    files = 0
    size = 0
    try:
        with os.scandir(evidence_dir) as it:
            for entry in it:
                if entry.is_file():
                    files += 1
                    size += entry.stat().st_size
    except OSError:
        pass
    return {"dir": evidence_dir, "files": files, "sizeMb": round(size / 1e6, 1)}


@v1.get("/system/health")
def v1_system_health(_: None = Depends(require_token)) -> dict:
    """Everything an operator needs to know is working, measured rather than
    assumed. Replaces the dashboard's hardcoded telemetry (a fixed 42% GPU on
    a Jetson this system does not run on) and the old /status, which only
    ever proved the API process was alive."""
    pipeline = runtime_state.read_health()
    running = bool(pipeline and pipeline.get("running"))
    cams = (pipeline or {}).get("cameras") or {}

    if not running:
        overall = "pipeline-stopped"
    elif any((c or {}).get("health") != "online" for c in cams.values()):
        overall = "degraded"
    else:
        overall = "ok"

    pipeline_out = {
        "running": running,
        "detail": (
            None if running else
            "The AI pipeline is not running, so no detections are being scored and "
            "no incidents recorded. Start it with ./run.sh."
        ),
    }
    if pipeline:
        pipeline_out.update({
            "pid": pipeline.get("pid"),
            "startedAt": pipeline.get("startedAt"),
            "updatedAt": pipeline.get("updatedAt"),
            "ageSeconds": pipeline.get("ageSeconds"),
            "cameras": cams if running else {},
            "models": pipeline.get("models"),
        })
        if running and psutil is not None:
            try:
                pipeline_out["rssMb"] = round(psutil.Process(pipeline["pid"]).memory_info().rss / 1e6)
            except (psutil.Error, KeyError, TypeError):
                pass

    host = None
    if psutil is not None:
        vm = psutil.virtual_memory()
        host = {
            "cpuPercent": psutil.cpu_percent(interval=0.1),
            "cpuCount": psutil.cpu_count(),
            "memoryPercent": vm.percent,
            "memoryUsedGb": round((vm.total - vm.available) / 1e9, 1),
            "memoryTotalGb": round(vm.total / 1e9, 1),
            "apiRssMb": round(psutil.Process().memory_info().rss / 1e6),
            # GPU utilisation is not reported: nothing in this stack exposes
            # it portably, and a made-up number is worse than none.
            "gpuPercent": None,
        }
    disk = shutil.disk_usage(".")
    hub = globals().get("_hub")
    return {
        "status": overall,
        "checkedAt": time.time(),
        "api": {
            "status": "ok",
            "startedAt": _API_STARTED_AT,
            "uptimeSeconds": round(time.time() - _API_STARTED_AT),
            "websocketClients": len(hub._clients) if hub is not None else 0,
        },
        "pipeline": pipeline_out,
        "database": _incident_stats(),
        "evidence": _evidence_stats(),
        "disk": {
            "freeGb": round(disk.free / 1e9, 1),
            "totalGb": round(disk.total / 1e9, 1),
            "percentUsed": round(100 * (disk.total - disk.free) / disk.total, 1),
        },
        "host": host,
        "models": {
            "detector": _file_info(DETECTION_MODEL_PATH),
            "reid": _file_info(REID_MODEL_PATH),
            "face": _file_info(os.path.expanduser("~/.insightface/models/buffalo_s")),
        },
        "zones": {cam_id: _zone_count(cam_id) for cam_id in _camera_sources()},
        "watchlist": {"enrolled": _watchlist_count()},
    }


@v1.post("/integrations/test")
def v1_integrations_test(_: None = Depends(require_token)) -> dict:
    """Actually exercises the configured outputs, replacing a button that
    always reported "HTTP 200 OK · 24.2 ms" without sending anything.

    Tests the values the dashboard shows (.env plus dashboard overrides). The
    running pipeline read .env at startup, so an override saved here reaches
    the pipeline only after a restart — the response says which values were
    tested.
    """
    import logging.handlers

    import requests

    from integration.syslog_notifier import _build_handler

    eff = _effective_settings()["integrations"]
    results: dict = {}

    url = (eff.get("capWebhookUrl") or "").strip()
    if not url:
        results["webhook"] = {"ok": False, "detail": "No webhook URL is configured."}
    else:
        started = time.perf_counter()
        try:
            resp = requests.post(
                url,
                json={"type": "ibvap.diagnostic", "sentAt": time.time()},
                timeout=3,
            )
            results["webhook"] = {
                "ok": resp.ok,
                "status": resp.status_code,
                "latencyMs": round((time.perf_counter() - started) * 1000, 1),
                "url": url,
            }
        except requests.RequestException as exc:
            results["webhook"] = {
                "ok": False,
                "detail": f"{type(exc).__name__}: {exc}"[:240],
                "url": url,
            }

    host = (eff.get("siemHost") or "").strip()
    if not eff.get("siemEnabled") or not host:
        results["syslog"] = {"ok": False, "detail": "Syslog output is not configured."}
    else:
        # A throwaway handler, not SyslogNotifier: its constructor attaches a
        # handler to a module-level logger, so one per click would leak
        # handlers and duplicate every later alert.
        handler = None
        try:
            handler = _build_handler(host, int(eff.get("siemPort") or 514))
            if handler is None:
                raise OSError("syslog handler could not be created")
            handler.emit(logging.makeLogRecord({
                "msg": "IBVAP diagnostic test message", "levelno": logging.INFO,
                "levelname": "INFO", "name": "ibvap.diagnostic",
            }))
            results["syslog"] = {
                "ok": True,
                "detail": (
                    f"Sent to {host}:{eff.get('siemPort')} over UDP. UDP has no "
                    "acknowledgement, so delivery cannot be confirmed from here."
                ),
            }
        except (OSError, ValueError) as exc:
            results["syslog"] = {"ok": False, "detail": f"{type(exc).__name__}: {exc}"[:240]}
        finally:
            if handler is not None:
                handler.close()
    return results


app.include_router(v1)


# --------------------------------------------------------------------------
# Live alerts over WebSocket
# --------------------------------------------------------------------------

# The pipeline (app.py) and this API are separate processes that share no
# memory — only database/incidents.db. So rather than app.py pushing to us,
# this polls the table for rows newer than the last one broadcast. That means
# alerts reach the dashboard no matter who wrote them (app.py, a test, an
# import), with no change to the pipeline, at the cost of up to POLL_SECONDS
# of latency.
ALERT_POLL_SECONDS = 1.5
ALERT_HEARTBEAT_SECONDS = 20.0


class _AlertHub:
    def __init__(self) -> None:
        self._clients: set = set()
        self._task = None
        self._last_id = None

    async def register(self, ws) -> None:
        self._clients.add(ws)
        if self._task is None:
            # Start from the newest existing row so a freshly opened dashboard
            # does not get every historical incident replayed at it as if
            # thousands of alerts had just fired.
            self._last_id = await asyncio.to_thread(self._max_id)
            self._task = asyncio.create_task(self._run())

    async def unregister(self, ws) -> None:
        self._clients.discard(ws)
        if not self._clients and self._task is not None:
            self._task.cancel()
            self._task = None

    @staticmethod
    def _max_id() -> int:
        store = IncidentStore()
        try:
            rows = store.list_incidents(limit=1)
            return rows[0]["id"] if rows else 0
        finally:
            store.close()

    @staticmethod
    def _newer_than(last_id: int) -> list:
        store = IncidentStore()
        try:
            # list_incidents is newest-first; 50 is a generous ceiling for one
            # 1.5s window and stops a long stall from dumping the whole table.
            rows = store.list_incidents(limit=50)
        finally:
            store.close()
        fresh = [r for r in rows if r["id"] > last_id]
        return sorted(fresh, key=lambda r: r["id"])

    async def _run(self) -> None:
        last_beat = time.monotonic()
        while True:
            await asyncio.sleep(ALERT_POLL_SECONDS)
            try:
                rows = await asyncio.to_thread(self._newer_than, self._last_id)
                for row in rows:
                    self._last_id = row["id"]
                    await self._broadcast({"type": "alert", "payload": _serialise(row)})
                if time.monotonic() - last_beat > ALERT_HEARTBEAT_SECONDS:
                    last_beat = time.monotonic()
                    # The client ignores frames it cannot read as an alert;
                    # this exists to keep intermediaries from idling us out.
                    await self._broadcast({"type": "heartbeat"})
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("alert poller failed; continuing")

    async def _broadcast(self, message: dict) -> None:
        dead = []
        for ws in list(self._clients):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients.discard(ws)


_hub = _AlertHub()


@app.websocket("/ws/alerts")
async def ws_alerts(websocket: WebSocket) -> None:
    """Pushes each new incident as {type: "alert", payload: Incident}.

    Auth is ?token= for the same reason the MJPEG route uses it: a browser
    WebSocket cannot set an Authorization header. Rejected before accept()
    so an unauthorised client gets a handshake failure, not an open socket.
    """
    token = websocket.query_params.get("token", "")
    if not IBVAP_API_TOKEN or not hmac.compare_digest(token, IBVAP_API_TOKEN):
        await websocket.close(code=1008)
        return

    await websocket.accept()
    await _hub.register(websocket)
    try:
        while True:
            # Nothing is expected from the client; this is here to observe the
            # disconnect. receive_text() raises WebSocketDisconnect on close.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("alert websocket closed unexpectedly")
    finally:
        await _hub.unregister(websocket)
