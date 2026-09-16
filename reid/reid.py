import logging
import time
from typing import Callable, Hashable

import numpy as np

log = logging.getLogger("ibvap.reid")


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0.0:
        return 0.0
    return float(np.dot(a, b) / denom)


def l2_normalize(v: np.ndarray) -> np.ndarray:
    """Unit-length copy of `v` (unchanged if it is the zero vector).

    Cosine similarity ignores magnitude, but *averaging* does not: a mean over
    raw embeddings is dominated by whichever samples happened to have the
    largest norm (a brighter, larger, or closer crop), so the reference drifts
    toward those instead of representing the person. Normalizing before every
    mean and every moving-average update makes each sample count equally.
    """
    norm = float(np.linalg.norm(v))
    if norm == 0.0:
        return v
    return v / norm


class PersonGallery:
    """Resolves a track's churning identity to a stable `person_id`.

    ByteTrack only matches detections frame-to-frame by motion/position, so a
    person who leaves the frame (or is occluded) longer than its track buffer
    gets a brand new track_id on return. This gallery closes that gap using
    an appearance embedding (`embed_fn`, e.g. the OSNet Re-ID extractor):
    a close-enough match to a recently-disappeared person reuses their id
    instead of minting a new one.

    A single shared instance also gives cross-camera Re-ID (Phase 15): pass a
    `track_key` that's unique per camera (e.g. `(camera_name, track_id)`, not
    a raw track_id) when the same gallery serves multiple cameras — otherwise
    two different cameras' ByteTrack instances could coincidentally produce
    the same numeric track_id and wrongly merge unrelated people.

    A new track_key's identity is decided from the *average* of its first
    `min_samples` embeddings (not a single frame) to cancel out noise from
    partial/edge-clipped boxes or momentary motion blur — `resolve()` returns
    None for those first few calls while samples are still being collected.

    Once resolved, each person is represented by a small *bank* of up to
    `bank_size` template embeddings (most recent wins, FIFO) rather than one
    running average. A single blended vector washes out exactly the
    variation that matters for cross-camera matching — a different camera's
    angle/lighting/distance moves the same person's embedding to a different
    point in feature space, and averaging it into one earlier-camera-biased
    vector can push the blend below `similarity_threshold` even though the
    person hasn't changed. Matching a new embedding against the *best* of
    several stored templates (one of which may already be from a similar
    angle/lighting) is what real Re-ID systems do for exactly this reason,
    and is far more forgiving of that variation than one shared average.
    """

    def __init__(
        self,
        embed_fn: Callable[[np.ndarray, tuple], "np.ndarray | None"],
        similarity_threshold: float = 0.7,
        ttl_seconds: float = 30.0,
        min_samples: int = 3,
        bank_size: int = 5,
        match_margin: float = 0.05,
        live_window_seconds: float = 1.0,
        min_box_size: tuple = (40, 60),
        now_fn: Callable[[], float] = time.time,
    ):
        self.embed_fn = embed_fn
        self.similarity_threshold = similarity_threshold
        self.ttl_seconds = ttl_seconds
        self.min_samples = min_samples
        self.bank_size = bank_size
        self.match_margin = match_margin
        self.live_window_seconds = live_window_seconds
        self.min_box_width, self.min_box_height = min_box_size
        self._now = now_fn
        self._next_person_id = 1
        # person_id -> {"embeddings": list[np.ndarray] (<= bank_size, FIFO),
        # "last_seen": float, "last_camera": str | None}
        self._gallery: dict[int, dict] = {}
        # track_key -> {"person_id": int, "last_seen": float}, once resolved
        self._track_to_person: dict[Hashable, dict] = {}
        # track_key -> {"samples": list[np.ndarray], "last_seen": float}, while
        # still buffering. Dropped once the track resolves - or, if the track
        # disappears before ever reaching min_samples, evicted by the same TTL
        # that retires disappeared people from the gallery, so short-lived
        # tracks cannot leave their embeddings buffered forever.
        self._pending: dict[Hashable, dict] = {}

    @staticmethod
    def _camera_of(track_key: Hashable) -> "str | None":
        """Camera name out of a `(camera_name, track_id)` track_key, or None
        for the plain-track_id form some single-camera callers/tests use."""
        return track_key[0] if isinstance(track_key, tuple) else None

    def _add_template(self, entry: dict, embedding: np.ndarray) -> None:
        bank = entry["embeddings"]
        bank.append(embedding)
        if len(bank) > self.bank_size:
            del bank[0]

    def _best_similarity(self, embedding: np.ndarray, entry: dict) -> float:
        return max(cosine_similarity(embedding, template) for template in entry["embeddings"])

    def resolve(self, track_key: Hashable, frame: np.ndarray, box: tuple) -> "int | None":
        now = self._now()

        resolved = self._track_to_person.get(track_key)
        if resolved is not None:
            person_id = resolved["person_id"]
            entry = self._gallery.get(person_id)
            if entry is None:
                # The gallery entry expired while this track was still alive —
                # possible because a track's last_seen refreshes every frame but
                # its gallery entry's only refreshes on a frame that produced an
                # embedding (a long run of too-small boxes produces none). Drop
                # the dangling binding and re-identify from scratch rather than
                # indexing into a purged entry.
                del self._track_to_person[track_key]
            else:
                resolved["last_seen"] = now
                embedding = self._embed(frame, box)
                if embedding is not None:
                    # Add as another template rather than blending into one
                    # running average — see the class docstring. This is also
                    # what lets a person's bank pick up a second camera's
                    # look over time instead of staying anchored to the first.
                    self._add_template(entry, embedding)
                    entry["last_seen"] = now
                    entry["last_camera"] = self._camera_of(track_key)
                self._purge_stale(now)
                return person_id

        embedding = self._embed(frame, box)
        if embedding is None:
            self._purge_stale(now)
            return None  # box too small/clipped to contribute a sample yet

        pending = self._pending.setdefault(track_key, {"samples": [], "last_seen": now})
        pending["samples"].append(embedding)
        pending["last_seen"] = now
        if len(pending["samples"]) < self.min_samples:
            # Purged here too: a stream of tracks that never reach min_samples
            # would otherwise never reach a purge call at all.
            self._purge_stale(now)
            return None  # still buffering — decide once we have enough samples

        raw_samples = pending["samples"]
        mean_embedding = l2_normalize(np.mean(raw_samples, axis=0))
        del self._pending[track_key]

        # The mean of the buffered samples is what decides MATCH-vs-CREATE
        # (min_samples exists specifically to cancel single-frame noise for
        # that decision) — but once decided, the bank is seeded with the
        # individual raw samples, not just their mean. Three samples of the
        # same brief appearance are still one camera/angle/lighting, so this
        # alone doesn't fix cross-camera matching by itself — but it means a
        # newly-created identity starts with real observed variation (pose
        # across those few frames) in its bank from frame one, instead of a
        # single denoised vector, without waiting on a REID_FACE_CHECK_INTERVAL
        # recheck to ever add a second template.
        person_id = self._match_or_create(mean_embedding, now, track_key)
        camera = self._camera_of(track_key)
        entry = self._gallery.get(person_id)
        if entry is None:
            self._gallery[person_id] = entry = {
                "embeddings": [],
                "last_seen": now,
                "last_camera": camera,
            }
        for sample in raw_samples:
            self._add_template(entry, sample)
        entry["last_seen"] = now
        entry["last_camera"] = camera
        self._track_to_person[track_key] = {"person_id": person_id, "last_seen": now}
        self._purge_stale(now)
        return person_id

    def last_camera(self, person_id: int) -> "str | None":
        """Which camera most recently produced a template for this identity —
        the "Last Camera" field of the cross-camera identity view."""
        entry = self._gallery.get(person_id)
        return entry["last_camera"] if entry is not None else None

    def _embed(self, frame: np.ndarray, box: tuple):
        x1, y1, x2, y2 = box
        if (x2 - x1) < self.min_box_width or (y2 - y1) < self.min_box_height:
            return None
        embedding = self.embed_fn(frame, box)
        if embedding is None:
            return None
        return l2_normalize(embedding)

    def _match_or_create(self, embedding: np.ndarray, now: float, track_key: Hashable) -> int:
        # Every branch below logs through this one line so a cross-camera
        # miss and a genuine new person are never ambiguous from the logs —
        # camera, local track id, best candidate (if any), its similarity,
        # the threshold in force, and the outcome are always all present.
        camera = self._camera_of(track_key)
        local_id = track_key[1] if isinstance(track_key, tuple) else track_key

        def _log(outcome: str, person_id: "int | None", similarity: "float | None", detail: str = "") -> None:
            log.info(
                "Re-ID [camera=%s local_track=%s]: candidate=%s similarity=%s "
                "threshold=%.2f -> %s%s",
                camera, local_id,
                f"#{person_id}" if person_id is not None else "none",
                f"{similarity:.2f}" if similarity is not None else "n/a",
                self.similarity_threshold, outcome,
                f" ({detail})" if detail else "",
            )

        claimed = self._live_person_ids(now)

        scored = []
        for person_id, entry in self._gallery.items():
            if now - entry["last_seen"] > self.ttl_seconds:
                continue
            scored.append((self._best_similarity(embedding, entry), person_id))
        scored.sort(reverse=True)

        # A person can only be in one place at a time, so an identity that some
        # *other* track is holding right now is not a candidate. Without this,
        # two people standing in frame together both match the same gallery
        # entry and get handed the same person_id.
        available = [(sim, pid) for sim, pid in scored if pid not in claimed]

        if available:
            best_similarity, best_person_id = available[0]
            runner_up = available[1][0] if len(available) > 1 else 0.0
            if best_similarity >= self.similarity_threshold:
                # Require the winner to beat the next-best identity by a clear
                # margin. When two stored people score near-identically, the
                # embedding is not actually telling them apart, and picking the
                # higher one is a coin flip that merges two people.
                if best_similarity - runner_up >= self.match_margin:
                    _log("REUSED existing id", best_person_id, best_similarity,
                         f"runner-up={runner_up:.2f}")
                    return best_person_id
                _log("NEW id (ambiguous)", best_person_id, best_similarity,
                     f"runner-up={runner_up:.2f} within match_margin={self.match_margin:.2f} of winner")
            else:
                # The single most useful line for tuning REID_SIMILARITY_THRESHOLD
                # against real footage: without it, "no match" and "no candidates
                # at all" look identical from the logs, and a threshold that's
                # just barely too strict for a given camera pair is invisible.
                _log("NEW id (below threshold)", best_person_id, best_similarity)
        elif scored:
            # Every candidate that scored was excluded only because it's
            # currently claimed by a live track elsewhere (see
            # _live_person_ids) — a different failure mode from "didn't look
            # similar enough" and worth telling apart when debugging.
            _log("NEW id (best candidate claimed by a live track)", scored[0][1], scored[0][0])
        else:
            _log("NEW id (gallery empty or all entries expired)", None, None)

        person_id = self._next_person_id
        self._next_person_id += 1
        log.info("Re-ID [camera=%s local_track=%s]: assigned new global id #%d",
                  camera, local_id, person_id)
        return person_id

    def _live_person_ids(self, now: float) -> set:
        """person_ids currently held by a track seen within the live window.

        Scoped to the last `live_window_seconds` rather than the full TTL: a
        person who walked out of frame a moment ago must stay matchable (that
        reappearance is the whole point of the gallery), while someone visible
        in this very frame must not be.
        """
        return {
            e["person_id"]
            for e in self._track_to_person.values()
            if now - e["last_seen"] <= self.live_window_seconds
        }

    def _purge_stale(self, now: float) -> None:
        stale_persons = [
            pid for pid, e in self._gallery.items() if now - e["last_seen"] > self.ttl_seconds
        ]
        for pid in stale_persons:
            del self._gallery[pid]

        stale_tracks = [
            tid for tid, e in self._track_to_person.items() if now - e["last_seen"] > self.ttl_seconds
        ]
        for tid in stale_tracks:
            del self._track_to_person[tid]

        stale_pending = [
            key for key, e in self._pending.items() if now - e["last_seen"] > self.ttl_seconds
        ]
        for key in stale_pending:
            del self._pending[key]
        if stale_pending:
            log.debug(
                "Re-ID: dropped %d unresolved pending embedding buffer(s)", len(stale_pending)
            )
