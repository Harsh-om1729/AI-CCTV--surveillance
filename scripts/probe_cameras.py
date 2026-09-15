"""Quick pre-flight check for camera sources — run this before app.py.

    python scripts/probe_cameras.py 0 rtsp://192.168.1.46:8080/h264_ulaw.sdp
    python scripts/probe_cameras.py            # probes webcam indices 0-3

Opens each source, grabs a few frames and reports resolution/FPS, so a bad
RTSP URL or a wrong webcam index is diagnosed here instead of looking like a
pipeline failure. Uses the same CameraSource wrapper the app does.
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Must be set BEFORE cv2 is imported — OpenCV reads it when it initialises
# its FFmpeg backend, not per-capture. Without it an unreachable RTSP URL
# blocks for FFmpeg's 30s default before reporting the failure. "timeout" is
# the current option name, "stimeout" the pre-5.0 one; both are passed so the
# limit applies whichever FFmpeg the local OpenCV wheel was built against.
# TCP transport matches app.py, so the probe measures what the app will get.
os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "rtsp_transport;tcp|timeout;5000000|stimeout;5000000",
)

import cv2  # noqa: E402

WARMUP_FRAMES = 10


def probe(source) -> bool:
    label = f"{source!r}"
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        print(f"  FAIL  {label}: could not open")
        return False

    # A live RTSP feed commonly drops its first reads while the H.264 decoder
    # waits for a keyframe, so judge on several attempts, not the first one.
    got = 0
    last_good = None
    started = time.perf_counter()
    for _ in range(WARMUP_FRAMES):
        ok, frame = cap.read()
        if ok and frame is not None:
            got += 1
            last_good = frame
    elapsed = time.perf_counter() - started

    if got == 0:
        print(f"  FAIL  {label}: opened but returned no frames in {WARMUP_FRAMES} reads")
        cap.release()
        return False

    h, w = last_good.shape[:2]
    reported = cap.get(cv2.CAP_PROP_FPS)
    measured = got / elapsed if elapsed > 0 else 0.0
    print(
        f"  OK    {label}: {w}x{h}, {got}/{WARMUP_FRAMES} frames, "
        f"~{measured:.1f} fps measured (reports {reported:.1f})"
    )
    cap.release()
    return True


def main() -> None:
    args = sys.argv[1:]
    sources = [int(a) if a.isdigit() else a for a in args] if args else list(range(4))
    if not args:
        print("No sources given — scanning webcam indices 0-3.\n")

    working = [s for s in sources if probe(s)]
    print(f"\n{len(working)}/{len(sources)} source(s) usable.")
    if len(working) >= 2:
        joined = " ".join(str(s) for s in working)
        # run.sh sits beside the ibvap/ package, not inside it, so print a
        # path that works from the ibvap/ dir this script is normally run from.
        run_sh = os.path.join(os.path.dirname(__file__), "..", "..", "run.sh")
        print(f"Launch multi-camera with:\n  {os.path.normpath(run_sh)} app {joined}")


if __name__ == "__main__":
    main()
