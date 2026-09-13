# IBVAP — Intelligent Border Video Analytics Platform

**Edge-native, air-gapped, explainable video analytics and zero-false-alarm intrusion detection.**

Built for high-stakes perimeter security with complete air-gapped independence, deterministic threat scoring, and tamper-resistant encrypted evidence.

---

## 🏛️ End-to-End System Architecture

```
CAMERA / VIDEO STREAM
       ↓
PREPROCESSING (Night / Fog CLAHE & Activity Gating)
       ↓
DETECTION (YOLOv8s ONNX Runtime)
       ↓
TRACKING (ByteTrack / Multi-Target Track Association)
       ↓
GROUND POSITION CALCULATION (Bottom-Center: (x1+x2)/2, y2)
       ↓
GEOMETRIC ZONES (Polygonal cv2.pointPolygonTest: RED > YELLOW > GREEN)
       ↓
DIRECTION & KINEMATICS (Inward / Outward Vector + Speed Estimation)
       ↓
TEMPORAL CONFIRMATION (3-frame Debounce / Cooldown Hysteresis)
       ↓
THREAT SCORING (Explainable 0-100 Score with Transparent Contributing Reasons)
       ↓
ALERT ENGINE (Siren, Chime, Audio Throttle & Escalation Bypass)
       ↓
INCIDENT LIFECYCLE (DETECTED → CONFIRMED → ALERTED → ACKNOWLEDGED → RESOLVED)
       ↓
EVIDENCE AT REST (AES-Fernet Encrypted Snapshots & Crops)
       ↓
SQLITE REPOSITORIES (`incidents.db` + `threat_rules.db` + `watchlist.db`)
       ↓
FASTAPI REST & WEBSOCKET ENGINE (`/api/v1/`)
       ↓
COMMAND CENTER DASHBOARD (React + TypeScript + Tailwind)
```

---

## 🚀 Quick Start — Teacher & Judge Demo

For a full script and walkthrough, see **[docs/TEACHER_DEMO.md](docs/TEACHER_DEMO.md)**.

### 1. Pre-flight Health Check
Verify models, databases, encryption keys, and camera profiles:
```bash
./venv/bin/python runtime/startup_check.py
```

### 2. Run the Deterministic 15-Step Demo
Executes Track #17 walking `GREEN -> YELLOW -> RED`, passing through the real production zone engine, threat scorer (96/100 CRITICAL), alert manager, Fernet evidence encryption, and SQLite persistence:
```bash
./venv/bin/python scripts/run_demo.py
```

### 3. Start the Platform
```bash
# Terminal 1: Backend API & Monitoring Server
./venv/bin/python app.py

# Terminal 2: React Command Center UI
cd frontend && npm run dev
```
Open `http://localhost:5173/dashboard` to control the demo, view real-time camera feeds, inspect geometric zones, and manage incidents.

---

## Setup & Dependencies

### Model weights — not in git

`models/*.pt`, `*.onnx` and `*.onnx.data` are gitignored (100+ MB of binaries
don't belong in the repo). A fresh `git clone`/`git pull` gets **no model
files at all** — `python app.py` fails immediately with
`FileNotFoundError: 'models/yolov8n.onnx' does not exist` (or `yolov8s.onnx`,
depending what `DETECTION_MODEL_PATH` in your `.env` says). Before running
anything:

1. **Get `models/` from a teammate** (zip it, ~130 MB) and drop it in at the
   repo root — this is the only way to get `osnet_x0_25_msmt17.onnx`, which
   has no public download; whoever converted it is the only source.
2. Alternatively, regenerate the YOLO detector yourself (needs internet):
   `yolo export model=yolov8n.pt format=onnx` (or `yolov8s.pt`) auto-downloads
   the base weights and exports an ONNX file — move it into `models/` as
   whichever name `DETECTION_MODEL_PATH` expects.
3. `InsightFace buffalo_s` (face recognition) needs no manual step — it
   downloads itself into `~/.insightface/models/buffalo_s/` the first time
   `app.py` runs, provided you have internet at least once. **On a machine
   with neither the cache nor internet, this used to crash the whole
   pipeline at startup — fixed (see "Offline operation" below): it now
   degrades to no face recognition / no watchlist matching instead.** For a
   genuinely offline fresh machine, copy `~/.insightface/models/buffalo_s/`
   (158 MB, separate from `models/` and from `models.zip`) from a machine
   that already has it, the same way you got `models/`.

`config/zones_*.json` is also gitignored (each camera's drawn zones are local
config, not code) — a fresh clone starts with no zones and Phase 18's no-zone
ceiling applies (see the Phase 18 section below) until you press `z` in the
video window to draw them.

### Offline operation — what's actually true

Detection, tracking, zones, threat scoring, alerting and the incident
database need **zero network access**, always — verified live with Wi-Fi
fully disabled (Phase 14). Two things are the actual exceptions, both
one-time and both now fail *safely* if you skip them:

- **YOLO and OSNet** are always fully offline — local `.onnx` files, no
  fetch logic exists for them at all.
- **InsightFace buffalo_s** (face recognition + watchlist matching)
  auto-downloads ~158 MB into `~/.insightface/models/buffalo_s/` on first
  use if that cache doesn't already exist. Confirmed live: with no cache
  and no network reachable, this used to crash the whole pipeline at
  startup (an uncaught exception out of `FaceRecognizer.__init__`) —
  fixed, it now logs a warning and runs with face recognition and
  watchlist matching disabled, same fallback pattern as
  `alerts/alert_manager.py`'s existing audio degradation. Detection,
  tracking, zones, scoring, alerting and the incident DB are all
  unaffected either way.
- Outbound webhook/syslog integrations (`WEBHOOK_URL`, `SYSLOG_HOST`) are
  opt-in and already fail-safe/non-blocking if unreachable (Phase 16) —
  not needed for the pipeline to run at all.

**For a genuinely offline fresh machine** (no internet, ever): copying
`models/` isn't enough by itself — also copy
`~/.insightface/models/buffalo_s/` from a machine that has it, or accept
that face recognition/watchlist matching will be unavailable on that box
until you do (everything else still works).

## Phase status

- [x] Phase 0 — Foundation
- [x] Phase 1 — Camera Input
- [x] Phase 2 — Multi-Camera Stream Management
- [x] Phase 3 — Weather / Low-Light Preprocessing
- [x] Phase 3A — Adaptive Activity Gate
- [x] Phase 4 — YOLO Detection
- [x] Phase 5 — ONNX + INT8 + OpenVINO (ONNX fp32 adopted; INT8/OpenVINO documented as Intel-hardware-dependent, see below)
- [x] Phase 6 — Tracking (ByteTrack)
- [x] Phase 7 — False-Alarm Filter (aspect-ratio check + OSNet appearance-based Re-ID gallery for stable person IDs across brief disappearances)
- [x] Phase 7A — Vehicle Classification (already satisfied by YOLO's granular COCO classes — car/truck/bus/motorcycle/bicycle shown distinctly, verified against recorded footage; tractor class + Indian-vehicle fine-tuning remain future work, no labeled dataset available)
- [x] Phase 8 — 3-Zone Tactical Logic (interactive click-to-draw zones on the existing OpenCV window in place of the Phase 13 dashboard UI; Red/Yellow/Green priority, Yellow inward/outward direction, Green curfew re-tiering — all covered by unit tests, red zone also live-verified)
- [x] Phase 9 — Offline Threat Intelligence (SQLite `threat_rules.db`: sector/time/class-confidence lookups + movement config, seeded once and never overwritten so local tuning persists; unit tested, live-verified via diagnostic overlay)
- [x] Phase 10 — Threat Score / Decision Engine (T = S_sector + T_time + K_kinematics + C_class, 0-100, tiered Green/Yellow/Red; unit tested + live-verified)
- [x] Phase 11 — Alerting (Green=silent log, Yellow=synthesized chime+snapshot, Red=siren+snapshot burst+logged radio-metadata stub; per-track rate limiting with escalation bypass; unit tested + live-verified with audio)
- [x] Phase 12 — Incident DB + Evidence (SQLite `incidents.db` + Fernet-encrypted full/crop/burst evidence images, reusing Phase 11's alert firing/rate-limit decisions; unit tested + live-verified by directly querying the DB)
- [x] Phase 12A — Facial Recognition + Watchlist (face detection+embedding via InsightFace buffalo_s — since Phase 4 never added a separate YOLOv8-Face detector, this fills that gap too; SQLite watchlist.db, cosine match escalates to Red regardless of zone; unit tested + live-verified with a real photo. **DPDP Act caveat**: any real deployment of a watchlist DB of biometric face data needs authorized data-handling procedures under India's DPDP Act — not just a modeling detail)
- [x] Phase 13 — Local Dashboard (Streamlit prototype: live annotated feed + recent-incidents table, reusing the exact same pipeline as app.py; zone drawing stays in the OpenCV app's Phase 8 drawer, loaded read-only here; live-verified in browser)
- [x] Phase 14 — Offline / Air-Gapped Operation (live-verified with Wi-Fi fully disabled: detect→track→score→alert→DB all worked; also added encrypted USB-transfer bundle scripts for threat_rules.db/watchlist.db updates, unit tested)
- [x] Phase 15 — Cross-Camera Re-ID (single shared `PersonGallery` across all cameras, keyed by `(camera_name, track_id)` to prevent cross-camera ID collisions; unit tested + live-verified with 2 simultaneous streams. NOTE: the original "no false merging" claim here did not hold — later measurement showed the ImageNet ResNet-18 embedding merged different people; see the Phase 7 notes for the diagnosis and the OSNet fix.)
- [x] Phase 16 — Command & Control Integration (FastAPI `/incidents` + `/status` JSON endpoints, outbound webhook, syslog-formatted UDP events — all fail-safe/non-blocking if unreachable; VHF/LoRa stays a logged stand-in per Phase 11, no real radio hardware; unit tested + live-verified)

## Hardening phases (17-25)

Phases 0-16 built the capability; these make it hold up under evaluation and
under a month of unattended running. Findings and rationale live in
`../IBVAP_Audit.md`; the phase plan is `../IBVAP_Hardening_Roadmap.md`.

- [x] Phase 17 - Truth in Documentation (ANPR claim corrected in the Roadmap
      capability table and pitch deck - no `anpr/` module exists; the four
      stale threat-score tests rewritten for the U-curve; `IBVAP_API_TOKEN`
      bearer auth implemented in `integration/api.py` so `.env`'s long-standing
      claim is now true, with 5 tests; `WATCHLIST_KEY_PATH` and
      `ALERT_DISPATCH_QUEUE_SIZE` removed as unimplemented, `.env` and
      `.env.example` brought back into sync; orphan `database/watchlist.key`
      deleted and untracked. Suite: 83 tests, 1 expected failure - see below)
- [x] Phase 18 - Alert Discipline (N-of-M confirmation: a tier must be observed
      `ALERT_CONFIRM_N` times in the last `ALERT_CONFIRM_WINDOW` scoring cycles
      before it can alert; hysteresis: a confirmed tier is released only once
      the whole window sits below it; exponential backoff on repeats up to
      `ALERT_MAX_COOLDOWN_SECONDS`; and a no-zone ceiling capping un-zoned
      footage at Yellow. The watchlist override moved out of
      `draw_threat_score_overlay()` into `ThreatScorer.score()` - it was a
      scoring rule living in a drawing function, and it bypassed the ceiling
      from there. 14 new tests; suite now 98 tests, 1 expected failure)
- [ ] Phase 19 - Zone & Score Correctness (demo zones, sustained-presence override, scale-normalised speed)
- [ ] Phase 20 - Survivability (camera reconnect, real `/status` health, non-blocking dispatch, retention, dict purges)
- [ ] Phase 21 - Measured Accuracy (labelled set, precision/recall, range bands, Intel benchmark)
- [ ] Phase 22 - Deployability (headless mode, systemd, single-service dashboard)
- [ ] Phase 23 - Multi-Camera Scale (shared model + batched inference)
- [ ] Phase 24 - Compliance & Evidence Integrity (watchlist audit log, hash chain)
- [ ] Phase 25 - Environmental Robustness (contrast-triggered enhancement, dehaze, activity gate, zone drift)
- [x] Phase 26 - Low-Power Hardware Profile (`HARDWARE_PROFILE=low`: 416-input
      detector, 1 ORT thread, fewer identity re-checks, lower idle rate.
      CPU-only 16.1 -> 33.8 fps at under one core, no precision/recall loss on
      the reviewed frames. OpenVINO provider path wired, not yet measured on
      Intel - see the section below)

### Phase 18 measured effect

Before, one stationary person in a 52-second window produced **nine Red alerts**
- six on the 8s cooldown, and three more 1-2s apart. Those three came from the
escalation bypass: the base score with no zones drawn is `time 4 + move 10 +
class 12 = 26`, which is Green, so whenever the watchlist similarity dipped
under its 0.50 threshold the tier fell to Green and the next frame re-escalated
to Red, skipping the cooldown by design. The similarities that run were 0.50,
0.52, 0.57, 0.64 - sitting on the line.

After, the same scene over 28 seconds produced **zero Red alerts and one
Yellow**:

    YELLOW ALERT: person #5 score=69 [time 4 + class 12
      [forced RED: watchlist match: Test Subject (similarity=0.55)]
      [capped at YELLOW: no zone defined for this camera]] - chime + snapshot

That is the intended shape: the match is still detected, still logged with its
reason, still recorded as an incident with evidence - it just does not sound a
siren on a 0.55 similarity in footage where the system cannot tell where the
person is standing. Draw zones and the ceiling lifts.

### Known gap carried as an expected failure

`tests/test_threat_score.py::test_person_in_red_zone_at_night_moving_fast_scores_red`
is marked `@unittest.expectedFailure`, not deleted or relaxed. A person in the
red zone at 2am moving fast, with no direction label, totals 65 -> Yellow;
Red is currently reachable only via the crossing override, which needs >=4px
of movement, so a stationary or distant subject never escalates. The assertion
is right and the scoring is wrong - Phase 19 adds a sustained-presence
override, after which the decorator comes off.

### Phase 26 — Low-Power Hardware Profile

Every number above was measured on an Apple M4 with CoreML; the field target
is an Intel i3/i5 box with no GPU, and a teammate's Intel laptop topped out
around 10 fps with visible stutter. `HARDWARE_PROFILE=low` in `.env` is the
fix, as one switch:

| Setting | standard | low | Why |
|---|---|---|---|
| `DETECTION_MODEL_PATH` | `yolov8s.onnx` (640) | `yolov8n_416.onnx` | detection was 85% of CPU-only frame time |
| `ORT_NUM_THREADS` | 2 | 1 | three ORT sessions × 2 threads oversubscribe a 2–4 core CPU |
| `REID_FACE_CHECK_INTERVAL` | 5 | 10 | halves identity re-checks for already-resolved tracks |
| `IDLE_MIN_FPS` | 20 | 5 | a quiet scene needn't cost a full pipeline pass 20×/s |

Any of the four set explicitly in the environment still wins over the profile.

**Measured CPU-only** (`scripts/bench_pipeline.py --cpu-only` hides every
accelerator — but it's still the M4's CPU, so treat this as an upper bound,
not the Intel number. Re-ID and face run every frame in this harness, so the
interval and idle savings above come on top):

| | standard | low (1 thread) | low, 2 threads |
|---|---|---|---|
| throughput | 16.1 fps | 33.8 fps | 42.5 fps |
| CPU used | 220% of a core | 96% | 262% |
| detect_track | 45.8 ms | 10.7 ms | 9.2 ms |

With the accelerator left on (a normal run on the M4), the same comparison is
15.9 → 34.2 fps at 183% → 71% of one core; detection drops to 3 ms, and face
recognition becomes the new bottleneck (54% of frame time).

On a many-core machine 2 threads is 26% faster; `low` still uses 1 because it
fits in one core, which on a 2-core i3 is the difference between headroom and
contention. Measure both on the real box (`implementation_plan.md`).

**Accuracy didn't pay for it** (`scripts/accuracy_eval.py --replay`, the same
36 reviewed frames and labels for every model): yolov8s@640 94.7% precision /
100% recall; yolov8n@640 97.3% / 100%; yolov8n@416 97.3% / 100%; yolov8n@320
100% / 100%. The honest limit: every subject in that capture is close to the
camera, and a smaller input loses far-away people first — which this sample
never tests. That's why `low` uses 416, not 320; `models/yolov8n_320.onnx` is
there for the weakest boxes, with that caveat.

The 416/320 files are fixed-shape exports of the same `yolov8n.pt`
(`YOLO("yolov8n.pt").export(format="onnx", imgsz=416)`), gitignored like every
weight file and shipped in `models.zip`. Ultralytics predicts at 640 unless
told otherwise, and a fixed 416 export rejects a 640 tensor, so `Tracker` and
`Detector` now read the input size from the file
(`detection.detector.model_input_size`).

**OpenVINO: wired, not measured.** Re-ID and face used to hardcode
`CPUExecutionProvider`, so an installed accelerator was ignored for 55% of
per-frame time. They now call `config.providers.select_providers()`, which
prefers OpenVINO when `onnxruntime-openvino` is installed and falls back to
CPU otherwise (the detector already picks its own provider via Ultralytics).
None of this has run on Intel yet — installing it and taking the before/after
numbers on the target machine is `implementation_plan.md`. The dashboard's
Settings → AI Models card shows the active profile and provider. 15 tests in
`tests/test_low_power.py`.

### Per-camera fixed zone tiers (alternative to drawn polygons)

Drawing red/yellow/green polygons per camera (Phase 8) assumes one camera's
frame can contain multiple tiers - true for a wide-FOV camera watching a whole
approach, but not how every border camera is actually mounted: a camera bolted
right at the fence line sees nothing *but* the border, for its entire frame,
always. For that camera, drawing a polygon around "the whole picture" is
busywork, and it is also the more fragile part of a live demo (skip the 'z'
key, or draw a bad polygon, and scoring silently degrades to the no-zone
ceiling).

`CAMERA_ZONE_TIERS` (`.env`) fixes a named camera to one tier - e.g.
`CAMERA_ZONE_TIERS=cam0=red,cam1=yellow,cam2=green` - and `ZoneEngine`
(`zones/zone_engine.py`) skips polygon classification for it entirely: every
detection from that camera inherits the assigned tier, no `config/zones_
<camera>.json` required. Direction ("inward"/"outward") is read from raw
on-screen motion instead of a vector toward another zone's centroid - a
ground point descending in frame reads as approaching the camera - since
there is no other zone left to reference once the camera has only one.
A camera not listed keeps using its drawn polygons exactly as before; the two
modes coexist per camera. 9 unit tests in `tests/test_zone_engine.py`
(`TestFixedTierZoneEngine`).


## Phase 5 benchmark notes (measured on Apple M4, run via `scripts/benchmark_models.py`)

| Model | Avg latency | FPS |
|---|---|---|
| PyTorch (.pt) | 31.7 ms | 31.6 |
| ONNX (fp32) | 7.1 ms | 140.9 |
| ONNX (int8, dynamic quant) | 86.8 ms | 11.5 |

ONNX Runtime (fp32) is the default — it's dramatically faster here because it
auto-selects Apple's CoreML execution provider (Neural Engine/GPU). Dynamic
INT8 quantization made things *worse* on this hardware: the quantized graph
fragmented into many more CoreML/CPU partitions, adding overhead with no
compensating speedup. INT8's real benefit (via VNNI instructions + OpenVINO)
is expected on the target Intel i3/i5 field-deployment hardware, not verified
here — worth stating explicitly as a caveat in the SIH report rather than
claiming INT8 as a universal win.

Also found and fixed during this phase: the webcam was capturing at native
1080p by default, which inflated every pipeline stage. Camera capture is now
explicitly requested at 640x480 (`CAMERA_WIDTH`/`CAMERA_HEIGHT` in `.env`).

## Phase 7 Re-ID design notes

ByteTrack alone only matches detections frame-to-frame by motion/position, so
a person who leaves frame (or is occluded) longer than its internal track
buffer gets a brand-new `track_id` on return — worth stating plainly in the
report as a limitation of motion-based tracking, not a bug. `reid/reid.py`'s
`PersonGallery` closes that gap by matching appearance across track_ids.

Two embedding approaches were tried, in order:
1. **HSV color histogram** (roadmap's cheapest suggested option) — failed in
   practice: different people wearing similar neutral-toned (white/grey/beige)
   clothing produced near-identical histograms, since hue is close to
   meaningless for low-saturation pixels. Verified via live testing (multiple
   people got merged into the same ID), not just theorized.
2. **ResNet-18 embedding** (ImageNet-pretrained, classification head removed,
   512-d feature) — the roadmap's other named option for this phase. Better
   than the histogram, but *also merged different people*, and this was
   measured rather than eyeballed: on real pedestrian crops, unrelated people
   scored up to **0.795** cosine similarity while the configured gate was
   0.70, so strangers matched. Root cause is that ImageNet features describe
   generic texture/shape — the network was never trained to encode *which
   person* this is. Replaced.
3. **OSNet x0.25 / MSMT17** (`models/osnet_x0_25_msmt17.onnx`, 907KB, run via
   onnxruntime) — trained for person Re-ID specifically. On the same crops:
   unrelated people at most **0.501**, same person under box jitter at least
   **0.872** — a separation gap of 0.371 vs ResNet-18's 0.139, so the 0.70
   gate now sits in clear space instead of inside the noise. Also *faster*:
   2.9ms/crop vs 7.6ms. Weights ship in `models/` and are never fetched at
   runtime, so Phase 14 air-gapped operation is unaffected. Adopted as the
   default.

Three gallery-logic bugs found alongside this, all of which independently
caused different people to share one `person_id`:
- **No mutual exclusion** — nothing stopped two people standing in frame *at
  the same time* from both matching the same gallery entry. A person can only
  be in one place, so an identity held by another track seen within the last
  `live_window_seconds` is now excluded from matching. Regression-tested
  (`TestSimultaneousPeople`); the test fails against the old code.
- **Match overwrote the gallery entry** instead of blending into it, so a
  single borderline match redefined that identity as whoever matched last and
  dragged further people onto it.
- **No margin test** — the best match won even when the runner-up was a
  hair behind, i.e. exactly when the embedding was *not* separating those two
  people. Now requires `REID_MATCH_MARGIN` (default 0.05) of daylight, else a
  new id is minted rather than guessing.

Also fixed a latent `KeyError` crash: a track's `last_seen` refreshed every
frame but its gallery entry's only refreshed on frames that produced an
embedding, so a long track at small box size could have its gallery entry
purged while still bound, then crash on the next good frame.

Other measures that mattered in practice: deciding a new track's identity
from the *average* of its first few embeddings (not a single frame) to cancel
out noise from partial/edge-clipped boxes, and skipping embedding entirely for
boxes below a minimum size. Both configurable: `REID_SIMILARITY_THRESHOLD`,
`REID_TTL_SECONDS`, `REID_MATCH_MARGIN`, `REID_MODEL_PATH` in `.env`.

## Detection model & confidence notes

Live testing surfaced a real false-positive: a person's own bent leg/knee
(close to camera, with a strapped-on device) got detected as a *second*
"person" at confidence 0.43, right beside the correctly-detected real person
at 0.90. Two things were tried, in order:

1. **Raised `DETECTION_CONFIDENCE`** from 0.4 to 0.5 (comfortable margin above
   the observed false positive) — insufficient alone; the false positive
   persisted at a similar confidence on retest.
2. **Switched the default detection model from YOLOv8n to YOLOv8s** — the
   next size up, still comfortably real-time (measured **95.3 FPS** via
   `scripts/benchmark_models.py` on this machine's CPU, vs. YOLOv8n's 148.5).
   More model capacity generally means fewer confusions like a bent limb read
   as a second person. `FalseAlarmFilter`'s aspect-ratio check couldn't have
   caught this either way — the false box's ratio (~1.6:1) and its overlap
   with the real detection (IoU ≈ 0.05) both fell within normal, accepted
   ranges, so this really was a model-accuracy issue, not a filtering gap.
   **Live-verified after the swap: the false leg detection no longer appears.**

`DETECTION_MODEL_PATH` defaults to `models/yolov8s.onnx`; swap back to
`models/yolov8n.onnx` for maximum speed on weaker target hardware if needed.
Raising confidence further is still a real lever (`DETECTION_CONFIDENCE` in
`.env`) but trades off missing genuinely low-confidence real detections
(distance, angle, partial occlusion) — a real precision/recall tradeoff,
tuned from observed cases rather than proven optimal.

Separately: an aspect-ratio range of (1.0, 4.0) for "person" (requiring
height > width) was found, via live testing, to silently reject every correct
detection of someone lying/reclining — a wide, short box. Widened to
(0.2, 4.0) to admit both upright and reclined postures. **Live-verified: a
reclining pose is now correctly boxed.**

## Phase 12A face recognition notes

Live testing on a phone RTSP feed found InsightFace missing faces it should
have caught. Root cause: `FaceRecognizer.embed()` originally handed the
detector the *entire* person bounding box — tall and narrow — which InsightFace
resizes down to fit its detector window, shrinking the face far more than
necessary. Fixed by cropping to just the head/shoulder region (top ~50% of
the person box height) before detection, and raised `det_size` to 416x416
with a lower `det_thresh` (0.4) for more margin. **Live-verified after the
fix**: a watchlist match reliably escalates to Red on both the local webcam
and a phone RTSP feed.

## RTSP camera notes

Confirmed working against a phone running an IP-camera app (e.g. "IP Webcam"
on Android), streamed over local Wi-Fi. Two real issues found and fixed:

- The stream manager's producer thread treated *any* single failed frame read
  as "the stream has ended" and permanently stopped — but a live RTSP stream
  routinely fails its first several reads while the H.264 decoder is still
  resolving SPS/PPS and waiting for a clean keyframe. Now retries up to 50
  consecutive failures (~2.5s) before giving up, which still detects a
  genuinely dead camera quickly.
- Camera sources can now be given directly on the command line instead of
  only via `CAMERA_SOURCES` in `.env` — e.g.
  `python app.py rtsp://192.168.1.46:8080/h264_ulaw.sdp`, or multiple sources
  at once: `python app.py 0 rtsp://192.168.1.46:8080/h264_ulaw.sdp`.

**Re-ID/track-ID churn on the phone feed** (person's identity changing far
more often than on the stable USB webcam) was investigated with actual
measurements rather than guessed at:
- Directly measured raw frame-arrival timing from the RTSP stream (15s
  capture, 914 frames, 0 failed reads): median gap 8.7ms, max gap only
  162.7ms — ruling out network jitter/stalls as the cause.
- H.264 decode errors ("error while decoding MB...", "cabac decode...")
  were observed continuously during normal operation, not just at stream
  startup — meaning some "successfully read" frames are visually corrupted
  or partially stale rather than cleanly dropped.
- ByteTrack's bundled default (`match_thresh: 0.8`, `track_buffer: 30`) is
  tuned for a clean source; a corrupted frame can visibly shift/resize a box
  even when the person hasn't moved, which breaks that strict IoU matching
  and mints an unnecessary new track ID. Added
  `tracking/bytetrack_tolerant.yaml` (`match_thresh: 0.65`,
  `track_buffer: 60`) as the new default tracker config, giving more
  tolerance for this kind of noisy-source drift. **Live-verified**: the
  primary tracked identity stayed on one person ID continuously for ~44
  seconds on the phone feed, a large improvement over the pre-fix baseline
  (new ID roughly every few seconds).

**Shutdown crash on a glitchy RTSP source**: quitting the app after a run
with heavy decode errors sometimes crashed the whole process with a native
`libc++abi`/`recursive_mutex` error, not a Python exception. Root cause:
`CameraStream.stop()` called `self._camera.release()` right after
`thread.join(timeout=2)`, without checking whether the join actually
succeeded — if the producer thread was still stuck inside a slow/blocked
`cap.read()` (which a corrupted RTSP source can trigger), the main thread
would release the same `cv2.VideoCapture` object while the producer thread
might still be reading from it concurrently, a real data race that can crash
the process outright rather than raise a catchable exception. Fixed by
checking `thread.is_alive()` after the join and skipping the release (with a
logged warning) if the producer hasn't actually stopped — the leaked handle
is reclaimed by the OS at process exit either way, which is far preferable
to a hard crash.

## Incident operator workflow (Acknowledge / Resolve)

Every incident now carries `status` (`open` → `acknowledged` → `resolved`),
who acted on it and when (`acknowledged_by`/`_at`, `resolved_by`/`_at`), and
a controlled resolution reason (`cattle`, `vegetation`,
`authorized_personnel`, `genuine_intrusion`, `patrol_dispatched`) — see
`database/incident_store.py`'s `acknowledge()`/`resolve()`. This is what
turns a raw detection stream into something a sentry can actually work
through on shift, and the resolution reason doubles as a self-generating
false-alarm dataset once a real operator is using it.

Added via `ALTER TABLE ADD COLUMN`, never a table rebuild — **verified
against the real `incidents.db` from this session's testing (524 rows)**:
row count and existing data were unchanged after migration, and every
pre-existing row correctly defaulted to `status='open'`.

The Streamlit dashboard's Acknowledge/Resolve buttons required fixing a real
architecture bug first: the dashboard ran a bare `while True: ...` loop,
which would have silently made every button non-functional — Streamlit only
processes a widget's clicked state on the *next* script run, and a literal
infinite loop never lets that next run happen. First fix (`time.sleep()` +
a full-page `st.rerun()` each pass) made the buttons work but visibly
flickered the whole page — a full rerun tears down and rebuilds *everything*
(video, text input, every incident card) each cycle. Replaced with two
independent `st.fragment`s: `render_video()` and `render_incidents()`
(`run_every=1`), each refreshing on its own schedule without disturbing the
other, and a button click inside a fragment only reruns that fragment
(`st.rerun(scope="fragment")`) — no full-page rerun needed at all.

Fixing the flicker surfaced a separate lag: `st.image()` defaults to PNG,
meaningfully slower to encode than JPEG for video content, and every
fragment tick also pays a WebSocket round-trip the OpenCV window (`app.py`)
never does — that window just blits natively, no encode/network cost at
all. Set `output_format="JPEG"` on the video call and relaxed
`render_video`'s `run_every` from 0.05 to 0.1 to match a realistic per-tick
cost rather than repeatedly overshooting an unachievable target.

Even after both fixes, video through Streamlit stayed visibly less smooth
than the OpenCV window — and that's an architectural ceiling, not a bug to
keep chasing. Every frame through `st.image()` in a fragment pays a real
Python→encode→WebSocket→browser round-trip; `app.py`'s OpenCV window blits
natively with none of that. **Scoping decision, made explicitly rather than
discovered by a judge**: `app.py` stays the live moment-to-moment monitoring
interface; the Streamlit dashboard is the incident-review and operator
workflow (Acknowledge/Resolve) surface, where occasional video choppiness is
an acceptable tradeoff. This matches how the roadmap itself scoped Phase 13
— a prototype stage, with a hardened React + FastAPI dashboard (real video
streaming, not `st.image()`) named as the eventual production version.

**Correction, found by actually measuring it**: the video lag was *not*
architectural after all. Added a temporary diagnostic printing the real
wall-clock gap between fragment ticks — it showed a steady **~1000ms** gap
despite `render_video` being configured for `run_every=0.1` (100ms), while
our own code inside each tick measured only **1-2ms**. Our code was never
the bottleneck. Root cause: two `st.fragment`s with *different* `run_every`
values on the same page (video at 0.1, incidents at 1) collapsed onto a
shared ~1-second cadence rather than running independently — a real
Streamlit quirk, not documented anywhere obvious. Fixed by merging both into a single fragment. First attempt tried to keep
the incidents panel on its own slower cadence *within* that one fragment by
manually clearing a placeholder (created outside the fragment) and
redrawing a variable-length subtree of widgets into it each time — this
crashed the browser outright with a "Bad 'setIn' index" error. Fragments
already replace their own contents automatically between reruns; fighting
that with a manual `.empty()` + rebuild trick desyncs the frontend's element
tracking. Fixed properly by removing that entirely: both the video and the
incidents panel now render directly, every tick (`run_every=0.2`), with no
placeholder tricks — exactly the same plain per-tick-update pattern the
video placeholder always used safely. This is the actual lesson from this
whole investigation: measure before concluding "architectural limitation,"
and don't fight a framework's own state-management model with manual
workarounds when the plain, direct approach already works.

## FPS: throttled Re-ID / face recognition (app.py)

Directly measured (not assumed) per-call cost on this machine: YOLOv8s +
ByteTrack ~12ms/frame, Re-ID embed ~7.6ms (ResNet-18; now 2.9ms since the
switch to OSNet x0.25, but the throttle below still pays for itself with
multiple people in frame), InsightFace embed ~6.4ms — and both Re-ID and face/watchlist recognition were running on
*every single frame, for every detected person*, even once that person's
identity was already resolved. That's ~14ms/person/frame of avoidable
repeated work, since appearance barely changes frame-to-frame once known.

Fixed by only re-checking Re-ID and face/watchlist recognition every
`REID_FACE_CHECK_INTERVAL` frames (default 5) once a track's identity is
already resolved — a brand-new track is still checked every frame
unthrottled, since `PersonGallery.resolve()` needs consecutive samples to
decide an identity in the first place (skipping those frames would prevent
it from ever resolving). Verified the throttle logic itself with a
standalone call-count simulation before touching the live app: full-rate
during the buffering phase, settling into exactly 1-in-5 calls once
resolved — an ~80% reduction in that per-person cost. **Live-verified**:
noticeably higher FPS and smoother video on the webcam feed after the change.
