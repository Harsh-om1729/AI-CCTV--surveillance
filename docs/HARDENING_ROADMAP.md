# IBVAP — Hardening Roadmap (Phases 17–25)

### Turning the audit into buildable phases, in the same shape as the original Roadmap

Companion to `IBVAP_Audit.md` (26 findings) and `IBVAP_Fix_Checklist.md`.
The original Roadmap's Phases 0–16 built the *capability*. These phases make it *hold up* — under a judge's questions, and under a month of unattended running.

**Same working rule as before:** one phase at a time, live-tested on the webcam, confirmed working before the next one starts. Each phase below states its own live test, because a phase without one is a phase you can't claim.

---

## Sequencing logic

The order is not by severity. It's by **dependency and demo risk**:

1. **Phase 17 first** because a red test suite means you can't tell whether any later phase broke something.
2. **Phase 18 before 19** because you cannot tune scoring while the alert layer is firing 99 times a minute — you'd have no signal to read.
3. **Phase 21 (measurement) after 18–19** because measuring accuracy against the *current* alert logic would measure the bug, not the system.
4. **Phases 22–25 are parallelisable** if more than one person is working.

```
17 Truth ──▶ 18 Alert discipline ──▶ 19 Zone & score ──▶ 21 Measurement ──▶ SIH-ready
              │                                   │
              └──▶ 20 Survivability ──────────────┤
                          │                       │
                          ├──▶ 22 Deployability   │
                          ├──▶ 23 Scale           │
                          ├──▶ 24 Compliance      │
                          └──▶ 25 Environment ────┘
```

**Minimum viable path if time is short:** 17 → 18 → 19 → 20. That's about four days and it removes every finding that can lose you the room.

---

## 5A. Phase-by-Phase Hardening Plan

**Phase 17 — Truth in Documentation** · *0.5 day* · closes **D3, B1, B2**
Nothing here changes behaviour; everything here changes what you can safely claim.
- Strip the ANPR claim from `SIH_PPT_Content.md`, `IBVAP_Architecture_Slide.html`, `IBVAP_Pitch_Deck.html`, `IBVAP_Architecture.html` and Roadmap §1. Move to a marked future-work section. Same for Indian-specific vehicle classes.
- Fix the four failing tests (`test_threat_score.py` ×3, `test_threat_rules.py` ×1) — they still reference `slow_speed_px_per_frame`, replaced by `still_/walk_min_/walk_max_/fast_speed_px_per_frame`. Do **not** edit the red-zone assertion to pass; that one is a real bug, fixed in Phase 19.
- Reconcile `.env` with the code: `IBVAP_API_TOKEN`, `WATCHLIST_KEY_PATH` and `ALERT_DISPATCH_QUEUE_SIZE` are read by nothing. Implement the API bearer check or delete the settings and their comments. Delete the orphan `database/watchlist.key`.
- Update `ibvap/README.md`'s phase checklist to reflect Phases 17–25 as pending.
*Live test:* `python -m unittest discover -s tests -t .` green; the unused-settings loop in the checklist prints nothing.

**Phase 18 — Alert Discipline** · *1 day* · closes **F1, F2, A5**
The single most valuable phase in this document. Everything downstream is unreadable until the alert layer is quiet.
- **Hysteresis** in `alerts/alert_manager.py`: a tier change requires the score to pass the boundary by a margin *and* hold for N consecutive frames. Today a score oscillating across 30/31 counts as a fresh escalation every time and bypasses the cooldown entirely.
- **Cooldown on escalations too** — a shorter floor, not an exemption.
- **N-of-M track confirmation** before any alert: a track must persist and agree across M frames. This also closes A5, since foliage and glare rarely produce a stable track.
- **No-zone ceiling**: make time-of-day a *multiplier* on zone-derived risk instead of an additive term, so `time 18 + move 10 + class 12 = 40` can no longer reach Yellow with no border context.
- Instrument it: log alerts/minute so the improvement is a number, not an impression.
*Live test:* repeat the 08 Sep 23:58 scenario (one person, one webcam, ~90 s). Baseline was **99.4 alerts/min**. Record the new figure — that before/after pair is a slide.

**Phase 19 — Zone & Score Correctness** · *1 day* · closes **A1, A2, A4, D1**
- **Redraw the demo zones.** `config/zones_cam0.json` is currently one red polygon over 27.8% of the frame with no green zone — so `_direction_label` returns `"crossing"` for any movement and the override forces Red on everyone. Draw a thin red band (the line), a yellow approach strip, and a green own-territory polygon so inward/outward actually resolve.
- **Sustained-presence override**: person in a red zone for more than N seconds forces Red regardless of direction. Right now a man lying still at the fence at 2am caps at 65 — Yellow — because Red is only reachable through the crossing override, which needs ≥4px of movement.
- **Scale-normalise speed**: divide px/frame by box height → body-lengths/second, and retune the U-curve bands in those units. Today a distant walker reads as "still" and collects *maximum* movement risk.
- **Watchlist threshold** 0.5 → ~0.6, requiring two consecutive matching frames; consider escalating one tier rather than jumping straight to Red.
*Live test:* walk toward the camera and confirm the tier steps **Green → Yellow → Red**; stand still in the red zone and confirm it reaches Red on dwell alone; repeat the same walk at two distances and confirm the movement score is comparable.

**Phase 20 — Survivability** · *1 day* · closes **C1, C2, C3, F3, L4**
Everything that determines whether this survives an hour unattended, let alone a month.
- **Camera reconnect.** `CameraStream._run()` currently `break`s after 50 consecutive failures (~2.5 s) and the producer thread dies permanently — a three-second Wi-Fi drop blinds that camera until the process restarts. Replace with reconnect + exponential backoff, re-opening `CameraSource`. Emit a system alert on loss and on recovery.
- **Real health in `/status`.** The pipeline writes a per-camera heartbeat (last frame time, FPS, consecutive failures) to SQLite; `integration/api.py` reads it and reports ok/degraded/down instead of a hardcoded `"ok"`.
- **Non-blocking alert dispatch.** `WebhookNotifier.notify()` is a synchronous `requests.post` with a 3 s timeout called from the main loop — a slow C2 server freezes detection. Move outbound notification to a bounded background queue with a worker thread, dropping oldest on overflow, exactly as the camera queues already do. `ALERT_DISPATCH_QUEUE_SIZE` becomes real.
- **Retention + disk guard.** Age- and size-based purge (Red kept N days, Yellow M days), and degrade to metadata-only when disk runs low rather than failing writes mid-incident.
- **Purge the leaking dicts**: `Tracker._track_history`, `app.py`'s `person_id_cache` / `watchlist_cache`, and `AlertManager._last_tier` / `_last_alert_time` all grow without bound. Reuse the TTL pattern `PersonGallery._purge_stale()` already implements.
*Live test:* unplug the camera mid-run → alert fires; plug it back in → recovers with no restart; `/status` reflects both transitions. **Rehearse this as a demo** — it lands harder than most feature demos.

**Phase 21 — Measured Accuracy** · *1–2 days* · closes **A3, T1, R1**
The phase that converts "we built a lot" into "here are our numbers".
- Label 200–300 frames from `video7.mp4` plus any borrowed border/CCTV footage. Even a small, honestly-scoped set beats no number.
- Run detection **and the alert decision** over it. Report precision, recall, and false alarms per hour — the alert-level figure matters more than mAP for this brief.
- **Range bands**: state the pixel-height floor per stage (detect / track / re-identify / recognise face — Re-ID skips boxes under 40×60 px, faces need far more) and convert to metres at a stated focal length. That's the DORI framing an evaluator already knows, and it turns a limitation into evidence of rigour.
- **Intel benchmark**: borrow any Intel laptop and run `scripts/bench_pipeline.py`. Every current number is Apple M4 + CoreML; the deployment target is an i3/i5 field box, where ONNX falls back to the CPU provider and INT8 has never been tested where it would actually help.
*Live test:* a one-page results table you'd be willing to hand a judge.

**Phase 22 — Deployability** · *0.5 day* · closes **L1, M2**
- `--headless` flag skipping `namedWindow` / `imshow` / `waitKey`; zone config loadable without a GUI.
- Sample systemd unit with restart-on-failure, plus log rotation.
- Resolve the dashboard/app collision: `dashboard/streamlit_app.py` builds its own `Tracker` per camera and opens the camera itself, so it cannot run alongside `app.py` on one device. Short term, rehearse so only one runs at a time. Proper fix: one capture-and-detect service, dashboard reads from it — the FastAPI + React architecture the original Roadmap already names as the production version.
*Live test:* runs over SSH with no display; survives `kill -9` and restarts on its own.

**Phase 23 — Multi-Camera Scale** · *1 day* · closes **M1**
- Share **one** model instance across cameras and batch their frames into a single inference call. Today `app.py` builds a separate 45 MB YOLOv8s per camera and processes them sequentially on one thread, so frame rate divides by camera count and memory multiplies by it.
- Publish a measured cameras-per-box figure at a stated resolution and FPS floor, on the Intel machine from Phase 21.
*Live test:* two cameras at once with flat memory and a per-camera FPS you can state.

**Phase 24 — Compliance & Evidence Integrity** · *1 day* · closes **L2, L3**
- **Watchlist audit trail**: append-only table recording who added an entry, when, on what authority — and every match, with score. Retention field per entry plus a delete path.
- **Tamper-evident evidence**: SHA-256 per image stored in the incidents row, each row's hash chained to the previous. Fernet gives you confidentiality; this gives you integrity, which is what actually gets challenged.
*Live test:* add a watchlist entry and show the audit row; modify an evidence file and show the chain detecting it.

**Phase 25 — Environmental Robustness** · *1 day* · closes **N1, N3, T2**
- **Contrast-triggered enhancement**: `Preprocessor.process()` gates everything behind brightness < 90, so fog, dust and haze — bright, low-contrast conditions — get no enhancement at all. Trigger on grayscale standard deviation as well, and add a dark-channel-prior dehaze (~30 lines). Fix the docstring claiming the median filter "always" runs.
- **Activity gate**: replace mean absolute frame difference with a *count of changed pixels* above a per-pixel threshold — sensitive to a slow crawl, robust to wind-blown foliage. Keep a hard floor on full-pipeline rate regardless of the gate.
- **Zone drift detection**: store a reference frame with each zone file, feature-match at startup and hourly, and raise a maintenance alert if the homography drifts. Zones are hand-drawn pixels; a knock or a service adjustment silently invalidates them today.
*Live test:* a hazy or fogged frame (steam, a breathed-on lens) triggers enhancement; nudging the camera raises a drift alert.

**Phase 26 — Low-Power Hardware Profile** · *0.5 day* · added after the audit (a teammate's Intel laptop ran at ~10 fps)
- `HARDWARE_PROFILE=low`: 416-input YOLOv8n export, `ORT_NUM_THREADS=1`, `REID_FACE_CHECK_INTERVAL=10`, `IDLE_MIN_FPS=5`; any value set explicitly still wins.
- Re-ID and face stop hardcoding the CPU provider and prefer OpenVINO when `onnxruntime-openvino` is installed.
- Measured CPU-only on the M4: 16.1 → 33.8 fps at under one core; no precision/recall loss on the reviewed eval frames.
*Live test:* on the Intel laptop, `bench_pipeline.py` before/after, with and without `onnxruntime-openvino` — which is also Phase 21's missing Intel benchmark.

---

## 5B. Deferred — state as roadmap, don't attempt before SIH

| Item | Ref | How to present it |
|---|---|---|
| Thermal / IR sensor support | N2 | Pipeline is sensor-agnostic — retrain YOLO on thermal, everything downstream unchanged. Needs hardware you don't have; say so plainly. |
| Fine-tuning on border imagery | D2 | Training pipeline ready, blocked on a labelled dataset. COCO has no prone-person or camouflage class. |
| Homography calibration to metres | A4 | Box-height normalisation (Phase 19) is the interim; full calibration is the proper fix. |
| ANPR + Indian vehicle classes | D3 | Explicitly future work. Never a current capability. |
| Kinematic scoring model | B3 | Decide in Phase 17: wire it in, or move to `experimental/`. Don't ship an unused model in the live path. |

---

## 6A. Beyond the audit — additions worth building

These are not fixes. They are things the system doesn't have that would materially strengthen the submission, found while reading the code rather than from the finding list.

**A. Replay mode** — *0.5 day, highest value of the four*
Run the whole pipeline over a recorded file and emit an incident report, with no camera attached. `CameraSource` already handles file sources and throttles to native FPS, so most of this exists.
Why it matters: it makes your evaluation **reproducible** (Phase 21 becomes a repeatable command, not a manual session), it lets you demo night or fog footage you can't stage live, and it gives a judge something to run themselves. It also decouples demo success from a webcam working in an unfamiliar room — which is a real risk on the day.

**B. Preflight self-test** — *2 hours*
`python -m scripts.preflight`: models present and loadable, cameras reachable, zones drawn for every configured camera, DBs writable, disk space sufficient, audio device available, key files present. Prints a pass/fail table.
Why it matters: it directly answers "how would a jawan deploy this?", it catches a broken demo *before* you're standing in front of judges, and it's the natural home for the "NO ZONES DEFINED" warning `app.py` already emits.

**C. Operational metrics endpoint** — *3 hours, do with Phase 20*
Extend the Phase 20 heartbeat into `/metrics`: alerts per hour by tier, mean FPS per camera, camera uptime percentage, incidents pending acknowledgement, disk used.
Why it matters: it's how you *show* the Phase 18 improvement rather than asserting it, and it makes the C2 integration look like a product instead of a demo endpoint. The dashboard already has acknowledge/resolve — this closes the loop by measuring operator load.

**D. Rule-tuning CLI** — *2 hours*
`scripts/tune_rules.py` to read and edit `threat_rules.db` values with validation and a diff, instead of hand-editing SQL.
Why it matters: the Roadmap's own claim is "tune locally, no code changes". Right now that means opening a SQLite shell. A small CLI makes the claim demonstrable, and the DB already supports it — seeding is one-time precisely so local tuning survives.

---

## 6B. Demo rehearsal — treat this as a phase

The audit's finding A2 exists because the demo config was never designed as a demo. Budget half a day near the end for a scripted run:

1. **Preflight** (addition B) — everything green on screen.
2. **Zones on screen** — show Red line, Yellow approach, Green own-territory as drawn geometry, not as a claim.
3. **The approach walk** — Green → Yellow → Red, reading the score breakdown aloud at each step. This is the pitch; it needs the Phase 19 zones to work.
4. **Loiter** — stand still in the red zone, show it reaching Red on dwell alone (Phase 19).
5. **Camera failure** — unplug, alert fires, `/status` goes down, replug, recovers (Phase 20).
6. **Air-gap** — Wi-Fi off, everything still runs. Already verified in Phase 14; just show it.
7. **Numbers** — the Phase 21 accuracy table and the Phase 18 before/after alert rate.
8. **Replay** (addition A) — night or weather footage you couldn't stage live.

Steps 5, 6 and 7 are the ones competing teams won't have.

---

## 7A. Revised effort summary

| Phase | Title | Effort | Findings closed |
|---|---|---:|---|
| 17 | Truth in Documentation | 0.5 d | D3, B1, B2 |
| 18 | Alert Discipline | 1 d | F1, F2, A5 |
| 19 | Zone & Score Correctness | 1 d | A1, A2, A4, D1 |
| 20 | Survivability | 1 d | C1, C2, C3, F3, L4 |
| 21 | Measured Accuracy | 1–2 d | A3, T1, R1 |
| 22 | Deployability | 0.5 d | L1, M2 |
| 23 | Multi-Camera Scale | 1 d | M1 |
| 24 | Compliance & Evidence Integrity | 1 d | L2, L3 |
| 25 | Environmental Robustness | 1 d | N1, N3, T2 |
| — | Additions A–D | 1 d | — |
| — | Demo rehearsal | 0.5 d | — |
| | **Total** | **~9.5–10.5 days** | **26 of 26** |

**Four days** (17–20) removes every finding that can lose you the room.
**Six days** (17–21) gets you there with numbers behind it.

---

## 8A. Expected scorecard movement

Ratings from `IBVAP_Audit.md`, projected against completed phases. These are targets to aim at, not promises — re-rate honestly after Phase 21.

| Axis | Now | After 17–20 | After 17–25 + additions |
|---|:---:|:---:|:---:|
| Current capability | 6 | 7 | 8 |
| Technical maturity | 4 | 7 | 8 |
| Real-world readiness | 3 | 5 | 7 |
| SIH competitiveness | 7 | 8 | 9 |

The largest single movement is **technical maturity, 4 → 7, from Phase 17 alone** — half a day of documentation truth and test repair. That is the cheapest gain available anywhere in this plan, and it's the one most likely to get skipped because it doesn't feel like building.
