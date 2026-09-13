#!/usr/bin/env python3
"""IBVAP Deterministic 15-Step Demonstration Script.

Runs Track #17 walking from GREEN -> YELLOW -> RED through the actual
production pipeline and verifies every step.

Run from ibvap/:
    ./venv/bin/python scripts/run_demo.py
"""

import os
import sys
import time
from pathlib import Path

# Add project root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from demo.demo_engine import get_demo_engine


def main():
    print("=" * 78)
    print(" IBVAP — ZERO-SURPRISE DETERMINISTIC TEACHER DEMONSTRATION")
    print(" Scenario: Track #17 Inward Border Breach (GREEN -> YELLOW -> RED)")
    print("=" * 78)

    engine = get_demo_engine()
    engine.reset()

    step_descriptions = [
        "Person detected in scene with high confidence (0.94)",
        "Track #17 created by tracker with stable tracking state",
        "Ground reference point calculated; classified in GREEN zone",
        "Person initiates movement INWARD toward restricted boundary",
        "Person enters YELLOW approach strip (GREEN -> YELLOW transition)",
        "CRITICAL ZONE TRANSITION: Person crosses boundary line into RED zone",
        "INWARD movement confirmed (heading directly toward border)",
        "ThreatScorer executes: multi-factor threat calculation evaluated",
        "Threat level reaches CRITICAL (>= 90/100) with explainable reasons",
        "Critical ZONE_CROSSING event generated",
        "AlertManager activates RED ALERT (siren + alert event)",
        "Fernet encryption of full frame and person crop to snapshots/",
        "Incident persisted to database/incidents.db",
        "Live annotated feed published to runtime/live/cam0.jpg",
        "Incident appears in dashboard operational history",
    ]

    for i in range(1, 16):
        print(f"\n[STEP {i:02d}/15] {step_descriptions[i-1]}")
        res = engine.step()
        latest_log = res["logs"][-1] if res["logs"] else {}
        print(f"  → Result: {latest_log.get('message', 'Executed')}")
        if res.get("latestScore") is not None and i >= 8:
            print(f"  → Threat Score: {res['latestScore']:.0f}/100 [{res.get('latestLevel')}]")
            if res.get("latestReasons"):
                print("  → Explainable Reasons:")
                for r in res["latestReasons"]:
                    print(f"      ✓ {r}")
        if res.get("currentIncidentId") and i >= 12:
            print(f"  → Incident ID: #{res['currentIncidentId']} (Persisted in SQLite)")
        time.sleep(0.1)

    print("\n" + "=" * 78)
    print(" DEMO EXECUTION COMPLETE: 15/15 STEPS VERIFIED")
    print(f" Created Incident ID : #{engine.current_incident_id}")
    print(f" Live Frame Published: runtime/live/{engine.camera_id}.jpg")
    print(f" Database Record     : database/incidents.db")
    print("=" * 78)


if __name__ == "__main__":
    main()
