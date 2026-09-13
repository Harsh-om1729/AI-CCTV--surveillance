import logging
import math
import os
import re
import time
import numpy as np

# Ensure FFmpeg uses TCP and 5s timeout before cv2 is imported
os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "rtsp_transport;tcp|timeout;5000000|stimeout;5000000",
)

import cv2

log = logging.getLogger("ibvap.camera")

_URL_CREDENTIALS = re.compile(r"//[^/@\s]*:[^/@\s]*@")


def redact_source(source) -> str:
    """A log-safe rendering of a camera source, with any embedded
    `user:password@` credentials masked out."""
    return _URL_CREDENTIALS.sub("//***:***@", str(source))


def normalize_source(source: int | str) -> int | str:
    """Auto-corrects common typos like rtsp:ip:port -> rtsp://ip:port."""
    if isinstance(source, int):
        return source
    src = str(source).strip()
    if src.isdigit():
        return int(src)
    # Fix single colon without double slash
    if src.startswith("rtsp:") and not src.startswith("rtsp://"):
        src = "rtsp://" + src[5:].lstrip("/")
    elif src.startswith("http:") and not src.startswith("http://"):
        src = "http://" + src[5:].lstrip("/")
    elif src.startswith("https:") and not src.startswith("https://"):
        src = "https://" + src[6:].lstrip("/")
    return src


class CameraSource:
    """Wraps a single camera feed: a USB index (0, 1, ...), an RTSP/ONVIF URL,
    a local video file path, or a simulated border feed.
    """

    def __init__(self, source: int | str, width: int = 640, height: int = 480):
        self.source = normalize_source(source)
        self.width = width
        self.height = height
        self.is_file = isinstance(self.source, str) and os.path.isfile(self.source)
        self.is_simulated = str(self.source).lower() in ("simulated", "demo", "mock", "virtual")
        self.cap: cv2.VideoCapture | None = None
        self._sim_frame_count = 0

    def open(self) -> None:
        self.release()
        self.source = normalize_source(self.source)
        if str(self.source).lower() in ("simulated", "demo", "mock", "virtual"):
            self.is_simulated = True
            log.info("Camera opened in simulated border surveillance mode: %s (%dx%d)", self.source, self.width, self.height)
            return

        self.is_simulated = False
        is_url = isinstance(self.source, str) and ("://" in self.source)
        backend = cv2.CAP_FFMPEG if is_url else cv2.CAP_ANY

        cap = cv2.VideoCapture(self.source, backend)
        if not cap.isOpened():
            cap.release()
            raise RuntimeError(f"Could not open camera source: {redact_source(self.source)}")

        if is_url:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        self.cap = cap
        log.info(
            "Camera opened: %s (requested %dx%d)", redact_source(self.source), self.width, self.height
        )

    def is_open(self) -> bool:
        if self.is_simulated:
            return True
        return self.cap is not None and self.cap.isOpened()

    def native_fps(self) -> float:
        if self.cap is None:
            return 30.0
        fps = self.cap.get(cv2.CAP_PROP_FPS)
        return fps if fps and fps > 0 else 30.0

    def read(self):
        """Returns the next frame, or None if the capture is closed, gave no
        frame, or handed back an empty/invalid one. Never raises: a dropped
        RTSP stream can surface as an OpenCV exception rather than `ok=False`,
        and the caller's recovery path is the same either way."""
        if self.is_simulated:
            self._sim_frame_count += 1
            t = self._sim_frame_count * 0.04
            frame = np.full((self.height, self.width, 3), (35, 40, 45), dtype=np.uint8)
            overlay = frame.copy()
            cv2.rectangle(overlay, (0, 0), (self.width, self.height // 3), (0, 0, 180), -1)
            cv2.rectangle(overlay, (0, self.height // 3), (self.width, 2 * self.height // 3), (0, 180, 200), -1)
            cv2.rectangle(overlay, (0, 2 * self.height // 3), (self.width, self.height), (0, 150, 0), -1)
            cv2.addWeighted(overlay, 0.22, frame, 0.78, 0, frame)
            cv2.line(frame, (0, self.height // 3), (self.width, self.height // 3), (0, 0, 255), 2)
            cv2.line(frame, (0, 2 * self.height // 3), (self.width, 2 * self.height // 3), (0, 255, 255), 2)
            py = int((self.height * 0.75) - (abs(math.sin(t * 0.35)) * (self.height * 0.55)))
            px = int((self.width * 0.45) + (math.cos(t * 0.25) * (self.width * 0.2)))
            cv2.rectangle(frame, (px - 22, py - 55), (px + 22, py), (210, 210, 210), 2)
            cv2.circle(frame, (px, py - 42), 10, (230, 230, 230), -1)
            cv2.putText(frame, "LIVE SURVEILLANCE FEED", (20, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 2)
            cv2.putText(frame, time.strftime("%H:%M:%S"), (self.width - 110, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
            return frame

        cap = self.cap
        if cap is None:
            return None
        try:
            ok, frame = cap.read()
            if not ok or frame is None or getattr(frame, "size", 0) == 0:
                return None

            # Resize on the measured size, not on is_file. cap.set(WIDTH/HEIGHT)
            # is honored only by local capture devices — it is a silent no-op
            # for video files AND for network streams, because an RTSP sender
            # picks its own resolution. Gating on is_file therefore misses
            # RTSP entirely: a phone pushing 1080p drove every downstream
            # stage at 6.75x the configured pixel budget (the temporal median
            # filter alone stacks 5 frames, ~31MB at 1080p). Comparing the
            # actual size covers all three source types and costs one tuple
            # compare when the camera already gave us what we asked for.
            h, w = frame.shape[:2]
            if (w, h) != (self.width, self.height):
                frame = cv2.resize(frame, (self.width, self.height))
            return frame
        except Exception as e:
            # Logged at debug only: the caller (CameraStream) reports the
            # failure once, at warning level, with backoff — logging it here
            # too would produce a message per dropped frame.
            log.debug("Read failed on camera %s: %s: %s", redact_source(self.source), type(e).__name__, e)
            return None

    def rewind(self) -> bool:
        """Seeks a video-file source back to its first frame (used to loop
        recorded footage). False if there is no capture or the backend
        refused the seek, in which case the caller should treat it as a
        broken source rather than retrying forever."""
        cap = self.cap
        if cap is None:
            return False
        try:
            return bool(cap.set(cv2.CAP_PROP_POS_FRAMES, 0))
        except Exception as e:
            log.debug("Rewind failed on camera %s: %s: %s", redact_source(self.source), type(e).__name__, e)
            return False

    def release(self) -> None:
        # Clear the attribute first: another thread reading `self.cap`
        # concurrently gets None rather than a handle that is being released.
        cap, self.cap = self.cap, None
        if cap is None:
            return
        try:
            cap.release()
        except Exception as e:
            log.warning(
                "Error releasing camera %s: %s: %s", redact_source(self.source), type(e).__name__, e
            )
        else:
            log.info("Camera released: %s", redact_source(self.source))
