export type ZoneRole = 'restricted' | 'buffer' | 'transit' | 'authorized';

export interface Zone {
  id: string;
  cameraName: string;
  tier: 'green' | 'yellow' | 'red';
  // Operator-facing label — the severity `tier` above is resolved from this
  // via the zone policy (see lib/api zonePolicyApi). Undefined for zones
  // saved before roles existed, or drawn with a raw tier directly.
  role?: ZoneRole | null;
  points: { x: number; y: number }[]; // polygon vertices, normalized 0.0 to 1.0
  direction?: 'inward' | 'outward'; // only meaningful for yellow zones
  label: string;
  enabled?: boolean; // a disabled zone is kept but not drawn/used
  tripwireEnabled?: boolean; // Section 20: virtual tripwire crossing beam
  loiteringThresholdSeconds?: number; // Section 20: dwell time limit before alarm
  climbingDetection?: boolean; // Section 20: fence climbing aspect ratio shift
}

// A virtual boundary (tripwire) — a single line, kept as its own entity
// separate from Zone. Detects a directional crossing rather than "inside a
// region"; see the backend's zones/boundary_engine.py.
export interface Boundary {
  id: string;
  cameraName: string;
  label: string;
  p1: { x: number; y: number }; // normalized 0.0 to 1.0
  p2: { x: number; y: number };
  enabled: boolean;
}

export const ZONE_ROLES: { value: ZoneRole; label: string; description: string }[] = [
  { value: 'restricted', label: 'Restricted', description: 'The fence/line itself — highest sensitivity.' },
  { value: 'buffer', label: 'Buffer / Sensitive', description: 'The approach strip next to the restricted core.' },
  { value: 'transit', label: 'Transit / Patrol Road', description: 'A road or path patrols use — worth watching, not restricted.' },
  { value: 'authorized', label: 'Authorized', description: "An operator's own side — lowest sensitivity." },
];
