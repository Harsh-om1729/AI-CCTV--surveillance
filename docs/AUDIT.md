# IBVAP — Pre-Evaluation Engineering Audit

**Audited:** commit `32db3da` (branch `Harsh`) · **Date:** 10 Sep 2026
**Revised:** 10 Sep 2026 — added C3 and L4 after a second pass over long-run behaviour and blocking calls.
**Evidence base:** source read end-to-end, 75 tests executed, 513 incidents and 986 evidence files queried from the project's own databases.

Every figure in this document came from the code or the data, not from estimation. Nothing in the repository was changed — this is an assessment, not a set of applied fixes.

---

## Scorecard

| Axis | Score | Reasoning |
|---|---|---|
| **Current capability** | **6 / 10** | Unusual feature breadth for a hackathon build, and every stage genuinely runs. Marked down because the scoring layer — the actual product — is uncalibrated. |
| **Technical maturity** | **4 / 10** | Test suite is red. Two modules are dead code. Three documented settings don't exist in the source. The engineering *notes* are excellent; the engineering *hygiene* has slipped behind them. |
| **Real-world readiness** | **3 / 10** | No camera reconnect, no calibration, no thermal path, no retention limit, unauthenticated API. This is a lab prototype and should be pitched as one. |
| **SIH competitiveness** | **7 / 10** | Breadth, offline operation and an explainable score are real differentiators. The risk is not losing on ideas — it's an alert storm or a crashed demo in front of judges. |

---

## Four things to fix before anyone sees this

| Figure | What it is |
|---|---|
| **99.4** | Alerts per minute at peak, measured from your own `incidents.db`. One person, one webcam. |
| **4** | Failing tests right now. The README and hand-off notes both claim the suite is green. |
| **0** | Incidents carrying a zone. All 513 have `zone_tier='none'` — the border logic has never fired one. |
| **65** | Max score for a person in the red zone at 2am. Red needs 70. Without a direction reading, nothing escalates. |

---

## Where it is genuinely strong

Stated once, then dropped — the rest of this document is the cons.

- **Air-gapped by construction.** Models ship on disk, rules and watchlist are local SQLite, nothing fetched at runtime. Verified with Wi-Fi off. Most competing entries will be cloud-dependent.
- **Explainable scoring.** `breakdown()` names the components that drove a tier. "Why did it alert?" has an answer; black-box entries won't have one.
- **Re-ID done properly.** Histogram → ResNet-18 → OSNet, each rejected on *measured* separation (0.139 vs 0.371 gap). This is the strongest engineering story you have — lead with it.
- **Honest failure notes.** The README documents what didn't work, including a retracted "architectural limitation". Judges reward this if you surface it deliberately.
- **Integration surface exists.** Webhook, syslog, REST — non-blocking and fail-safe. The right shape for feeding an existing C2, even if thin.
- **Evidence encrypted at rest.** Fernet-encrypted full/crop/burst images with a queryable index. Ahead of typical hackathon "save a JPEG" handling.

---

# CONS

Severity: **P0** = fix before evaluation · **P1** = materially better answers if time allows · **P2** = present as roadmap.

## Build integrity — fix first, they're cheap

### B1 — The test suite is red, and the docs say it's green · **P0**

- **Problem.** `python -m unittest discover -s tests -t .` gives **75 tests, 3 failures + 1 error**. All four are in the threat-score layer; they still reference `slow_speed_px_per_frame`, a config key that no longer exists since the U-curve replaced the old linear movement rule. `tests/` was last touched 5 Sep; `intelligence/threat_score.py` changed in yesterday's commit.
- **Impact.** Nobody has run the suite since the change. Beyond stale keys, `test_person_in_red_zone_at_night_moving_fast_scores_red` is a *real* regression, not a stale assertion — see A1.
- **Judge challenge.** "You claim 73 passing tests. Run them for me."
- **Fix.** Update the four tests to the new config keys, and treat the red-zone failure as a scoring bug rather than editing the assertion to match. Under an hour.

### B2 — `.env` documents three settings that don't exist in the code · **P0**

- **Problem.** `.env` defines `IBVAP_API_TOKEN` — commented *"Unset = the API refuses all requests"* — plus `WATCHLIST_KEY_PATH` and `ALERT_DISPATCH_QUEUE_SIZE`. Grep finds zero references to any of them outside that file. `integration/api.py` is 28 lines with no auth code at all.
- **Impact.** The config file states a security control that does not exist. Anyone who can reach port 8000 reads the full incident feed. It also explains the orphan `database/watchlist.key`: written for a feature never wired up, then committed to a public repo.
- **Judge challenge.** "Your config says the API refuses unauthenticated requests. Show me where that's enforced."
- **Fix.** Implement the bearer check in `api.py` (a 5-line FastAPI dependency), or delete the three settings and the stale comment. Do not leave a security claim the code doesn't back.

### B3 — The kinematic threat model is finished, committed, and never called · **P1**

- **Problem.** `intelligence/kinematic_score.py` and `zones/border_line.py` are complete, with a `SCORING_MODEL` switch and nine `KINEMATIC_*` settings. `app.py` imports neither, and builds `ZoneDrawer` without a `border_store` (`app.py:232`), so the `b` key can't draw a border line. Setting `SCORING_MODEL=kinematic` does nothing.
- **Impact.** Your best-reasoned piece of modelling — exponential proximity, time-to-breach, logarithmic loiter — is invisible in the demo. It also has no tests.
- **Judge challenge.** A judge who opens the repo sees a scoring model the running system doesn't use. That reads as padding.
- **Fix.** Either wire it in (border store + switch + tests, ~half a day) or move it to a clearly-labelled `experimental/` and say so in the README. Don't ship it in the middle of the live path unused.

---

## Alert fatigue — the single biggest weakness

**Measured from `database/incidents.db`.** Eight runs, all a single person in front of a laptop webcam:

| Run start | Duration | Alerts | **Alerts/min** | Tiers |
|---|---:|---:|---:|---|
| 08 Sep 17:47 | 36 s | 7 | 11.6 | 7 red |
| 08 Sep 18:19 | 5 s | 2 | 23.0 | 2 red |
| 08 Sep 22:54 | 165 s | 197 | **71.7** | 12 red, 185 yellow |
| 08 Sep 23:48 | 164 s | 106 | 38.7 | 5 red, 101 yellow |
| 08 Sep 23:58 | 83 s | 137 | **99.4** | 17 red, 120 yellow |
| 09 Sep 00:09 | 15 s | 21 | **81.2** | 5 red, 15 yellow |
| 09 Sep 01:33 | 52 s | 39 | 45.3 | 39 yellow |
| 09 Sep 12:59 | 13 s | 5 | 23.2 | 5 red |

A sentry can act on roughly 1–2 alerts per minute. Each of these 513 incidents also wrote 1–3 encrypted evidence images — **986 files on disk**. A real sector with vehicles, livestock and patrols would multiply this.

### F1 — The cooldown is bypassed every time the score crosses a tier boundary · **P0**

- **Problem.** `AlertManager.handle()` fires immediately whenever `escalated` is true — tier rank higher than last frame — regardless of the 8-second cooldown. A score hovering at the Green/Yellow boundary (30/31) oscillates green→yellow→green→yellow, and *every* upward crossing counts as an escalation. Recorded scores of 30.5, 39.4 and 40.0 sit exactly in that band.
- **Impact.** The measured 38–99 alerts/min above. Siren, snapshot burst, DB write, webhook and syslog on each one. This is the failure that gets a real system muted on day one.
- **Judge challenge.** "What's your false-alarm rate per hour, and what stops an operator from switching it off?"
- **Fix.** Three changes, half a day total: (1) **hysteresis** — require the score to exceed the boundary by a margin, and hold there for N consecutive frames, before the tier changes; (2) apply the cooldown to escalations too, just with a shorter floor; (3) require N-of-M frames of agreement before any alert. Then re-run and put the before/after alerts-per-minute figure on a slide.

### F2 — Night alone produces a Yellow alert with no border context at all · **P0**

- **Problem.** Scoring a person with no zone drawn, standing still at 2am: `time 18 + move 10 + class 12 = 40` → **Yellow**. Zero of those points relate to a border. This is why all 513 incidents carry `zone_tier='none'`.
- **Impact.** Any person visible anywhere in frame at night alerts, forever, on a loop. It also means the demo you've been running all week exercised the *generic motion alarm* path, not the border logic.
- **Judge challenge.** "So at night it alerts on any human in view. How is that a border system rather than a motion detector?"
- **Fix.** Make time-of-day a **multiplier** on zone-derived risk rather than an independent additive term, so no-zone context can't reach Yellow on its own. Cap the no-zone ceiling at Green and let the existing startup warning stand.

### F3 — Evidence storage has no retention policy · **P1**

- **Problem.** `IncidentStore` has `record`, `list`, `get`, `acknowledge` and `resolve` — no purge, no cap, no rotation. 986 files accumulated from a week of desk testing.
- **Impact.** At the alert rates above, a field box fills its disk in days, then fails in the worst way: silently, mid-incident, with writes failing while the pipeline keeps running.
- **Judge challenge.** "Deployed for six months at a remote post, how much storage does this need?"
- **Fix.** Age- and size-based purge on startup and hourly (keep all Red for N days, Yellow for M), plus a disk-space check that degrades to metadata-only rather than crashing.

---

## Accuracy, false positives and false negatives

### A1 — Nothing reaches Red without a direction reading — including a man lying at the fence · **P0**

- **Problem.** Computed against the live rules DB: person, red zone, 2am, running, no direction label = `25 + 18 + 10 + 12 = 65` → **Yellow**. Red (70) is reachable only via the crossing override, which needs a direction label, which needs movement of ≥4 px over the history window (`ZoneEngine.MIN_DIRECTION_MAGNITUDE`). A stationary or distant subject never gets one.
- **Impact.** The two postures the README explicitly designs for — someone lying still at the fence, and a slow crawl — both cap at Yellow, a soft chime. Meanwhile the U-curve awards them *full* movement risk for being still, so the system half-recognises the threat and then refuses to escalate it.
- **Judge challenge.** "Walk me through what happens when someone crawls to the fence and lies still for ten minutes."
- **Fix.** Add a sustained-presence override: person in a red zone for >N seconds forces Red regardless of direction, mirroring the existing crossing and watchlist overrides. The loiter term already tracks the dwell — it just tops out at 10 points, not enough to cross the line alone.

### A2 — Your demo zone config forces Red on anyone moving in a quarter of the frame · **P0**

- **Problem.** `config/zones_cam0.json` holds a single red polygon covering **27.8% of the 640×480 frame**, with no green zone. With no green reference, `_direction_label` returns `"crossing"` for any movement — which is in `CROSSING_DIRECTIONS`, so the override forces Red ≥70 for every person moving more than 4 px anywhere in that quarter of the screen.
- **Impact.** Live demo behaviour: step into the middle of the frame, get an instant siren and a snapshot burst. It looks like a system with no discrimination — precisely the opposite of the tiered logic you built.
- **Judge challenge.** "It went Red the moment I walked in. What would make it *not* alert?"
- **Fix.** Redraw the demo zones properly: a thin red band as the line, a yellow approach strip, and a green own-territory polygon so inward/outward resolve. Rehearse a scripted demo showing Green → Yellow → Red as you approach — that *is* the pitch.

### A3 — No measured accuracy exists, anywhere · **P0**

- **Problem.** 75 unit tests, all synthetic, all logic-level. There is no precision, recall, mAP, false-alarms-per-hour or ROC figure for detection, for Re-ID, or for the alert decision. The Re-ID separation numbers (0.501 vs 0.872) are the only measured accuracy in the project, and they come from a handful of crops.
- **Impact.** Every accuracy question gets answered with a description of the architecture instead of a number. Against a team with a confusion matrix, you lose that exchange.
- **Judge challenge.** "What's your detection accuracy, and on what data?"
- **Fix.** Highest value-per-hour item on this list. Label 200–300 frames from `video7.mp4` and any borrowed border/CCTV footage, run detection and the alert decision over it, and report precision/recall plus false alarms per hour. Even a small, honestly-scoped set beats no number.

### A4 — Distant walkers are scored as stationary, and stationary means maximum risk · **P1**

- **Problem.** Speed is `px/frame` of box centre, uncalibrated (`tracking/tracker.py`). The U-curve calls anything ≤1.0 px/frame "still" and awards full movement risk. A person walking at 80 m occupies few pixels and moves well under 1 px/frame, so they're classed as stationary; someone strolling close to the lens lands in the 2–8 px "walking" band and scores zero.
- **Impact.** Risk is inversely correlated with distance in a way nobody intended. The same behaviour scores differently based purely on range, and every threshold is specific to one lens at one mounting height.
- **Judge challenge.** "Your thresholds are in pixels. What happens when I move the camera, or zoom in?"
- **Fix.** Cheap and strong: divide speed by **box height** to get body-lengths per second, which is roughly scale-invariant, and retune the bands in those units. Half a day, and it turns "your numbers are arbitrary" into a good answer. Full homography calibration is the proper fix and the honest roadmap item.

### A5 — One aspect-ratio test is the entire false-alarm defence · **P2**

- **Problem.** `FalseAlarmFilter` checks only that height/width falls in a per-class range — and after being widened to admit reclining people, "person" now accepts 0.2 to 4.0, which is nearly everything.
- **Impact.** Swaying foliage, headlight glare, rain streaks and reflections that YOLO mislabels pass straight through to scoring. In daylight, in a real sector, this is the dominant false-positive source and nothing downstream catches it.
- **Judge challenge.** "What happens in wind, with trees moving behind the fence?"
- **Fix.** Add temporal confirmation (a track must persist N frames before it can alert) and a static-region mask for known-noisy areas. Temporal confirmation also fixes half of F1 — do them together.

---

## Night, weather and occlusion

### N1 — Weather handling only runs in the dark · **P1**

- **Problem.** `Preprocessor.process()` returns the raw frame unless mean brightness is below 90. The temporal median filter, CLAHE and gamma all sit behind that gate. Fog, haze, dust and heavy rain are *bright, low-contrast* conditions — brightness stays above 90, so no enhancement runs. The class docstring says the median filter is "always" applied; the code returns before it.
- **Impact.** "Weather preprocessing" is really "low-light preprocessing". The daytime conditions that actually degrade a border camera get nothing.
- **Judge challenge.** "Rajasthan dust storm, or Punjab winter fog at 8am — what does your pipeline do differently?"
- **Fix.** Trigger on **contrast** (grayscale standard deviation) as well as brightness, and add a dehaze path — dark-channel prior is ~30 lines and costs little. Then fix the docstring.

### N2 — No thermal or IR path, on a system whose whole purpose is night · **P1**

- **Problem.** Everything assumes a visible-light sensor. CLAHE plus gamma on a dark visible frame amplifies sensor noise as much as signal; it does not create information that isn't there.
- **Impact.** Real border surveillance at night is thermal. On a moonless night with no illumination, detection performance is unknown and probably poor — and untested, because a laptop webcam in a lit room can't test it.
- **Judge challenge.** "BSF uses thermal imagers. Why should we deploy a visible-light system?"
- **Fix.** Don't fake it. Say plainly that the pipeline is sensor-agnostic — YOLO retrained on thermal, everything downstream unchanged — and that thermal validation needs hardware you don't have. Then test against any public thermal clip you can find, even a handful of frames, so the claim has something behind it.

### N3 — The activity gate can be fooled in both directions · **P2**

- **Problem.** `ActivityGate` thresholds the *mean* absolute frame difference over a 320px-wide grayscale image. A slow crawl changes few pixels and averages to nothing; wind-blown vegetation or a swaying camera changes many and pins the gate permanently open.
- **Impact.** In the first case the pipeline drops to the idle keep-alive rate exactly when something is approaching. In the second, the power saving the gate exists for disappears.
- **Judge challenge.** "What does your motion gate do when the wind blows, and what does it do to someone crawling?"
- **Fix.** Switch from mean to a **count of changed pixels** above a per-pixel threshold — sensitive to small persistent changes, robust to broad low-amplitude noise. Keep a hard floor on full-pipeline rate regardless of the gate.

---

## Tracking and distant objects

### T1 — Re-ID and face recognition both switch off at range · **P1**

- **Problem.** `PersonGallery` skips any box smaller than 40×60 px, so no embedding, no `person_id`. InsightFace `buffalo_s` needs a face of tens of pixels; at border ranges a face is 2–5 px. The watchlist is effectively a close-range, near-frontal feature.
- **Impact.** Everything keyed on `person_id` — loiter dwell, cross-camera identity, alert rate-limiting — silently falls back to raw `track_id` for distant subjects. Rate limiting then resets on every ID churn, feeding the alert storm in F1.
- **Judge challenge.** "At what range does your facial recognition stop working?"
- **Fix.** Answer with the number rather than dodging: state the pixel-height floor for each stage and present them as range bands (detect / track / re-identify / recognise face) at a stated focal length. That's the DORI framing an evaluator already understands, and it turns a weakness into evidence of rigour.

### T2 — Zone geometry is hand-drawn pixels, and breaks the moment the camera moves · **P1**

- **Problem.** Zones are image-space polygons in `config/zones_<cam>.json`, drawn by hand per camera. Direction is derived from polygon *centroids*, so one global axis represents the whole border — fine for a straight fence in view, wrong for a curved one.
- **Impact.** A knock, a maintenance adjustment, wind on a pole or any PTZ movement invalidates every zone with no detection and no warning. The system keeps reporting confident tiers against geometry that no longer matches the scene.
- **Judge challenge.** "Who redraws the zones when a camera is serviced, and how do you know it's needed?"
- **Fix.** Store a reference frame with the zone file and run a cheap feature-match at startup and hourly; if the homography drifts past a threshold, raise a maintenance alert and mark that camera's tiers unreliable. A day's work, and it directly answers a deployment question.

---

## Real-time performance and multi-camera scale

### R1 — Every performance number comes from the wrong hardware · **P0**

- **Problem.** 7.1 ms / 140 FPS was measured on an Apple M4 with the CoreML execution provider — Neural Engine and GPU. The stated deployment target is an Intel i3/i5 field box. On that hardware ONNX falls back to the CPU provider, and INT8 (which was *slower* on the Mac, 86.8 ms) has never been tested where it would actually help.
- **Impact.** The headline FPS does not transfer, and you can't say by how much. The README caveats this honestly, which is good — but a caveat is not a number.
- **Judge challenge.** "What frame rate do you get on the hardware you're proposing to deploy?"
- **Fix.** Borrow any Intel laptop for an hour and run `scripts/bench_pipeline.py` on it. One real datapoint on target-class hardware — even a mediocre one — is worth more than the M4 figure, and lets you state the cameras-per-box limit honestly.

### M1 — Cameras are processed one after another, each with its own copy of the model · **P1**

- **Problem.** `app.py` builds a separate `Tracker` — and therefore a separate 45 MB YOLOv8s instance — per camera, then processes them sequentially in one loop on one thread. No batching, no shared model, no parallelism.
- **Impact.** Effective frame rate divides by camera count and memory multiplies by it. A slow or glitchy camera stalls every other camera's processing. "Multi-camera" currently means two on a laptop, not a sector.
- **Judge challenge.** "How many cameras per box, and what happens at ten?"
- **Fix.** Share one model instance across cameras and batch their frames into a single inference call — the highest-leverage scale change available. State a *measured* cameras-per-box figure rather than an aspiration.

### M2 — The dashboard and the live app can't run at the same time · **P1**

- **Problem.** `dashboard/streamlit_app.py` constructs its own full pipeline, including its own `Tracker` per camera, and opens the camera itself. Two processes competing for one USB device, with two sets of models loaded.
- **Impact.** You cannot show the OpenCV tactical view and the operator dashboard simultaneously — a real problem for a demo where you want both. In deployment it means two independent detection results with no shared state.
- **Judge challenge.** Not a question — a visible stumble if you try to show both at once.
- **Fix.** Short term, rehearse so only one runs at a time and say which is which. Proper fix: one capture-and-detect service with the dashboard reading incidents and frames from it — the FastAPI + React architecture the roadmap already names as the production version.

---

## Network and camera failures

### C1 — A camera that drops for three seconds is gone until you restart the process · **P0**

- **Problem.** `CameraStream._run()` counts consecutive read failures and `break`s out of its loop after 50 (~2.5 s). The producer thread then exits permanently. There is **no reconnect anywhere** in `StreamManager`. The main loop sees `None` forever and simply skips that camera.
- **Impact.** Any transient Wi-Fi drop, PoE flap, brief power cut or router reboot silently and permanently disables that camera. One `log.warning` is the only trace. A blind spot in a border system, produced by a three-second network hiccup.
- **Judge challenge.** "Field networks are unreliable. What happens when a camera link drops for thirty seconds?"
- **Fix.** Replace the `break` with a reconnect loop and exponential backoff, re-opening the `CameraSource` and continuing. Emit a Red-tier system alert on camera loss and another on recovery. A few hours' work, and it removes the most embarrassing single failure in the codebase.

### C2 — `/status` reports "ok" unconditionally · **P0**

- **Problem.** `integration/api.py` returns a hardcoded `{"status": "ok", "service": "IBVAP"}`. It doesn't know whether the pipeline is running, whether any camera is alive, or when the last frame arrived — the API process shares no state with `app.py`.
- **Impact.** Combined with C1: a camera dies permanently, and the health endpoint a C2 system polls keeps reporting healthy. A monitoring endpoint that cannot report ill health is worse than none, because it is trusted.
- **Judge challenge.** "How does the control room know a camera has failed?"
- **Fix.** Have the pipeline write a heartbeat per camera (last frame time, FPS, consecutive failures) to SQLite, and have `/status` read it and report degraded/down per camera. Half a day, and it makes the C2 integration credible instead of decorative.

### C3 — The webhook blocks the detection loop for up to 3 seconds per alert · **P0**

- **Problem.** `WebhookNotifier.notify()` calls `requests.post(..., timeout=3.0)` **synchronously**, and `AlertManager._notify_integrations()` calls it from inside the main pipeline loop. Exceptions are swallowed, so it is fail-*safe* — but it is not non-blocking, which is what the roadmap and README claim. Syslog is genuinely non-blocking (UDP fire-and-forget); the webhook is not.
- **Impact.** A slow, unreachable or hanging C2 endpoint freezes detection for up to 3 seconds **per alert**. At the alert rates in F1 the pipeline would spend most of its time waiting on HTTP, dropping frames across every camera. The unimplemented `ALERT_DISPATCH_QUEUE_SIZE` in `.env` shows a background dispatch queue was intended and never built (see B2).
- **Judge challenge.** "What happens to detection if your C2 server goes down or gets slow?"
- **Fix.** Move all outbound notification onto a bounded background queue with a worker thread — drop oldest on overflow, exactly as the camera queues already do. Then `ALERT_DISPATCH_QUEUE_SIZE` becomes a real setting instead of a phantom one.

---

## Dataset and model limitations

### D1 — A face match at 0.5 similarity forces a Red siren · **P0**

- **Problem.** `WATCHLIST_SIMILARITY_THRESHOLD=0.5`, and any match sets `score.tier = "red"` outright. For ArcFace-style embeddings 0.5 cosine is a permissive operating point; published thresholds usually sit higher. Today's five Red alerts at exactly score 70 with `zone_tier='none'` are watchlist overrides firing outside any zone.
- **Impact.** A false face match escalates straight past every other safeguard. On biometric data, under the DPDP Act, a wrong identification carries consequences beyond a noisy alert.
- **Judge challenge.** "What's your false-match rate, and what happens to the person it misidentifies?"
- **Fix.** Raise to ~0.6 and validate on whatever face set you can assemble. Require two consecutive matching frames. Consider making a watchlist hit escalate *one tier* rather than jumping to Red, so it combines with context instead of overriding it.

### D2 — Stock COCO weights, never fine-tuned on anything border-like · **P1**

- **Problem.** Off-the-shelf YOLOv8s on COCO. COCO contains upright, well-lit, mostly close pedestrians in everyday scenes — not crawling or prone figures, camouflage, tiny distant targets, night imagery, or Indian rural vehicles. Phase 7A's vehicle classification is COCO's own car/truck/bus/motorcycle classes, which is honest but not domain-specific.
- **Impact.** Detection is weakest in exactly the postures that matter most. There's no measurement of how weak, which loops back to A3.
- **Judge challenge.** "COCO has no prone-person class. How do you detect someone crawling?"
- **Fix.** Fine-tune on any relevant public set you can reach before the deadline, even a few hundred images. If there's no time, say clearly that the model is stock and that fine-tuning is the first deployment step — with the training pipeline ready to show.

### D3 — The roadmap claims ANPR; there is no ANPR · **P1 (do it today — it's an hour)**

- **Problem.** The Roadmap's §1 capability table lists ANPR as covered. No `anpr/` module exists and nothing reads plates. Indian-specific vehicle classes (tractor) are likewise absent.
- **Impact.** If this reaches a slide or a submitted document unqualified, it's a claim you cannot demonstrate — the worst category of finding, because it costs credibility on everything else you *can* show.
- **Judge challenge.** "Show me the number plate recognition."
- **Fix.** Audit `SIH_PPT_Content.md`, `IBVAP_Architecture_Slide.html` and `IBVAP_Pitch_Deck.html` for this claim today and move it to a clearly-marked future-work section. Pure risk removal.

---

## Real-world deployment

### L1 — It needs a desktop GUI to run at all · **P1**

- **Problem.** `app.py` calls `cv2.namedWindow` and `cv2.imshow` unconditionally and reads keys via `cv2.waitKey`. Zone drawing is only available through that window. No headless mode, no service unit, no auto-restart, no log rotation.
- **Impact.** A field box is a headless machine reached over SSH. As written, the system cannot run as a service, cannot restart after power loss, and cannot be configured without a monitor and mouse at the post.
- **Judge challenge.** "How does this run unattended at a border outpost for a month?"
- **Fix.** Add a `--headless` flag that skips all window calls, plus a sample systemd unit with restart-on-failure. A few hours, and it converts a laptop demo into something that reads as deployable.

### L2 — Biometric watchlist with no consent, audit or retention model · **P1**

- **Problem.** The README flags the DPDP Act caveat, which is more than most teams do. But there's no implementation behind it: no audit log of who was matched or searched, no retention limit on face embeddings, no consent or authorisation record, no deletion path. Watchlist embeddings sit unencrypted in `watchlist.db` — the key file that exists for them is wired to nothing (see B2).
- **Impact.** A judge from a policy or legal background will press here, and "we noted it in the README" is a thin answer for a system processing biometric data on non-consenting subjects.
- **Judge challenge.** "Under the DPDP Act, who authorises adding a face, and who can audit the matches?"
- **Fix.** Add an append-only audit table (who added an entry, when, on what authority; every match logged), a retention field per entry, and a delete path. A day's work that converts a documented caveat into a demonstrated control.

### L3 — Evidence is encrypted but not tamper-evident · **P2**

- **Problem.** Fernet encryption protects confidentiality at rest. There's no hash chain, no signature, no trusted timestamp, and the key sits beside the data it protects. Anyone with filesystem access can re-encrypt a modified image and no check would notice.
- **Impact.** If evidence is ever meant to support a prosecution or inquiry, that's the first thing challenged. The current design proves secrecy, not integrity.
- **Judge challenge.** "Would this footage stand up as evidence?"
- **Fix.** Store a SHA-256 of each image in the incidents row and chain each row's hash to the previous one. A dozen lines, and it upgrades the answer from "it's encrypted" to "it's tamper-evident".

### L4 — Four dictionaries grow without bound over a long run · **P1**

- **Problem.** `Tracker._track_history` is keyed by `track_id` and never purged — every ID ByteTrack ever mints keeps up to 10 position tuples forever. Same pattern in `app.py`'s `person_id_cache` and `watchlist_cache`, and in `AlertManager._last_tier` / `_last_alert_time`. `PersonGallery` and `LoiterTracker` both purge correctly, so the pattern was understood — it just wasn't applied consistently.
- **Impact.** Irrelevant in a 3-minute desk test; a slow leak in the month-long unattended deployment the system is pitched for. Your ID churn is heavy (the incident DB reached rowid 2542 for 513 surviving rows), so these dicts grow faster here than the design assumes.
- **Judge challenge.** "This runs for six months at a remote post. What's the memory profile?"
- **Fix.** Give each an age-based purge on the same TTL pattern `PersonGallery._purge_stale()` already uses. An hour's work, and it turns "should be fine" into a stated answer.

---

# JUDGE PERSPECTIVE

Ranked by damage if unprepared.

### 1. "What is your false alarm rate, and how do you stop alert fatigue?"
**Risk: fatal** — every surveillance project is judged on this.
**Say now:** name the rate-limiting design — per-track cooldown, escalation bypass, tier-based responses — and be honest that you measured a storm in desk testing and fixed it.
**Change first:** F1. Then quote the before/after alerts-per-minute figure. A team that measured its own false-alarm rate and cut it beats a team that never looked.

### 2. "Show me it working at night, in fog, or on a crawling person."
**Risk: high** — likely to be requested live.
**Say now:** low-light enhancement is implemented and demonstrable; fog and thermal are not; prone-person detection is limited by COCO.
**Change first:** record demo clips in the worst conditions you can actually stage — a dark room, a phone torch, someone crawling. A recorded honest failure you can explain beats declining to show anything.

### 3. "What frame rate on the deployment hardware, and how many cameras per box?"
**Risk: high** — trivially exposed by one follow-up.
**Say now:** 140 FPS on Apple Silicon with CoreML; on Intel it falls back to CPU and hasn't been measured.
**Change first:** R1 and M1. One Intel benchmark plus a shared batched model turns this from a dodge into a specification.

### 4. "A camera drops off the network. What happens?"
**Risk: high** — and an easy live test for a judge.
**Say now:** nothing good — it stays down until restart. Don't bluff; it's four lines of code to check.
**Change first:** C1 and C2 together. Then *demo* it: unplug the camera mid-run, show the alert, plug it back in, show recovery. That lands harder than most feature demos.

### 5. "Why is this better than a motion detector with a siren?"
**Risk: high** — goes to the core of the pitch.
**Say now:** tiered zones, direction-aware crossing, loiter, group, cross-camera identity, explainable score.
**Change first:** A2 — with the current demo zones the honest answer is uncomfortable, because at night with no zones drawn it *is* effectively a motion alarm. Fix the zones and rehearse the Green→Yellow→Red approach walk.

### 6. "What data did you train and validate on?"
**Risk: high** — expect it from any technical judge.
**Say now:** stock COCO YOLOv8s, no border-specific fine-tuning, validated by live testing rather than a labelled set.
**Change first:** A3. Even 200 labelled frames with a precision/recall number changes this from a weakness into a methodology answer.

### 7. "Your slides mention ANPR. Show me."
**Risk: severe** — an unbacked claim taints everything else.
**Say now:** nothing — remove the claim before the question can be asked.
**Change first:** D3, today.

### 8. "You're storing faces. What's your legal basis under the DPDP Act?"
**Risk: medium-high** — likely from a policy-side judge.
**Say now:** you've identified it as requiring authorised data-handling procedures and treated it as a deployment prerequisite, not a modelling detail.
**Change first:** L2 — an audit table and a retention field turn a caveat into a control you can point at on screen.

### 9. "Do your tests pass?"
**Risk: medium** — but humiliating live, and trivial to prevent.
**Say now:** only after B1 is fixed. Right now the honest answer is "71 of 75".
**Change first:** B1 — under an hour, and the cheapest credibility on this entire page.

---

# PRIORITY

See `IBVAP_Fix_Checklist.md` for the tickable version.

## P0 — before anyone external sees the system (~3 days)

| # | Fix | Ref | Effort | Why it's first |
|---:|---|---|---:|---|
| 1 | Strip the ANPR claim from all pitch material | D3 | 1 h | Pure risk removal, costs nothing |
| 2 | Fix the four failing tests | B1 | 1 h | Cheapest credibility available |
| 3 | Hysteresis + N-of-M confirmation on alerts | F1, A5 | 0.5 d | Kills the 99/min storm; unblocks a clean demo |
| 4 | Cap no-zone scoring below Yellow | F2 | 2 h | Stops "it's just a motion alarm" |
| 5 | Redraw demo zones; rehearse the approach walk | A2 | 2 h | Makes the tiered logic visible instead of always-Red |
| 6 | Camera reconnect with backoff + loss/recovery alerts | C1 | 3 h | Removes the worst single failure; becomes a demo |
| 7 | Real per-camera health in `/status` | C2 | 0.5 d | Makes the C2 integration credible |
| 8 | Sustained-presence override for Red | A1 | 2 h | The lying-at-the-fence case is your own headline scenario |
| 9 | Raise face threshold to ~0.6; require 2 frames | D1 | 1 h | Stops false biometric escalation |
| 10 | API auth, or delete the setting that claims it | B2 | 1 h | Don't ship a security claim the code doesn't back |
| 11 | Benchmark on any Intel machine | R1 | 2 h | Turns a dodge into a specification |
| 12 | Background queue for webhook dispatch | C3 | 2 h | Stops a slow C2 server freezing detection |

## P1 — materially better answers if time allows (~1 week)

| # | Fix | Ref | Effort | What it buys |
|---:|---|---|---:|---|
| 14 | Label 200–300 frames; report precision/recall + FA/hour | A3 | 1–2 d | The single highest-value item on this page |
| 13 | Scale-normalise speed by box height | A4 | 0.5 d | Answers "your thresholds are arbitrary" |
| 15 | Share one model across cameras; batch inference | M1 | 1 d | A real cameras-per-box number |
| 16 | Wire the kinematic model in, or move to `experimental/` | B3 | 0.5 d | Removes dead code from the live path |
| 17 | Contrast-triggered enhancement + dehaze | N1 | 0.5 d | Makes "weather" mean weather |
| 18 | Evidence retention and disk-space guard | F3 | 0.5 d | Answers the six-month deployment question |
| 19 | Headless mode + systemd unit | L1 | 3 h | Reads as deployable rather than a laptop demo |
| 20 | Watchlist audit log + retention field | L2 | 1 d | Converts the DPDP caveat into a control |
| 20 | Zone drift detection against a reference frame | T2 | 1 d | Answers the camera-maintenance question |
| 22 | Publish range bands per stage (detect/track/re-ID/face) | T1 | 0.5 d | Turns a limit into evidence of rigour |
| 23 | Age-based purge on the four unbounded dicts | L4 | 1 h | Answers the long-run memory question |

## P2 — name these as roadmap, don't attempt them now

| Item | Ref | How to present it |
|---|---|---|
| Thermal / IR sensor support | N2 | Pipeline is sensor-agnostic; needs retraining and hardware you don't have |
| Fine-tuning on border imagery | D2 | Training pipeline ready; blocked on a labelled dataset |
| Homography calibration to metres | A4 | Box-height normalisation is the interim; full calibration is the proper fix |
| Tamper-evident evidence chain | L3 | Hash chain designed, not yet implemented |
| Improved activity gating | N3 | Changed-pixel count instead of mean difference |
| ANPR and Indian vehicle classes | D3 | Explicitly future work — never as a current capability |
