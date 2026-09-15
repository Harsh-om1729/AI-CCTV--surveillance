import logging
import os
import sqlite3

log = logging.getLogger("ibvap.intelligence")

# Bumped whenever the shipped defaults below change. On startup, rows that
# still hold the *previous* version's default are updated in place; rows that
# were hand-edited locally are left alone (see _migrate). This keeps the
# "seeded once, never clobbered" promise for operator tuning while still
# letting a calibration change reach existing air-gapped installs.
#
# v3 adds five new "_by_zone" tables (movement/loiter/group/direction/class,
# see DEFAULT_*_BY_ZONE below) alongside the existing global ones rather than
# reshaping them in place — a brand-new table always seeds cleanly via
# _seed_table's normal "empty -> insert defaults" path, no value-diffing
# migration needed, and the old global tables are left exactly as they were
# (still used as-is for un-zoned/"none" lookups, and as the fallback if a
# zone-specific row is ever missing).
RULES_VERSION = 3

# --- v2: border-surveillance calibration -----------------------------------
# Budget, so a sentry can reason about the 0-100 total:
#   sector 25 + time 18 + kinematics 10 + class 12
#   + direction 18 + loiter 10 + group 7  = 100
DEFAULT_SECTOR_RISK = {"red": 25.0, "yellow": 12.0, "green": 4.0, "none": 0.0}
DEFAULT_TIME_RISK = {
    **{h: 18.0 for h in range(0, 5)},   # 00:00-04:59, deep night — classic crossing window
    **{h: 14.0 for h in (5, 22, 23)},   # dawn/dusk transition
    **{h: 4.0 for h in range(6, 22)},   # daytime
}
DEFAULT_CLASS_CONFIDENCE = {"person": 12.0, "vehicle": 8.0, "animal": 2.0}

# Kinematics is a U-curve, not "faster = worse". At a border BOTH extremes are
# suspicious: near-stationary means crawling, lying up, or watching the fence
# (how infiltration actually looks), and running means a dash across the line.
# An ordinary walking pace in between is the *least* interesting thing on the
# feed. The previous linear "fast = risk" rule scored a man lying still at the
# fence as zero risk, which is backwards for this deployment.
DEFAULT_MOVEMENT_CONFIG = {
    "still_speed_px_per_frame": 1.0,   # at or below: fully "stationary"
    "walk_min_px_per_frame": 2.0,      # start of the low-risk walking band
    "walk_max_px_per_frame": 8.0,      # end of the low-risk walking band
    "fast_speed_px_per_frame": 14.0,   # at or above: fully "running"
    "max_movement_risk": 10.0,
}

# Direction of travel relative to the border line. Both crossing directions
# score high: inward is infiltration, outward is exfiltration/smuggling.
# "parallel" (moving along the line, not across it) is mildly interesting —
# that is what reconnaissance along a fence looks like.
DEFAULT_DIRECTION_RISK = {
    "inward": 18.0,
    "outward": 16.0,
    "crossing": 18.0,  # in a red zone with no green zone to resolve the sign
    "parallel": 5.0,
    "none": 0.0,       # stationary, or no direction resolved yet
}

# Dwell time inside a non-"none" zone, keyed off the Re-ID person_id so it
# survives ByteTrack losing and re-acquiring the track. Standing at the fence
# is reconnaissance; it is invisible to a speed-based rule.
DEFAULT_LOITER_CONFIG = {
    "warn_seconds": 30.0,
    "warn_risk": 5.0,
    "alert_seconds": 120.0,
    "alert_risk": 10.0,
}

# Number of people simultaneously inside a zone. A group at the line is a
# materially different event from one person.
DEFAULT_GROUP_RISK = {1: 0.0, 2: 3.0, 3: 5.0, 5: 7.0}  # keyed by minimum count

# --- v3: per-zone rule catalogs ---------------------------------------------
# Every category below now has its own red/yellow/green variant instead of one
# shared table. This is the actual "sensitivity" dial: RED is tuned to react
# to *less* evidence (short loiter, small group, modest speed change already
# matter next to the restricted line), GREEN needs substantially more
# evidence before the same behaviour is worth flagging (people and vehicles
# are normal on your own territory), YELLOW sits in between and matches the
# pre-v3 global defaults exactly, so un-zoned/legacy behaviour is unchanged.
#
# The total score formula itself stays zone-agnostic (still a plain sum of
# these components) — zone only changes *how much* each component reports
# for the same raw behaviour, plus the existing ZONE_TIER_THRESHOLDS in
# threat_score.py which changes how much total it takes to escalate. A truly
# suspicious combination in a GREEN zone (fast + group + loitering) can still
# out-total a mild, ordinary crossing in a YELLOW zone; only a RED-zone
# border-line *crossing* is force-escalated regardless of total (see
# ThreatScorer._crossing_override — deliberately not softened: a confirmed
# breach of the restricted line is always at least a high alert).
DEFAULT_MOVEMENT_CONFIG_BY_ZONE = {
    "red": {
        "still_speed_px_per_frame": 1.0,
        "walk_min_px_per_frame": 1.5,
        "walk_max_px_per_frame": 6.0,
        "fast_speed_px_per_frame": 10.0,
        "max_movement_risk": 14.0,
    },
    "yellow": dict(DEFAULT_MOVEMENT_CONFIG),
    "green": {
        "still_speed_px_per_frame": 0.5,
        "walk_min_px_per_frame": 2.5,
        "walk_max_px_per_frame": 10.0,
        "fast_speed_px_per_frame": 18.0,
        "max_movement_risk": 8.0,
    },
}

DEFAULT_LOITER_CONFIG_BY_ZONE = {
    "red": {
        "warn_seconds": 10.0,
        "warn_risk": 8.0,
        "alert_seconds": 45.0,
        "alert_risk": 16.0,
    },
    "yellow": dict(DEFAULT_LOITER_CONFIG),
    "green": {
        "warn_seconds": 90.0,
        "warn_risk": 3.0,
        "alert_seconds": 300.0,
        "alert_risk": 6.0,
    },
}

DEFAULT_GROUP_RISK_BY_ZONE = {
    "red": {2: 5.0, 3: 8.0, 5: 11.0, 8: 14.0},
    "yellow": {2: 3.0, 3: 5.0, 5: 7.0, 8: 10.0},
    "green": {2: 1.0, 3: 2.0, 5: 4.0, 8: 7.0},
}

DEFAULT_DIRECTION_RISK_BY_ZONE = {
    "red": {"inward": 22.0, "outward": 20.0, "crossing": 22.0, "parallel": 8.0},
    "yellow": {"inward": 18.0, "outward": 16.0, "crossing": 18.0, "parallel": 5.0},
    "green": {"inward": 10.0, "outward": 8.0, "crossing": 10.0, "parallel": 2.0},
}

DEFAULT_CLASS_CONFIDENCE_BY_ZONE = {
    # A vehicle right at the restricted line is far more anomalous than one
    # on your own territory (parking, deliveries) — RED weighs vehicle
    # almost as heavily as person for exactly that reason.
    "red": {"person": 16.0, "vehicle": 14.0, "animal": 2.0},
    "yellow": dict(DEFAULT_CLASS_CONFIDENCE),
    "green": {"person": 8.0, "vehicle": 4.0, "animal": 1.0},
}

# --- v1 defaults, kept only to recognise untouched rows during migration ----
V1_SECTOR_RISK = {"red": 30.0, "yellow": 15.0, "green": 5.0, "none": 0.0}
V1_TIME_RISK = {
    **{h: 25.0 for h in range(0, 5)},
    **{h: 20.0 for h in (5, 22, 23)},
    **{h: 5.0 for h in range(6, 22)},
}
V1_CLASS_CONFIDENCE = {"person": 15.0, "vehicle": 10.0, "animal": 3.0}
V1_MOVEMENT_CONFIG = {
    "slow_speed_px_per_frame": 2.0,
    "fast_speed_px_per_frame": 15.0,
    "max_movement_risk": 30.0,
}


class ThreatRulesDB:
    """Local, offline rules store (SQLite) feeding the border threat-score
    formula (0-100):

        T = S_sector + T_time + K_kinematics + C_class
            + D_direction + L_loiter + G_group

    No network dependency — rules are seeded with border-calibrated defaults
    on first run. Existing databases are migrated by RULES_VERSION, and any
    row an operator has hand-edited is preserved rather than overwritten, so
    local tuning survives an update arriving over the encrypted-USB channel.
    """

    def __init__(self, db_path: str = "database/threat_rules.db"):
        os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._create_tables()
        self._seed_defaults()
        self._migrate()

    def _create_tables(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sector_risk (
                zone_tier TEXT PRIMARY KEY,
                risk REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS time_risk (
                hour INTEGER PRIMARY KEY,
                risk REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS class_confidence (
                category TEXT PRIMARY KEY,
                risk REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS movement_risk_config (
                key TEXT PRIMARY KEY,
                value REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS direction_risk (
                direction TEXT PRIMARY KEY,
                risk REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS loiter_config (
                key TEXT PRIMARY KEY,
                value REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS group_risk (
                min_count INTEGER PRIMARY KEY,
                risk REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS movement_risk_config_by_zone (
                zone_tier TEXT NOT NULL,
                key TEXT NOT NULL,
                value REAL NOT NULL,
                PRIMARY KEY (zone_tier, key)
            );
            CREATE TABLE IF NOT EXISTS loiter_config_by_zone (
                zone_tier TEXT NOT NULL,
                key TEXT NOT NULL,
                value REAL NOT NULL,
                PRIMARY KEY (zone_tier, key)
            );
            CREATE TABLE IF NOT EXISTS group_risk_by_zone (
                zone_tier TEXT NOT NULL,
                min_count INTEGER NOT NULL,
                risk REAL NOT NULL,
                PRIMARY KEY (zone_tier, min_count)
            );
            CREATE TABLE IF NOT EXISTS direction_risk_by_zone (
                zone_tier TEXT NOT NULL,
                direction TEXT NOT NULL,
                risk REAL NOT NULL,
                PRIMARY KEY (zone_tier, direction)
            );
            CREATE TABLE IF NOT EXISTS class_confidence_by_zone (
                zone_tier TEXT NOT NULL,
                category TEXT NOT NULL,
                risk REAL NOT NULL,
                PRIMARY KEY (zone_tier, category)
            );
            CREATE TABLE IF NOT EXISTS rules_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        self._conn.commit()

    def _seed_defaults(self) -> None:
        self._seed_table("sector_risk", "zone_tier", "risk", DEFAULT_SECTOR_RISK)
        self._seed_table("time_risk", "hour", "risk", DEFAULT_TIME_RISK)
        self._seed_table("class_confidence", "category", "risk", DEFAULT_CLASS_CONFIDENCE)
        self._seed_table("movement_risk_config", "key", "value", DEFAULT_MOVEMENT_CONFIG)
        self._seed_table("direction_risk", "direction", "risk", DEFAULT_DIRECTION_RISK)
        self._seed_table("loiter_config", "key", "value", DEFAULT_LOITER_CONFIG)
        self._seed_table("group_risk", "min_count", "risk", DEFAULT_GROUP_RISK)
        self._seed_by_zone_table("movement_risk_config_by_zone", "key", DEFAULT_MOVEMENT_CONFIG_BY_ZONE)
        self._seed_by_zone_table("loiter_config_by_zone", "key", DEFAULT_LOITER_CONFIG_BY_ZONE)
        self._seed_by_zone_table("group_risk_by_zone", "min_count", DEFAULT_GROUP_RISK_BY_ZONE)
        self._seed_by_zone_table("direction_risk_by_zone", "direction", DEFAULT_DIRECTION_RISK_BY_ZONE)
        self._seed_by_zone_table("class_confidence_by_zone", "category", DEFAULT_CLASS_CONFIDENCE_BY_ZONE)

    def _seed_table(self, table: str, key_col: str, value_col: str, defaults: dict) -> None:
        cur = self._conn.execute(f"SELECT COUNT(*) FROM {table}")
        if cur.fetchone()[0] > 0:
            return  # already seeded (or hand-edited) — never overwrite
        self._conn.executemany(
            f"INSERT INTO {table} ({key_col}, {value_col}) VALUES (?, ?)",
            list(defaults.items()),
        )
        self._conn.commit()
        log.info("Seeded default rules into %s (%d rows)", table, len(defaults))

    def _seed_by_zone_table(self, table: str, key_col: str, defaults_by_zone: dict) -> None:
        """Same never-overwrite rule as _seed_table, for a (zone_tier, key,
        value) table seeded from a {zone_tier: {key: value}} nested dict."""
        cur = self._conn.execute(f"SELECT COUNT(*) FROM {table}")
        if cur.fetchone()[0] > 0:
            return
        rows = [
            (zone_tier, key, value)
            for zone_tier, defaults in defaults_by_zone.items()
            for key, value in defaults.items()
        ]
        # movement/loiter store a "value" column (a config number keyed by
        # name); group/direction/class store a "risk" column (a risk points
        # value keyed by count/direction/category) — matches each table's
        # CREATE TABLE above.
        value_col = "value" if table in ("movement_risk_config_by_zone", "loiter_config_by_zone") else "risk"
        self._conn.executemany(
            f"INSERT INTO {table} (zone_tier, {key_col}, {value_col}) VALUES (?, ?, ?)",
            rows,
        )
        self._conn.commit()
        log.info("Seeded default per-zone rules into %s (%d rows)", table, len(rows))

    # -- migration ----------------------------------------------------------
    def _stored_version(self) -> int:
        cur = self._conn.execute("SELECT value FROM rules_meta WHERE key = 'version'")
        row = cur.fetchone()
        if row is not None:
            return int(row[0])
        # No version row: either a brand-new DB (tables just seeded with v2
        # values) or a v1 DB predating this column. Tell them apart by looking
        # at a value the two versions disagree on.
        cur = self._conn.execute("SELECT risk FROM sector_risk WHERE zone_tier = 'red'")
        row = cur.fetchone()
        return 1 if row is not None and abs(row[0] - V1_SECTOR_RISK["red"]) < 1e-9 else RULES_VERSION

    def _migrate(self) -> None:
        version = self._stored_version()
        if version >= RULES_VERSION:
            self._set_version(RULES_VERSION)
            return

        log.warning(
            "Migrating threat rules v%d -> v%d (border calibration). Rows still "
            "holding a v%d default are updated; hand-edited rows are kept.",
            version, RULES_VERSION, version,
        )
        updated = kept = 0
        for table, key_col, val_col, old, new in (
            ("sector_risk", "zone_tier", "risk", V1_SECTOR_RISK, DEFAULT_SECTOR_RISK),
            ("time_risk", "hour", "risk", V1_TIME_RISK, DEFAULT_TIME_RISK),
            ("class_confidence", "category", "risk", V1_CLASS_CONFIDENCE, DEFAULT_CLASS_CONFIDENCE),
        ):
            for key, old_value in old.items():
                cur = self._conn.execute(
                    f"SELECT {val_col} FROM {table} WHERE {key_col} = ?", (key,)
                )
                row = cur.fetchone()
                if row is None:
                    continue
                if abs(row[0] - old_value) < 1e-9:
                    self._conn.execute(
                        f"UPDATE {table} SET {val_col} = ? WHERE {key_col} = ?", (new[key], key)
                    )
                    updated += 1
                else:
                    kept += 1

        # The movement config changed shape entirely (linear slow/fast -> a
        # U-curve with new keys), so it can't be migrated key-by-key. Replace
        # it only if every old key still holds its v1 default.
        cur = self._conn.execute("SELECT key, value FROM movement_risk_config")
        existing = dict(cur.fetchall())
        untouched = all(
            k in existing and abs(existing[k] - v) < 1e-9 for k, v in V1_MOVEMENT_CONFIG.items()
        )
        if untouched:
            self._conn.execute("DELETE FROM movement_risk_config")
            self._conn.executemany(
                "INSERT INTO movement_risk_config (key, value) VALUES (?, ?)",
                list(DEFAULT_MOVEMENT_CONFIG.items()),
            )
            updated += len(DEFAULT_MOVEMENT_CONFIG)
        else:
            log.warning(
                "movement_risk_config was hand-edited under the old linear rule and "
                "cannot be auto-converted to the v%d U-curve; missing keys fall back "
                "to defaults. Review it: %s", RULES_VERSION, sorted(existing),
            )
            kept += len(existing)

        self._conn.commit()
        self._set_version(RULES_VERSION)
        log.warning("Threat rules migration complete: %d updated, %d kept as-is", updated, kept)

    def _set_version(self, version: int) -> None:
        self._conn.execute(
            "INSERT INTO rules_meta (key, value) VALUES ('version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(version),),
        )
        self._conn.commit()

    # -- lookups ------------------------------------------------------------
    def get_sector_risk(self, zone_tier: str) -> float:
        return self._lookup("sector_risk", "zone_tier", "risk", zone_tier, default=0.0)

    def get_time_risk(self, hour: int) -> float:
        return self._lookup("time_risk", "hour", "risk", hour, default=4.0)

    def get_class_confidence(self, category: str, zone_tier: "str | None" = None) -> float:
        """`zone_tier` ("red"/"yellow"/"green") consults that zone's own
        rule row first; omitted, None, or "none" (no zone drawn/pinned for
        this camera) uses the shared global table — same value every install
        has always gotten, so un-zoned footage is unaffected by v3."""
        if zone_tier in ("red", "yellow", "green"):
            row = self._lookup_optional(
                "class_confidence_by_zone", "zone_tier", "category", "risk", zone_tier, category
            )
            if row is not None:
                return row
        return self._lookup("class_confidence", "category", "risk", category, default=0.0)

    def get_direction_risk(self, direction: "str | None", zone_tier: "str | None" = None) -> float:
        key = direction or "none"
        if zone_tier in ("red", "yellow", "green"):
            row = self._lookup_optional(
                "direction_risk_by_zone", "zone_tier", "direction", "risk", zone_tier, key
            )
            if row is not None:
                return row
        return self._lookup("direction_risk", "direction", "risk", key, default=0.0)

    def get_movement_config(self, zone_tier: "str | None" = None) -> dict:
        cur = self._conn.execute("SELECT key, value FROM movement_risk_config")
        stored = dict(cur.fetchall())
        # Fall back per-key: a DB hand-edited under the old linear rule won't
        # have the U-curve keys, and a KeyError here would take down scoring.
        config = {**DEFAULT_MOVEMENT_CONFIG, **stored}
        if zone_tier in ("red", "yellow", "green"):
            cur = self._conn.execute(
                "SELECT key, value FROM movement_risk_config_by_zone WHERE zone_tier = ?", (zone_tier,)
            )
            zone_stored = dict(cur.fetchall())
            if zone_stored:
                config.update(zone_stored)
        return config

    def get_loiter_config(self, zone_tier: "str | None" = None) -> dict:
        cur = self._conn.execute("SELECT key, value FROM loiter_config")
        config = {**DEFAULT_LOITER_CONFIG, **dict(cur.fetchall())}
        if zone_tier in ("red", "yellow", "green"):
            cur = self._conn.execute(
                "SELECT key, value FROM loiter_config_by_zone WHERE zone_tier = ?", (zone_tier,)
            )
            zone_stored = dict(cur.fetchall())
            if zone_stored:
                config.update(zone_stored)
        return config

    def get_group_risk(self, count: int, zone_tier: "str | None" = None) -> float:
        """Risk for `count` people seen together — the highest threshold at or
        below `count` wins, so the table stays sparse and easy to hand-edit."""
        if zone_tier in ("red", "yellow", "green"):
            cur = self._conn.execute(
                "SELECT risk FROM group_risk_by_zone WHERE zone_tier = ? AND min_count <= ? "
                "ORDER BY min_count DESC LIMIT 1",
                (zone_tier, count),
            )
            row = cur.fetchone()
            if row is not None:
                return row[0]
        cur = self._conn.execute(
            "SELECT risk FROM group_risk WHERE min_count <= ? ORDER BY min_count DESC LIMIT 1",
            (count,),
        )
        row = cur.fetchone()
        return row[0] if row is not None else 0.0

    def _lookup(self, table: str, key_col: str, value_col: str, key, default: float) -> float:
        cur = self._conn.execute(f"SELECT {value_col} FROM {table} WHERE {key_col} = ?", (key,))
        row = cur.fetchone()
        return row[0] if row is not None else default

    def _lookup_optional(
        self, table: str, zone_col: str, key_col: str, value_col: str, zone_tier: str, key
    ) -> "float | None":
        cur = self._conn.execute(
            f"SELECT {value_col} FROM {table} WHERE {zone_col} = ? AND {key_col} = ?", (zone_tier, key)
        )
        row = cur.fetchone()
        return row[0] if row is not None else None

    def close(self) -> None:
        self._conn.close()
