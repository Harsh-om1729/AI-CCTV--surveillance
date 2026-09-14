"""Maps operator-facing zone roles to the severity tier the existing scoring
system consumes.

zones/zone_engine.py and intelligence/threat_score.py only ever see red /
yellow / green - that interface is untouched. "Restricted" / "Buffer" /
"Transit" / "Authorized" are labels an operator picks when drawing a zone;
this module is the only place that name gets turned into a tier, and it
happens at the API layer (integration/api.py), not inside ZoneEngine.
"""
import json
import logging
import os

log = logging.getLogger("ibvap.zones")

ZONE_ROLES = ("restricted", "buffer", "transit", "authorized")
VALID_TIERS = ("red", "yellow", "green")

# Restricted = the fence/line itself, high sensitivity. Buffer and Transit
# both land on "yellow" by default - a buffer strip right next to the fence
# and a patrol road further back are both "worth watching" but neither is
# the restricted core; an operator who wants them to differ can override
# Transit to green (or Buffer to red) through this same mapping. Authorized
# = an operator's own side, low sensitivity.
DEFAULT_ROLE_TIER = {
    "restricted": "red",
    "buffer": "yellow",
    "transit": "yellow",
    "authorized": "green",
}


class ZonePolicy:
    """Loads/saves the role -> tier mapping as JSON, mirroring the load/save
    pattern zones/border_line.py's BorderLineStore already uses."""

    def __init__(self, config_path: str = "config/zone_policy.json"):
        self.config_path = config_path
        self.mapping: dict[str, str] = dict(DEFAULT_ROLE_TIER)
        self.load()

    def load(self) -> None:
        if not self.config_path or not os.path.exists(self.config_path):
            return
        try:
            with open(self.config_path) as f:
                data = json.load(f)
        except (OSError, ValueError) as exc:
            log.warning("Could not read zone policy %s: %s", self.config_path, exc)
            return
        if not isinstance(data, dict):
            return
        merged = dict(DEFAULT_ROLE_TIER)
        for role, tier in data.items():
            if role in ZONE_ROLES and tier in VALID_TIERS:
                merged[role] = tier
        self.mapping = merged

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.config_path) or ".", exist_ok=True)
        with open(self.config_path, "w") as f:
            json.dump(self.mapping, f, indent=2)

    def tier_for_role(self, role: "str | None") -> "str | None":
        """None (and any unrecognised role) means "not a role" - the caller's
        job to fall back to treating the value as a raw tier."""
        if role is None:
            return None
        return self.mapping.get(role)

    def as_dict(self) -> dict:
        return dict(self.mapping)

    def update(self, mapping: dict) -> None:
        """Validates every entry before writing anything - a partially bad
        payload must not corrupt the saved policy."""
        for role, tier in mapping.items():
            if role not in ZONE_ROLES:
                raise ValueError(f"Unknown zone role: {role!r}")
            if tier not in VALID_TIERS:
                raise ValueError(f"Invalid tier {tier!r} for role {role!r}")
        merged = dict(self.mapping)
        merged.update(mapping)
        self.mapping = merged
        self.save()
