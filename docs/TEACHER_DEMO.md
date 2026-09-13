# IBVAP — Intelligent Border Video Analytics Platform
## Teacher / Evaluator Demonstration Guide

This guide provides a structured, zero-surprise script for presenting IBVAP to teachers, evaluators, and judges.

---

### 1. 30-Second Architecture Explanation (The Elevator Pitch)

> *"IBVAP is an edge-native, air-gapped border video analytics system designed for zero-false-alarm surveillance. Unlike black-box AI tools, IBVAP couples YOLOv8 object detection and ByteTrack multi-target tracking with geometric polygonal zones, vector-based movement direction analysis, and an explainable, deterministic threat scoring engine. Every alert is audited, backed by AES-Fernet encrypted evidence images, recorded into local SQLite databases, and monitored in real time via an operational dashboard."*

```
CAMERA / DEMO INPUT
       ↓
PREPROCESSING
       ↓
DETECTION (YOLOv8 ONNX)
       ↓
TRACKING (ByteTrack / Track ID)
       ↓
GROUND POINT CALCULATION (Bottom-Center: (x1+x2)/2, y2)
       ↓
GEOMETRIC ZONES (cv2.pointPolygonTest: RED > YELLOW > GREEN)
       ↓
DIRECTION & KINEMATICS (Inward / Outward Vector + Speed)
       ↓
TEMPORAL CONFIRMATION (3-frame Debounce / Cooldown)
       ↓
THREAT SCORING (Explainable 0-100 Breakdown)
       ↓
ALERT ENGINE (Siren, Chime, Visual Banner)
       ↓
INCIDENT STORE (Fernet Encrypted Snapshots & Crops)
       ↓
SQLITE DATABASE (`incidents.db` + `threat_rules.db`)
       ↓
FASTAPI REST & WEBSOCKET API (`/api/v1/`)
       ↓
COMMAND CENTER REACT DASHBOARD
```

---

### 2. Startup Health Check

Before initiating any surveillance, IBVAP validates all subsystem prerequisites. 

To demonstrate startup verification:
```bash
./venv/bin/python runtime/startup_check.py
```
**Expected Output:**
```
============================================================
 IBVAP STARTUP HEALTH CHECK
============================================================
 Detector Models          : ✓ READY (yolov8s.onnx, 42.7MB)
 Re-ID Models             : ✓ READY (osnet_x0_25_msmt17.onnx, 0.9MB)
 Database Storage         : ✓ READY (database/incidents.db)
 Evidence Storage         : ✓ READY (snapshots/, Fernet KEY_EXISTS)
 Camera CAM-01            : ✓ ONLINE (profile: RED PRIORITY)
 Camera CAM-02            : ✓ ONLINE (profile: YELLOW PRIORITY)
 Camera CAM-03            : ✓ ONLINE (profile: GREEN PRIORITY)
 Zone Configurations      : ✓ LOADED (3/3 camera profiles active)
------------------------------------------------------------
 SYSTEM STATUS            : 🟢 SYSTEM READY
============================================================
```

---

### 3. Camera Zone Profiles

IBVAP organizes surveillance into strategic operational tiers:
- **CAM-01 (Red Priority / Immediate Perimeter)**: Restricted border buffer line. Any inward intrusion triggers instant critical escalation.
- **CAM-02 (Yellow Priority / Approach Strip)**: Intermediate zone. Flags approaching targets, loitering persistence, and anomalous trajectory.
- **CAM-03 (Green Priority / Own Territory / Outer Boundary)**: Base monitoring zone. Detections logged with low baseline threat score.

The Command Center dashboard visually displays these profiles on the camera monitoring cards.

---

### 4. Running the Deterministic 15-Step Demonstration

The demonstration uses a deterministic simulated detection path for **Track #17**, while **every single downstream module executes real production code**:

#### Option A: Running from the Terminal
```bash
./venv/bin/python scripts/run_demo.py
```

#### Option B: Running from the Dashboard UI
1. Start backend: `./venv/bin/python app.py` (or `uvicorn integration.api:app --port 8000`)
2. Start dashboard: `cd frontend && npm run dev`
3. Navigate to `http://localhost:5173/dashboard`
4. Click **[ RUN FULL DEMO ]** or advance step-by-step with **[ NEXT STEP ]**.

---

### 5. Step-by-Step Walkthrough

| Step | Pipeline Stage | What Occurs in Real Production Code | Visible Evidence |
|:---|:---|:---|:---|
| **1** | Person Detection | Frame ingested, target bounding box detected (`conf=0.94`) | Detection box drawn on frame |
| **2** | Tracking Created | ByteTrack assigns unique `track_id=17` | Bounding box label: `#17 person` |
| **3** | Ground Point & GREEN | Ground point `((x1+x2)/2, y2)` evaluated with `pointPolygonTest` against green polygon | `ZONE: GREEN` overlay, baseline score |
| **4** | Movement Vector | Vector `(0, -16)` computed; matches inward approach vector | `DIR: INWARD`, Speed: 4.2 m/s |
| **5** | Enters YELLOW | Ground point crosses into middle polygon strip | `ZONE: YELLOW`, Yellow notification |
| **6** | Zone Crossing (RED) | Ground point enters restricted polygon (`YELLOW -> RED`) | `ZONE: RED`, Border line crossing triggered |
| **7** | Temporal Confirmation | Transition confirmed across consecutive frames (debounced) | Confirmed state transition logged |
| **8** | Threat Scoring | `ThreatScorer` queries `threat_rules.db` across all 7 weighted risk factors | `ThreatScore.breakdown()` computed |
| **9** | Threat Escalation | Score calculates to **96/100 [CRITICAL]** with explainable reasons: <br>• *Entered RED zone (+25)*<br>• *Moving INWARD toward border (+18)*<br>• *Curfew window active (+18)*<br>• *High approach speed (+10)*<br>• *Loitering persistence exceeded (+10)*<br>• *Confirmed target classification (+12)*<br>• *Group movement detected (+3)* | Red on-screen alert banner with full reasons |
| **10** | Zone Crossing Event | `ZONE_CROSSING` critical event emitted | Event bus notification |
| **11** | Real Alert Generated | `AlertManager` triggers RED alert, handles cooldown to suppress duplicate noise | Audio siren trigger & visual flash |
| **12** | Evidence Encryption | Full frame & target crop encrypted using symmetric Fernet key at rest | Encrypted `.jpg.enc` files saved in `snapshots/` |
| **13** | Database Persistence | Incident stored with ID, track_id=17, timestamp, breakdown JSON, threat level | Verified in `database/incidents.db` |
| **14** | Live Stream Publishing | Live JPEG frame published to `runtime/live/cam0.jpg` & health updated | Live monitor updates in UI |
| **15** | Dashboard History | Incident appears in Recent Incidents table with Acknowledge/Resolve controls | Visible in UI Incident table |

---

### 6. Verifying Persistence and Evidence to the Evaluator

Show the teacher the real database records and encrypted evidence:

1. **Query Database**:
   ```bash
   sqlite3 database/incidents.db "SELECT id, track_id, tier, score, threat_level, timestamp FROM incidents WHERE track_id=17 ORDER BY id DESC LIMIT 1;"
   ```
2. **Inspect Encrypted Evidence Directory**:
   ```bash
   ls -lh snapshots/*.jpg.enc
   ```
3. **Verify Evidence Decryption**:
   Explain that evidence cannot be viewed with raw image viewers because it is encrypted with Fernet at rest for air-gapped data protection. The IBVAP API decrypts it on-the-fly for authenticated operators via `/api/v1/incidents/{id}/evidence/snapshot`.

---

### 7. Switching to Live Camera Mode

To demonstrate that the system also operates with live video sources:
```bash
DEMO_MODE=false ./venv/bin/python app.py
```
In this mode, `cv2.VideoCapture` streams from your configured RTSP camera or USB device `/dev/video0`, passing real frames through the identical downstream pipeline.
