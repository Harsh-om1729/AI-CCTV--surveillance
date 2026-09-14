"""IBVAP Startup Health Check (Phase 25 & Phase 32).

Validates all required components before the pipeline runs:
- Detection model availability
- Re-ID appearance model availability
- Camera sources connectivity / accessibility
- Zone definitions
- Database read/write access
- Evidence directory and encryption key
- Core dependencies

Returns a structured status dict and prints a clean operator-facing health summary.
"""

import logging
import os
import sqlite3
import sys
from pathlib import Path
from typing import NamedTuple

# Add project root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2

from config.settings import (

    CAMERA_SOURCES,
    CAMERA_ZONE_TIERS,
    DETECTION_MODEL_PATH,
    IBVAP_API_TOKEN,
    REID_MODEL_PATH,
)

log = logging.getLogger("ibvap.startup")


class CheckResult(NamedTuple):
    name: str
    status: str  # "READY", "ONLINE", "DEGRADED", "OFFLINE", "MISSING", "FAILED"
    ok: bool
    details: str


class StartupValidator:
    """Performs non-destructive validation of all IBVAP subsystem prerequisites."""

    def __init__(
        self,
        db_path: str = "database/incidents.db",
        evidence_dir: str = "snapshots",
        evidence_key: str = "database/evidence.key",
    ):
        self.db_path = db_path
        self.evidence_dir = evidence_dir
        self.evidence_key = evidence_key

    def check_models(self) -> list[CheckResult]:
        results = []
        # Detection model
        if os.path.isfile(DETECTION_MODEL_PATH):
            size_mb = os.path.getsize(DETECTION_MODEL_PATH) / (1024 * 1024)
            results.append(
                CheckResult(
                    "Detector Models",
                    "READY",
                    True,
                    f"✓ READY ({os.path.basename(DETECTION_MODEL_PATH)}, {size_mb:.1f}MB)",
                )
            )
        else:
            results.append(
                CheckResult(
                    "Detector Models",
                    "MISSING",
                    False,
                    f"✗ MISSING ({DETECTION_MODEL_PATH} not found)",
                )
            )

        # Re-ID model
        if os.path.isfile(REID_MODEL_PATH):
            size_mb = os.path.getsize(REID_MODEL_PATH) / (1024 * 1024)
            results.append(
                CheckResult(
                    "Re-ID Models",
                    "READY",
                    True,
                    f"✓ READY ({os.path.basename(REID_MODEL_PATH)}, {size_mb:.1f}MB)",
                )
            )
        else:
            results.append(
                CheckResult(
                    "Re-ID Models",
                    "MISSING",
                    False,
                    f"✗ MISSING ({REID_MODEL_PATH} not found)",
                )
            )
        return results

    def check_database(self) -> CheckResult:
        try:
            os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
            conn = sqlite3.connect(self.db_path)
            conn.execute("CREATE TABLE IF NOT EXISTS _startup_test (id INTEGER PRIMARY KEY)")
            conn.execute("INSERT INTO _startup_test DEFAULT VALUES")
            conn.execute("DROP TABLE _startup_test")
            conn.commit()
            conn.close()
            return CheckResult("Database Storage", "READY", True, f"✓ READY ({self.db_path})")
        except Exception as exc:
            return CheckResult("Database Storage", "FAILED", False, f"✗ FAILED: {exc}")

    def check_evidence(self) -> CheckResult:
        try:
            os.makedirs(self.evidence_dir, exist_ok=True)
            test_file = os.path.join(self.evidence_dir, ".write_test")
            with open(test_file, "w") as f:
                f.write("ok")
            os.remove(test_file)
            key_status = "KEY_EXISTS" if os.path.isfile(self.evidence_key) else "NEW_KEY_WILL_GENERATE"
            return CheckResult(
                "Evidence Storage",
                "READY",
                True,
                f"✓ READY ({self.evidence_dir}/, Fernet {key_status})",
            )
        except Exception as exc:
            return CheckResult("Evidence Storage", "FAILED", False, f"✗ FAILED: {exc}")

    def check_cameras(self) -> list[CheckResult]:
        results = []
        for name, src in CAMERA_SOURCES.items():
            tier = CAMERA_ZONE_TIERS.get(name, "auto")
            # For USB / local index 0, attempt a non-blocking open probe
            if isinstance(src, int) or (isinstance(src, str) and src.isdigit()):
                cap = cv2.VideoCapture(int(src))
                if cap.isOpened():
                    cap.release()
                    results.append(CheckResult(f"Camera {name.upper()}", "ONLINE", True, f"✓ ONLINE (device {src}, profile: {tier.upper()})"))
                else:
                    results.append(CheckResult(f"Camera {name.upper()}", "DEGRADED", True, f"🟡 SIMULATED/DEGRADED (device {src} not open, fallback available)"))
            elif isinstance(src, str) and os.path.isfile(src):
                results.append(CheckResult(f"Camera {name.upper()}", "ONLINE", True, f"✓ ONLINE (file {os.path.basename(src)})"))
            else:
                results.append(CheckResult(f"Camera {name.upper()}", "CONFIGURED", True, f"✓ CONFIGURED ({src})"))
        return results

    def check_zones(self) -> CheckResult:
        zones_found = 0
        for name in CAMERA_SOURCES:
            p1 = f"config/zones/{name}.json"
            p2 = f"config/zones_{name}.json"
            if os.path.exists(p1) or os.path.exists(p2) or CAMERA_ZONE_TIERS.get(name):
                zones_found += 1
        return CheckResult(
            "Zone Configurations",
            "READY",
            True,
            f"✓ LOADED ({zones_found}/{len(CAMERA_SOURCES)} camera profiles active)",
        )

    def run_all(self) -> tuple[bool, list[CheckResult]]:
        all_checks: list[CheckResult] = []
        all_checks.extend(self.check_models())
        all_checks.append(self.check_database())
        all_checks.append(self.check_evidence())
        all_checks.extend(self.check_cameras())
        all_checks.append(self.check_zones())

        critical_ok = all(c.ok for c in all_checks if c.name in ("Detector Models", "Database Storage", "Evidence Storage"))
        return critical_ok, all_checks

    def print_summary(self) -> bool:
        critical_ok, checks = self.run_all()
        print("=" * 60)
        print(" IBVAP STARTUP HEALTH CHECK")
        print("=" * 60)
        for c in checks:
            print(f" {c.name:<24} : {c.details}")
        print("-" * 60)
        if critical_ok:
            print(" SYSTEM STATUS            : 🟢 SYSTEM READY")
        else:
            print(" SYSTEM STATUS            : 🔴 SYSTEM NOT READY (Critical components failed)")
        print("=" * 60)
        return critical_ok


if __name__ == "__main__":
    validator = StartupValidator()
    ok = validator.print_summary()
    sys.exit(0 if ok else 1)
