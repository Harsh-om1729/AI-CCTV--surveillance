import logging
import os
import time
from collections import deque

import cv2
import numpy as np

log = logging.getLogger("ibvap.alerts")

try:
    import pygame

    pygame.mixer.init()
    _AUDIO_AVAILABLE = True
except Exception as e:
    _AUDIO_AVAILABLE = False
    log.warning("Audio unavailable (%s) — alerts will be visual/log-only", e)


def _synth_tone(frequency: float, duration: float, volume: float = 0.4, sample_rate: int = 44100):
    """Synthesizes a short sine-wave tone in memory — no external audio file
    needed, matching the zero-cost build (pygame.mixer per the roadmap's stack)."""
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    wave = np.sin(2 * np.pi * frequency * t) * volume
    stereo = np.column_stack([wave, wave])
    audio = (stereo * 32767).astype(np.int16)
    return pygame.sndarray.make_sound(np.ascontiguousarray(audio))


class AlertManager:
    """Reacts per threat tier, per the roadmap:
    - Green: silent log only.
    - Yellow: on-screen highlight (drawn upstream) + soft chime + a snapshot.
    - Red: siren + a snapshot burst (several recent frames, not the same
      frame repeated) + a logged stand-in for optional VHF/LoRa radio
      metadata (no real radio hardware in this zero-cost build).

    Rate-limited per track, in three layers (Phase 18 — alert discipline):

    1. Sustained-presence confirmation. A tier must be observed continuously
       for at least `confirm_seconds` of real elapsed time before it is
       *confirmed* — not a count of scoring cycles, which at 15-30fps let a
       single-digit number of *frames* (well under a second of real time)
       confirm an alert. A single borderline frame — a face similarity
       landing on 0.50, one noisy speed estimate — can no longer start an
       incident, and neither can a person merely passing through a zone for
       an instant.
    2. Hysteresis on the way down. A confirmed tier is only released once the
       observed tier has sat continuously below it for `confirm_seconds` too
       — released to the highest tier actually observed during that dip, not
       straight to green. Without this, a score oscillating around a
       threshold kept de-escalating and re-escalating, and since an escalation
       bypasses the cooldown by design, every oscillation bought a free siren:
       the observed failure was nine Red alerts for one stationary person in
       52 seconds, two of them 1-2s apart.
    3. Backoff on repeats. A track that stays at the same confirmed tier
       re-alerts after `cooldown_seconds`, then twice that, then twice again,
       capped at `max_cooldown_seconds` — so a genuine sustained presence is
       reported promptly and then stops shouting.

    An escalation to a *newly confirmed* higher tier still alerts immediately;
    that is the point of confirming it.
    """

    TIER_RANK = {"green": 0, "yellow": 1, "red": 2}

    def __init__(
        self,
        snapshot_dir: str = "snapshots",
        cooldown_seconds: float = 8.0,
        now_fn=time.time,
        incident_store=None,
        webhook=None,
        syslog=None,
        confirm_seconds: float = 1.5,
        confirm_fraction: float = 0.5,
        max_cooldown_seconds: float = 64.0,
        state_ttl_seconds: float = 300.0,
        dispatcher=None,
        watchlist_db=None,
    ):
        if confirm_seconds < 0:
            raise ValueError(f"confirm_seconds ({confirm_seconds}) cannot be negative")
        self.snapshot_dir = snapshot_dir
        self.cooldown_seconds = cooldown_seconds
        self.confirm_seconds = confirm_seconds
        self.confirm_fraction = confirm_fraction
        self.max_cooldown_seconds = max_cooldown_seconds
        self._now = now_fn
        self.incident_store = incident_store
        self.webhook = webhook
        self.syslog = syslog
        # Optional `AlertDispatcher` (alerts/dispatch.py). When set, the slow
        # side effects — webhook POST, syslog emit, evidence persistence — are
        # handed to its background worker instead of running on the frame
        # path. Tier/escalation/cooldown decisions stay synchronous either
        # way, so alert semantics are identical; only *when* the I/O happens
        # changes. Left None (the default) everything runs inline exactly as
        # before, which is what the unit tests rely on.
        self.dispatcher = dispatcher
        self.watchlist_db = watchlist_db
        os.makedirs(snapshot_dir, exist_ok=True)
        # Per-track alert state is keyed by an identity that churns (ByteTrack
        # mints a new id on every re-acquisition), so keeping it forever means
        # growing forever. The TTL is floored at the cooldown deliberately:
        # evicting a track whose cooldown is still running would let it alert
        # again immediately, so this floor guarantees eviction can never change
        # rate-limiting behaviour for a track that is still being tracked.
        self.state_ttl_seconds = max(state_ttl_seconds, cooldown_seconds)
        self._last_tier: dict = {}
        self._last_alert_time: dict = {}
        # track_key -> deque[(timestamp, observed_tier)], pruned to the
        # trailing confirm_seconds - see _confirmed_tier.
        self._history: dict = {}
        self._repeats: dict = {}
        self._last_seen: dict = {}
        self._last_purge: float = self._now()
        # Maps a raw ByteTrack track_id to whichever key (track_id, before
        # Re-ID resolves; person_id, after) its alert state currently lives
        # under - so handle() can detect the switch and carry that state over
        # instead of silently starting a stranger's cooldown/confirmation
        # history at zero the moment identity resolution finishes.
        self._key_for_track_id: dict = {}

        self._yellow_chime = _synth_tone(880, 0.15, volume=0.25) if _AUDIO_AVAILABLE else None
        self._red_siren = _synth_tone(1200, 0.4, volume=0.5) if _AUDIO_AVAILABLE else None

    def handle(self, det, score, recent_frames: list) -> None:
        track_key = det.person_id if det.person_id is not None else det.track_id
        if track_key is None:
            return
        # Two different id namespaces reach this point: a Re-ID person_id, and
        # a raw track_id for a detection whose identity hasn't resolved yet
        # (still buffering samples, or box too small to embed). Printing both
        # as "person #N" made a track_id look like a person_id in the log —
        # e.g. "person #247" in a run that only ever issued 20 person_ids.
        # Label them the way the video overlay already does: #N vs TN.
        label = (
            f"#{det.person_id}" if det.person_id is not None else f"T{det.track_id}"
        )
        now = self._now()
        self._migrate_on_identity_resolution(det.track_id, track_key)
        self._last_seen[track_key] = now
        self._purge_stale(now)
        prev_tier = self._last_tier.get(track_key, "green")
        tier = self._confirmed_tier(track_key, score.tier, now)

        det.previous_zone = prev_tier
        det.current_zone = tier
        det.threat_score = score.total
        det.threat_level = getattr(score, "level", "LOW")
        det.threat_reasons = getattr(score, "reasons", [])

        if prev_tier != tier:
            log.info(
                "[%s] ZONE_TRANSITION: %s %s %s -> %s (dir=%s)",
                det.camera_name or "CAM", det.category(), label, prev_tier.upper(), tier.upper(), det.zone_direction,
            )

        if tier == "green":
            det.status = "CONFIRMED"
            log.debug(
                "Green: %s %s score=%.0f (observed %s)",
                det.category(), label, score.total, score.tier,
            )
            return

        det.status = "CONFIRMED"
        escalated = self.TIER_RANK.get(tier, 0) > self.TIER_RANK.get(prev_tier, 0)
        if escalated:
            # A newly confirmed higher tier resets the backoff: this is a
            # different event from the one already being reported.
            self._repeats[track_key] = 0
        cooled_down = (
            now - self._last_alert_time.get(track_key, 0) >= self._effective_cooldown(track_key)
        )

        if not (escalated or cooled_down):
            return
        if not escalated:
            self._repeats[track_key] = self._repeats.get(track_key, 0) + 1

        det.status = "ALERTED"
        self._last_alert_time[track_key] = now

        self._offload("notify_integrations", self._notify_integrations, det, score, track_key, now)

        if tier == "yellow":
            log.info(
                "YELLOW ALERT: %s %s score=%.0f [%s] — chime + snapshot",
                det.category(), label, score.total, score.breakdown(),
            )
            self._play(self._yellow_chime)
            self._offload("record_evidence", self._record_evidence, det, score, recent_frames[-1:])
        elif tier == "red":
            # The breakdown is the whole point of an additive score: a sentry
            # needs to see which component drove a Red, and whether an override
            # forced it, not just the number.
            log.warning(
                "RED ALERT: %s %s score=%.0f [%s] — siren + snapshot burst",
                det.category(), label, score.total, score.breakdown(),
            )
            log.warning(
                "  [radio-metadata stub] zone=%s tier=%s score=%.0f ts=%.0f "
                "(no VHF/LoRa hardware in this build)",
                det.zone_tier, tier, score.total, now,
            )
            self._play(self._red_siren)
            self._offload("record_evidence", self._record_evidence, det, score, recent_frames)

    def _offload(self, job_name: str, fn, *args) -> None:
        """Runs an alert side effect off the frame path when a dispatcher is
        wired in, inline otherwise.

        A rejected submission (queue full) is already logged and counted by the
        dispatcher; the alert itself has been logged and rate-limit state
        recorded before we get here, so the alert is never lost — only this
        one delivery/persistence attempt is.
        """
        if self.dispatcher is None:
            fn(*args)
            return
        self.dispatcher.submit(job_name, fn, *args)

    def _migrate_on_identity_resolution(self, raw_track_id, track_key) -> None:
        """The bug this closes: track_key is det.track_id until Re-ID
        resolves a person_id, then it switches to that person_id - a
        different dict key. Every alert-discipline dict below is keyed by
        track_key, so that switch used to start a brand-new, empty history
        for the *same physical person mid-presence*: _last_alert_time.get()
        defaults to 0, so cooled_down is trivially true, and _last_tier
        defaults to "green", so the next yellow/red frame reads as a fresh
        escalation. Confirmed live: a person alerted once as "T8", then
        again as "#2" a couple of frames later, same continuous presence -
        Re-ID resolving *sped up* the duplicate rather than causing it,
        since a new (unresolved) track is checked for identity every frame.

        raw_track_id is the pivot: it doesn't change when person_id
        resolves, so it is what lets this detect "the key I'd use for this
        detection just changed" without AlertManager needing to know
        anything about how identities are assigned.
        """
        prior_key = self._key_for_track_id.get(raw_track_id)
        self._key_for_track_id[raw_track_id] = track_key
        if prior_key is None or prior_key == track_key or prior_key not in self._last_seen:
            return

        if track_key in self._last_seen:
            # Re-ID matched this track back onto a person we already have
            # standing state for (re-acquisition after occlusion, not a
            # first resolution) - that established state is more informative
            # than the few frames just collected under the temporary
            # track_id, so it stays authoritative and the temporary state is
            # simply dropped rather than overwriting it.
            for state in (
                self._last_tier, self._last_alert_time, self._history,
                self._repeats, self._last_seen,
            ):
                state.pop(prior_key, None)
        else:
            # First time this identity has a stable key - carry the
            # temporary track_id's state forward so confirmation progress
            # and cooldown timing survive the switch intact.
            for state in (
                self._last_tier, self._last_alert_time, self._history,
                self._repeats, self._last_seen,
            ):
                if prior_key in state:
                    state[track_key] = state.pop(prior_key)

    def _purge_stale(self, now: float) -> None:
        """Evicts alert state for identities not seen for `state_ttl_seconds`.

        Swept at most once per TTL window rather than on every detection, so
        the cost stays negligible while the state stays bounded to roughly the
        identities seen in the last two windows. Only keys that have been
        absent for a full TTL are dropped, and that TTL is never shorter than
        the cooldown, so an active track's cooldown/escalation state is never
        the thing being removed.
        """
        if self._last_purge > now:
            # Wall clock stepped backwards (e.g. an NTP correction) - re-base
            # rather than never sweeping again.
            self._last_purge = now
        if now - self._last_purge < self.state_ttl_seconds:
            return
        self._last_purge = now

        stale = [key for key, seen in self._last_seen.items() if now - seen > self.state_ttl_seconds]
        for key in stale:
            self._last_seen.pop(key, None)
            self._last_tier.pop(key, None)
            self._last_alert_time.pop(key, None)
        if stale:
            stale_set = set(stale)
            gone = [rt for rt, key in self._key_for_track_id.items() if key in stale_set]
            for rt in gone:
                self._key_for_track_id.pop(rt, None)
        if stale:
            log.debug("Evicted alert state for %d stale identit(ies)", len(stale))

    def _confirmed_tier(self, track_key, observed_tier: str, now: float) -> str:
        """Time-based confirmation on the way up, full-window hysteresis on
        the way down. Returns the tier the alerting logic should act on,
        which is not necessarily the tier this single frame scored.

        The window is real elapsed seconds (confirm_seconds), not a count of
        scoring cycles - at 15-30fps a handful of *frames* is well under a
        second of real time, which is what let a person merely passing
        through a zone, or a single noisy reading, confirm an alert almost
        instantly.
        """
        history = self._history.setdefault(track_key, deque())
        history.append((now, observed_tier))
        # Retained a bit past confirm_seconds itself (not pruned right at
        # it): the span check below needs the window able to actually reach
        # a full confirm_seconds. Pruning at exactly that boundary is
        # self-defeating under steady, evenly-spaced sampling (e.g. a fixed
        # fps) - the oldest sample that would push span to confirm_seconds is
        # always exactly the one being evicted, so span asymptotes just
        # under confirm_seconds and never reaches it.
        retain_seconds = self.confirm_seconds * 1.5
        while history and now - history[0][0] > retain_seconds:
            history.popleft()
        confirmed = self._last_tier.get(track_key, "green")

        # The window must span at least confirm_seconds of real time before
        # it can be trusted - not just "enough samples happen to be in it".
        # This only works because the window is cleared below on every actual
        # tier change: without that, a track already confirmed Yellow for a
        # while that then turns Red would keep one stale Yellow sample
        # sitting next to the first new Red one, and a window of exactly
        # those two is already >=50% "at or above Red" - confirming Red off
        # a single fresh frame. Clearing means the window confirming the
        # *next* tier only ever contains evidence gathered since the last
        # change, so reaching confirm_seconds here means that much real time
        # has passed with the candidate tier itself actually present.
        span = now - history[0][0]

        if span >= self.confirm_seconds:
            # Up: any tier above the confirmed one seen in at least
            # confirm_fraction of the window. Highest such tier wins, so a
            # burst of Red is not masked by the Yellows around it. A
            # borderline signal genuinely oscillating (e.g. ~50/50 across the
            # window) still confirms once, rather than being read as "never
            # sustained" and going silent forever.
            for candidate in ("red", "yellow"):
                if self.TIER_RANK[candidate] <= self.TIER_RANK[confirmed]:
                    continue
                hits = sum(1 for _, t in history if self.TIER_RANK[t] >= self.TIER_RANK[candidate])
                if hits >= len(history) * self.confirm_fraction:
                    self._last_tier[track_key] = candidate
                    history.clear()
                    return candidate

            # Down: only once *every* observation in the window sits below
            # the confirmed tier - a lone sub-threshold frame no longer drops
            # the tier, which is what previously let the next frame
            # re-escalate and bypass the cooldown. Released to the highest
            # tier actually seen during the dip, not straight to green.
            if all(self.TIER_RANK[t] < self.TIER_RANK[confirmed] for _, t in history):
                released = max((t for _, t in history), key=lambda t: self.TIER_RANK[t])
                self._last_tier[track_key] = released
                history.clear()
                return released

        self._last_tier[track_key] = confirmed
        return confirmed

    def _effective_cooldown(self, track_key) -> float:
        """Exponential backoff for a track parked at the same confirmed tier.

        The ceiling bounds how far the backoff may *grow*; it must never pull
        the interval below the configured base. With cooldown_seconds=100 and
        the default max_cooldown_seconds=64, a plain min() returned 64 — a
        shorter gap than the operator asked for, so a track re-alerted at 64s
        on a 100s cooldown. Raising the ceiling to the base keeps backoff
        monotonic: the first interval is always exactly cooldown_seconds.
        """
        repeats = self._repeats.get(track_key, 0)
        ceiling = max(self.max_cooldown_seconds, self.cooldown_seconds)
        return min(self.cooldown_seconds * (2 ** repeats), ceiling)

    def forget(self, track_key) -> None:
        """Drops all per-track state. Callers that retire tracks should use it;
        without it these dicts grow for the life of the process (Phase 20)."""
        for state in (
            self._last_tier, self._last_alert_time, self._history,
            self._repeats,
        ):
            state.pop(track_key, None)

    def _play(self, sound) -> None:
        if sound is not None:
            sound.play()

    def _notify_integrations(self, det, score, track_key, now: float) -> None:
        """Phase 16: outbound webhook (JSON POST) + syslog-formatted event,
        so this platform can feed whatever C2/SIEM system a deploying force
        already runs, without it needing to know this platform's internals.
        """
        payload = {
            "track_id": det.track_id,
            "person_id": det.person_id,
            "category": det.category(),
            "zone_tier": det.zone_tier,
            "tier": score.tier,
            "score": score.total,
            "timestamp": now,
        }
        if self.webhook is not None:
            self.webhook.notify(payload)
        if self.syslog is not None:
            self.syslog.emit(
                f"ALERT tier={score.tier} category={det.category()} "
                f"score={score.total:.0f} track={track_key} zone={det.zone_tier}"
            )

    def _record_evidence(self, det, score, frames: list) -> None:
        """Delegates to the encrypted, queryable IncidentStore (Phase 12) when
        one is wired in; otherwise falls back to plain unencrypted snapshot
        files (e.g. when running without persistence, as in unit tests)."""
        if self.incident_store is not None:
            crop = self._crop(frames[-1], det.box)
            self.incident_store.record(
                det, score, frames[-1], crop_frame=crop, burst_frames=frames[:-1] or None
            )
            # One bump per recorded incident, not per face-check frame — see
            # WatchlistDB.record_match. incident_store.record() already
            # persisted this same match onto the row, so this is what makes
            # a subject's match_count/last_matched_at (and the dashboard's
            # sighting history) reflect real detections.
            if self.watchlist_db is not None and getattr(det, "watchlist_match", None):
                self.watchlist_db.record_match(det.watchlist_match)
        else:
            track_key = det.person_id if det.person_id is not None else det.track_id
            self._save_snapshot(frames, score.tier, det, track_key)

    @staticmethod
    def _crop(frame, box):
        x1, y1, x2, y2 = box
        x1, y1 = max(x1, 0), max(y1, 0)
        return frame[y1:y2, x1:x2]

    def _save_snapshot(self, frames: list, tier: str, det, track_key) -> None:
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        saved = 0
        for i, frame in enumerate(frames):
            path = os.path.join(
                self.snapshot_dir, f"{tier}_{det.category()}_{track_key}_{timestamp}_{i}.jpg"
            )
            if cv2.imwrite(path, frame):
                saved += 1
        log.info("Saved %d snapshot(s) to %s/", saved, self.snapshot_dir)
