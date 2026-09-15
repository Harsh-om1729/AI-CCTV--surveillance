export interface ThreatScoreBreakdown {
  sectorRisk: number;       // S: Sector / Virtual Fence Risk (0-40)
  timeRisk: number;         // T: Time / Curfew Hours Risk (0-25)
  kinematicsRisk: number;   // K: Speed & Inward Vector Risk (0-20)
  classConfidence: number;  // C: Target Category & Detection Confidence (0-15)
  directionRisk?: number;
  loiterRisk?: number;
  groupRisk?: number;
  overrideReason?: string | null;
  elevateReason?: string | null;
  tierCeiling?: string | null;
  ceilingReason?: string | null;
  threatLevel?: string;
  threatReasons?: string[];
  // false for incidents recorded before the pipeline stored its breakdown —
  // the zeros are "not recorded", not a computed score.
  recorded?: boolean;
}

export interface Incident {
  id: number;
  trackId: number;
  personId: number | null;
  category: "person" | "vehicle" | "unknown";
  zoneTier: "green" | "yellow" | "red" | "none";
  score: number;        // 0-100 threat score (total = S + T + K + C)
  tier: "green" | "yellow" | "red";  // final alert tier: Green <= 30, Yellow 31-69, Red >= 70
  timestamp: number;    // unix seconds
  cameraName: string;   // e.g. "cam0"
  snapshotUrl: string | null;  // API path; resolve with apiAssetUrl()
  cropUrl: string | null;
  burstUrls: string[];
  watchlistMatch: string | null; // matched person's name if any, else null
  watchlistSimilarity?: number | null; // cosine similarity (0-1) of that match
  breakdown: ThreatScoreBreakdown;
  reidGalleryId: string;        // Person Gallery Re-ID track continuity (e.g. "PG-101")
  encryption: {
    cipher: string;             // "FERNET-AES128-CBC"
    keyPath: string;            // "database/evidence.key"
    verified: boolean;
  };
  // Operator workflow, from incidents.db.
  status?: "open" | "acknowledged" | "resolved";
  acknowledgedBy?: string | null;
  acknowledgedAt?: number | null;
  resolvedBy?: string | null;
  resolvedAt?: number | null;
  resolutionReason?: string | null;
  direction?: string | null;
  transition?: string | null;
  whatHeIsDoing?: string | null;
  threatLevel?: string | null;
}


