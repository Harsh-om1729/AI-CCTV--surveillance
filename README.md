<div align="center">

<img src="frontend/src/assets/hero.png" width="120" alt="" />

# IBVAP
### Intelligent Border Video Analytics Platform

**Edge-native, air-gapped, explainable video analytics for zero-false-alarm perimeter security.**

[![Python](https://img.shields.io/badge/python-3.13-blue)](requirements.txt)
[![Backend](https://img.shields.io/badge/backend-FastAPI-009688)](integration/api.py)
[![Frontend](https://img.shields.io/badge/frontend-React%2018%20%2B%20TS-61DAFB)](frontend)
[![Runs offline](https://img.shields.io/badge/network-fully%20offline-success)](#-offline-by-design)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](#-contributing)

[Quick Start](#-quick-start) · [Architecture](#how-it-works) · [Project Status](#-project-status) · [Contributing](#-contributing) · [Docs](#-documentation)

</div>

---

IBVAP watches a camera feed, decides — with a fully explainable, deterministic
score — whether what it's seeing is a real threat, and alerts a human with
tamper-evident evidence to back it up. No cloud, no black-box model, no
network required to run. Built for a Smart India Hackathon border-security
problem statement, it's grown into a real, tested, multi-phase pipeline that
still has interesting phases left to build — which is where you come in.

## Why it's different

- 🧠 **Explainable, not a black box.** Every alert prints its own score
  breakdown — `T = S_sector + T_time + K_kinematics + C_class` — so an
  operator (or a judge, or a reviewer) can see exactly *why* a 0–100 score
  landed where it did, never just a bare "threat detected."
- 🔌 **Actually offline.** Detection, tracking, zones, scoring, alerting and
  the incident database run with zero network access — verified live with
  Wi-Fi disabled, not just designed that way on paper. See
  [Offline by design](#-offline-by-design).
- 🎯 **Tuned against real false positives, not synthetic ones.** Every
  detection quirk in the [engineering log](docs/ENGINEERING_LOG.md) — a bent
  knee mistaken for a second person, strangers matched by a Re-ID model,
  nine alerts for one stationary person — was caught on a live camera first,
  then fixed, then re-verified live.
- 🔒 **Evidence you can trust.** Incident snapshots are AES/Fernet-encrypted
  at rest, and every incident carries a full lifecycle
  (`DETECTED → CONFIRMED → ALERTED → ACKNOWLEDGED → RESOLVED`).
- 🪶 **Runs on modest hardware.** A `HARDWARE_PROFILE=low` switch roughly
  doubles throughput on a fanless Intel i3/i5 box with no GPU — see
  [Phase 26](docs/ENGINEERING_LOG.md#phase-26--low-power-hardware-profile).

## How it works

```
CAMERA / VIDEO STREAM
       │
PREPROCESSING          night / fog CLAHE, activity gating
       │
DETECTION              YOLOv8s, ONNX Runtime
       │
TRACKING               ByteTrack, multi-target association
       │
RE-IDENTIFICATION      OSNet appearance embedding — survives brief occlusion
       │
ZONE ENGINE             polygon or fixed-tier Red / Yellow / Green classification
       │
KINEMATICS             inward / outward direction + speed estimate
       │
TEMPORAL CONFIRMATION   N-of-M debounce, hysteresis, backoff
       │
THREAT SCORING          explainable 0–100 score, transparent reasons
       │
ALERT ENGINE            siren / chime, rate-limited, escalation bypass
       │
INCIDENT LIFECYCLE      DETECTED → CONFIRMED → ALERTED → ACKNOWLEDGED → RESOLVED
       │
EVIDENCE AT REST         AES-Fernet encrypted snapshots & crops
       │
   ┌───┴────────────────────────┐
SQLITE (incidents /          FASTAPI REST + WEBSOCKET
threat_rules / watchlist)        │
                          REACT + TYPESCRIPT DASHBOARD
```

<details>
<summary><b>Repo layout</b> — where each stage of the pipeline lives</summary>

| Path | Stage |
|---|---|
| `camera/` | stream ingestion — webcam & RTSP, auto-reconnect |
| `preprocessing/`, `activity_gate/` | low-light/fog enhancement, motion-gated idle rate |
| `detection/` | YOLOv8 ONNX object detection |
| `tracking/` | ByteTrack multi-target tracking |
| `reid/` | OSNet cross-camera person re-identification |
| `filtering/` | false-alarm filtering (aspect-ratio, etc.) |
| `zones/` | polygon & fixed-tier zone engine |
| `intelligence/` | offline threat-rules DB + threat scoring |
| `face/` | InsightFace recognition + watchlist matching |
| `alerts/` | siren/chime alert engine, rate limiting |
| `database/` | SQLite incident store + encrypted evidence |
| `integration/` | FastAPI REST/WebSocket, webhook, syslog |
| `dashboard/` | Streamlit operator dashboard (ack/resolve workflow) |
| `frontend/` | React + TypeScript + Tailwind command center UI |
| `scripts/` | demo runner, benchmarks, accuracy eval, health check |
| `deploy/` | systemd units for production deployment |
| `tests/` | 341 unit tests |
| `docs/` | deploy guide, demo script, engineering log |

</details>

## 🚀 Quick Start

```bash
git clone https://github.com/Harsh-om1729/SIH.git
cd SIH
```

> [!IMPORTANT]
> Model weights (`models/*.onnx`, ~130 MB) are gitignored and **won't be
> there after a fresh clone**. Get `models/` from a teammate, or regenerate
> the YOLO detector yourself with `yolo export model=yolov8n.pt format=onnx`.
> InsightFace's face model downloads itself on first run if you have
> internet at least once. Full detail: [Setup & offline
> operation](docs/ENGINEERING_LOG.md#setup--dependencies).

```bash
# 1. Health check — verifies models, databases, encryption keys, cameras
./venv/bin/python runtime/startup_check.py

# 2. Deterministic demo — a track walks GREEN → YELLOW → RED through the
#    real production pipeline: zones, scorer, alerts, encrypted evidence, DB
./venv/bin/python scripts/run_demo.py

# 3. Run the platform
./venv/bin/python app.py              # terminal 1 — backend API + monitor
cd frontend && npm run dev            # terminal 2 — command center UI
```

Then open `http://localhost:5173/dashboard`. Or use `./run.sh`, which wraps
the venv setup and launch for you. A full walkthrough (built for a
teacher/judge demo) is in [docs/TEACHER_DEMO.md](docs/TEACHER_DEMO.md).

### 🔌 Offline by design

Detection, tracking, zones, scoring, alerting and the incident database need
**zero network access** — confirmed live with Wi-Fi fully disabled. The only
two things that ever touch the network are one-time, optional, and now both
fail *safely* if skipped: InsightFace's face model (auto-downloads once,
degrades to "no face recognition" instead of crashing if unavailable) and
outbound webhook/syslog integrations (opt-in, non-blocking). Details in the
[engineering log](docs/ENGINEERING_LOG.md#offline-operation--whats-actually-true).

## 📊 Project Status

Phases 0–16 built the core pipeline end to end; phases 17+ are hardening it
for unattended, evaluated, real-world running. 341 unit tests (1 documented
expected failure — see [Phase 18](docs/ENGINEERING_LOG.md#known-gap-carried-as-an-expected-failure)).

<details open>
<summary><b>Core pipeline — Phases 0–16</b> ✅ complete</summary>

Camera input · multi-camera streams · weather/low-light preprocessing ·
adaptive activity gating · YOLO detection · ONNX runtime · ByteTrack tracking
· false-alarm filtering + OSNet Re-ID · 3-zone tactical logic · offline
threat intelligence · explainable threat scoring · tiered alerting ·
encrypted incident evidence · facial recognition & watchlist · local
dashboard · offline/air-gapped operation · cross-camera Re-ID · C2
integration (REST, webhook, syslog).

Full detail on every phase, including what was tried and rejected along the
way, is in the [engineering log](docs/ENGINEERING_LOG.md).

</details>

<details>
<summary><b>Hardening — Phases 17–30</b> — mixed done / open, this is where contributions land</summary>

| Phase | What | Status |
|---|---|---|
| 17 | Truth in documentation, auth, cleanup | ✅ done |
| 18 | Alert discipline — N-of-M confirmation, hysteresis, backoff | ✅ done |
| **19** | **Zone & score correctness** — demo zones, sustained-presence override, scale-normalised speed | 🟡 open |
| **20** | **Survivability** — camera reconnect, real `/status` health, non-blocking dispatch, retention | 🟡 open |
| **21** | **Measured accuracy** — labelled set, precision/recall, range bands, Intel benchmark | 🟡 open |
| 22 | Deployability — headless mode, systemd, single served frontend | ✅ done |
| **23** | **Multi-camera scale** — shared model + batched inference | 🟡 open |
| **24** | **Compliance & evidence integrity** — watchlist audit log, hash chain | 🟡 open |
| **25** | **Environmental robustness** — dehaze, contrast triggers, zone drift | 🟡 open |
| 26 | Low-power hardware profile | ✅ done |

</details>

## 🤝 Contributing

Contributions are very welcome — from a one-line fix to picking up one of the
🟡 open phases above. There's no separate CONTRIBUTING.md; here's what you
need:

1. **Fork the repo and branch off `Harsh`** (the active development branch):
   `git checkout -b your-feature Harsh`
2. **Set up the environment**: `./run.sh` handles the venv and launch for
   you — avoid invoking `python`/`streamlit` directly, paths assume the venv.
   You'll need `models/` from a teammate first (see [Quick
   Start](#-quick-start)).
3. **Run the tests before and after your change**:
   `./venv/bin/python -m unittest discover -s tests -p "test_*.py"`.
   Add tests for new behavior — this project's whole culture is "unit-tested
   or live-verified, and say which"; keep that bar.
4. **If you touch the pipeline's behavior** (detection, scoring, alerting,
   zones), try to verify it against a real camera, not just unit tests, and
   say what you observed in the PR description — see the
   [engineering log](docs/ENGINEERING_LOG.md) for the standard this project
   holds itself to.
5. **Open a PR against `Harsh`**, describing what changed and why.

**Good places to start:**
- Any 🟡 open phase in the [status table](#-project-status) above — each one
  has a scoped description; full rationale is in
  [docs/HARDENING_ROADMAP.md](docs/HARDENING_ROADMAP.md) and
  [docs/AUDIT.md](docs/AUDIT.md).
- Browse [open issues](https://github.com/Harsh-om1729/SIH/issues) on
  GitHub.
- The known gap tracked as `@unittest.expectedFailure` in
  `tests/test_threat_score.py` — see
  [why](docs/ENGINEERING_LOG.md#known-gap-carried-as-an-expected-failure).

Not sure where to plug in? Open an issue describing what you're interested
in — pipeline stage, dashboard/frontend, deployment, docs — and it'll get
pointed to the right spot.

## 📚 Documentation

| Doc | What's in it |
|---|---|
| [docs/ENGINEERING_LOG.md](docs/ENGINEERING_LOG.md) | Full phase-by-phase build log: benchmarks, bugs found, fixes, live-verification notes |
| [docs/TEACHER_DEMO.md](docs/TEACHER_DEMO.md) | Scripted demo walkthrough for a live audience |
| [docs/DEPLOY.md](docs/DEPLOY.md) | systemd deployment guide for the target Linux box |
| [docs/HARDENING_ROADMAP.md](docs/HARDENING_ROADMAP.md) | Full phase-by-phase plan for phases 17–30, with rationale |
| [docs/AUDIT.md](docs/AUDIT.md) | The audit findings that drove the hardening roadmap |
| `.env.example` | Every runtime setting, documented inline |

## License

This project doesn't have an open-source license yet — until it does,
treat it as all-rights-reserved outside of contributing directly here. Open
an issue if you'd like to use it elsewhere and want to discuss licensing.

---

<div align="center">

Built for Smart India Hackathon · edge-native · explainable · offline-first

</div>
