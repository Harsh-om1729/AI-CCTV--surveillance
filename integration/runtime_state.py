"""Phase 20 — the pipeline's live state, published for the dashboard.

app.py (the AI pipeline) and integration/api.py (the dashboard backend) are
separate processes, and a webcam can be held by only one of them. Before this
module the dashboard had to choose: open the camera itself for a preview (no
threat scoring, no incidents recorded) or leave it to the pipeline and show
nothing live. An operator needs both at once.

So the pipeline — the only process that runs the full model — publishes what
it already computes:

  runtime/live/<camera>.jpg        the latest annotated frame (boxes, zones,
                                   threat overlay), rewritten at up to
                                   LIVE_PUBLISH_FPS
  runtime/pipeline_health.json     per-camera health, fps, activity-gate and
                                   low-light state, zone counts, model paths

and the API serves those instead of competing for the device. Every write is
atomic (write a temp file, then os.replace), so a reader never sees a torn
JPEG or half a JSON document.
"""

import json
import logging
import os
import re
import time

import cv2

log = logging.getLogger("ibvap.runtime")

RUNTIME_DIR = os.getenv("IBVAP_RUNTIME_DIR", "runtime")
HEALTH_FILE = "pipeline_health.json"
FRAME_SUBDIR = "live"

# The pipeline rewrites health about once a second. Older than this and it is
# treated as not running — long enough to ride out one slow frame, short
# enough that the dashboard stops showing a crashed pipeline as live.
HEALTH_STALE_SECONDS = 5.0

# Dashboard frame rate, not pipeline frame rate: the pipeline still processes
# every frame it would have; this only caps how often a JPEG hits the disk.
LIVE_PUBLISH_FPS = float(os.getenv("IBVAP_LIVE_PUBLISH_FPS", "12"))
LIVE_JPEG_QUALITY = 70

# Camera names become file names. They come from .env or from the dashboard's
# add-camera form, and the API resolves them from a URL path segment, so
# anything outside this set is refused rather than allowed near a path join.
_SAFE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _check_name(camera: str) -> str:
    if not _SAFE_NAME.match(camera or ""):
        raise ValueError(f"unsafe camera name for a runtime file: {camera!r}")
    return camera


def _dir(runtime_dir: "str | None") -> str:
    return runtime_dir or RUNTIME_DIR


def health_path(runtime_dir: "str | None" = None) -> str:
    return os.path.join(_dir(runtime_dir), HEALTH_FILE)


def frame_path(camera: str, runtime_dir: "str | None" = None) -> str:
    return os.path.join(_dir(runtime_dir), FRAME_SUBDIR, f"{_check_name(camera)}.jpg")


def _atomic_write(path: str, data: bytes) -> None:
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


class PipelinePublisher:
    """Used by app.py. Cheap enough to call on every processed frame: the
    per-camera rate limit is checked before any encoding happens."""

    def __init__(self, runtime_dir: "str | None" = None, max_fps: float = LIVE_PUBLISH_FPS):
        runtime_dir = _dir(runtime_dir)
        self.runtime_dir = runtime_dir
        os.makedirs(os.path.join(runtime_dir, FRAME_SUBDIR), exist_ok=True)
        self._min_interval = 1.0 / max_fps if max_fps > 0 else 0.0
        self._last_frame_at: dict = {}
        self.started_at = time.time()

    def publish_frame(self, camera: str, frame) -> bool:
        now = time.monotonic()
        if now - self._last_frame_at.get(camera, float("-inf")) < self._min_interval:
            return False
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), LIVE_JPEG_QUALITY])
        if not ok:
            return False
        try:
            _atomic_write(frame_path(camera, self.runtime_dir), buf.tobytes())
        except (OSError, ValueError) as exc:
            # Never let the dashboard feed break the pipeline: a full disk or a
            # bad camera name costs the preview, not detection or alerting.
            log.debug("could not publish live frame for %s: %s", camera, exc)
            return False
        self._last_frame_at[camera] = now
        return True

    def publish_health(self, state: dict) -> None:
        payload = {
            "pid": os.getpid(),
            "startedAt": self.started_at,
            "updatedAt": time.time(),
            **state,
        }
        try:
            _atomic_write(health_path(self.runtime_dir), json.dumps(payload).encode("utf-8"))
        except OSError as exc:
            log.debug("could not publish pipeline health: %s", exc)

    def close(self) -> None:
        """Removes the health file on a clean exit, so the dashboard shows the
        pipeline as stopped immediately instead of after HEALTH_STALE_SECONDS."""
        try:
            os.remove(health_path(self.runtime_dir))
        except OSError:
            pass


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def read_health(runtime_dir: "str | None" = None) -> "dict | None":
    """Used by the API. None when the pipeline has never published; otherwise
    the last snapshot plus `running` and `ageSeconds`.

    `running` relies on a fresh timestamp (updated every second) AND that the
    publishing PID is still alive. If the pipeline is SIGKILLed, the dashboard
    immediately falls back rather than showing a frozen frame.
    """
    try:
        with open(health_path(runtime_dir)) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    age = time.time() - float(data.get("updatedAt") or 0)
    data["ageSeconds"] = round(age, 1)
    running = age <= HEALTH_STALE_SECONDS
    pid = data.get("pid")
    if pid is not None:
        try:
            if not _pid_alive(int(pid)):
                running = False
        except (ValueError, TypeError):
            pass
    data["running"] = running
    return data

