import logging
import time

log = logging.getLogger("ibvap.tracking")


class TrackHistory:
    """Keeps the last `history_len` box centers per track_id and derives the
    direction vector + per-frame speed that feed the zone engine and the
    kinematics score.

    Split out of `Tracker` so this bookkeeping (which is what grows without
    bound) can be unit-tested on its own, without loading a YOLO model.

    ByteTrack mints a brand-new track_id every time it loses and re-acquires a
    target, so a long-running deployment sees an unbounded number of distinct
    ids. Entries whose track has not been updated for `ttl_seconds` are
    dropped - the same TTL idea the Re-ID gallery already uses to retire
    people who have disappeared - which bounds the dict to the tracks actually
    seen within that window while leaving every active track's history intact.
    """

    def __init__(
        self, history_len: int = 10, ttl_seconds: float = 30.0, now_fn=time.time,
        speed_smoothing_alpha: float = 0.3,
    ):
        self.history_len = history_len
        self.ttl_seconds = ttl_seconds
        self._now = now_fn
        self.speed_smoothing_alpha = speed_smoothing_alpha
        self._history: dict[int, list[tuple[float, float]]] = {}
        self._last_seen: dict[int, float] = {}
        self._speed_ema: dict[int, float] = {}

    def update(self, track_id: int, center: tuple[float, float]):
        """Records `center` for `track_id`, returning its (direction, speed).

        Speed is EMA-smoothed per track (not direction) before being
        returned. The "stationary" vs "walking" boundary in the kinematics
        U-curve (threat_rules.py) is only ~1px/frame wide, and ordinary
        detection-box jitter on a person standing still is easily that
        large - so the raw per-call speed flips across it frame to frame,
        swinging kinematics_risk between 0 and max and flickering the
        displayed tier green/yellow/red for someone who never actually
        moved. Smoothing here (once, at the source) fixes every downstream
        consumer (kinematics score, running override) without touching the
        U-curve thresholds themselves.
        """
        history = self._history.setdefault(track_id, [])
        history.append(center)
        if len(history) > self.history_len:
            history.pop(0)
        self._last_seen[track_id] = self._now()
        direction, raw_speed = self.compute_direction_and_speed(history)
        if direction is None:
            return direction, raw_speed
        prev = self._speed_ema.get(track_id)
        smoothed = raw_speed if prev is None else prev + self.speed_smoothing_alpha * (raw_speed - prev)
        self._speed_ema[track_id] = smoothed
        return direction, smoothed

    def purge_stale(self, now: float | None = None) -> int:
        """Drops tracks not updated within the TTL; returns how many went.

        A track that briefly disappears and comes back inside the TTL keeps
        its history untouched, so direction/speed continue uninterrupted.
        """
        now = self._now() if now is None else now
        stale = [tid for tid, seen in self._last_seen.items() if now - seen > self.ttl_seconds]
        for track_id in stale:
            self._history.pop(track_id, None)
            self._last_seen.pop(track_id, None)
            self._speed_ema.pop(track_id, None)
        if stale:
            log.debug("Dropped history for %d stale track(s)", len(stale))
        return len(stale)

    def history_for(self, track_id: int) -> list[tuple[float, float]]:
        """A copy of the recorded centers for `track_id` (empty if unknown)."""
        return list(self._history.get(track_id, []))

    def __len__(self) -> int:
        return len(self._history)

    @staticmethod
    def compute_direction_and_speed(history: list[tuple[float, float]]):
        if len(history) < 2:
            return None, 0.0
        (x1, y1), (x2, y2) = history[0], history[-1]
        direction = (x2 - x1, y2 - y1)
        elapsed_frames = len(history) - 1
        speed = (direction[0] ** 2 + direction[1] ** 2) ** 0.5 / elapsed_frames
        return direction, speed
