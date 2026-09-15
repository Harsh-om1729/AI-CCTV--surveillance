import { safeFetch, ApiResponse } from './client';
import { API_CONFIG } from './config';
import type { Incident } from '@/lib/mockIncidents';
import type { WatchlistPerson } from '@/lib/mockWatchlist';
import {
  ThresholdSettings,
  IntegrationSettings,
  loadThresholdSettings,
  loadIntegrationSettings,
} from '@/lib/settingsState';

// Mutations deliberately pass NO fallback to safeFetch. They used to pass
// `{ success: true }` (or the submitted object), which safeFetch returns on
// failure — so a delete or save against a dead backend resolved as a success
// and the UI said "done". Now a failed mutation has data === null and
// isFallback === true, and callers report the failure.

export type CameraSource = 'pipeline' | 'direct' | 'idle';

export interface ApiCamera {
  id: string;
  name: string;
  location: string;
  sector: string;
  streamUrl?: string;
  fps: string;
  activity: string;
  isActive: boolean;
  resolution?: string;
  // Real status from /api/v1/cameras (see integration/api.py _camera_status).
  source?: any;
  health?: string;
  activityGate?: 'HIGH' | 'LOW' | null;
  lowLightBoost?: boolean | null;
  brightness?: number | null;
  detections?: number | null;
  maxTier?: 'green' | 'yellow' | 'red' | null;
  lastFrameAt?: number | null;
  zones?: number;
  zoneProfile?: string;
  zoneTier?: 'red' | 'yellow' | 'green';
}


// 1. Cameras
export const camerasApi = {
  async getCameras(fallback: ApiCamera[]): Promise<ApiResponse<ApiCamera[]>> {
    return safeFetch<ApiCamera[]>('/cameras', { method: 'GET' }, fallback);
  },

  async addCamera(camera: Partial<ApiCamera>): Promise<ApiResponse<ApiCamera>> {
    return safeFetch<ApiCamera>('/cameras', { method: 'POST', body: JSON.stringify(camera) });
  },

  async updateCamera(id: string, updates: Partial<ApiCamera>): Promise<ApiResponse<ApiCamera>> {
    return safeFetch<ApiCamera>(`/cameras/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async deleteCamera(id: string): Promise<ApiResponse<{ success: boolean; id: string }>> {
    return safeFetch<{ success: boolean; id: string }>(`/cameras/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async stopCamera(id: string): Promise<ApiResponse<{ success: boolean; id: string }>> {
    return safeFetch<{ success: boolean; id: string }>(`/cameras/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    });
  },

  /** Briefly opens a candidate source (webcam index or RTSP/HTTP URL) to
   * check it is reachable, without saving it as a camera. */
  async testCamera(source: string | number): Promise<ApiResponse<CameraTestResult>> {
    return safeFetch<CameraTestResult>('/cameras/test', {
      method: 'POST',
      body: JSON.stringify({ source }),
    });
  },
};

export interface CameraTestResult {
  ok: boolean;
  detail: string;
  resolution?: string;
  elapsedMs?: number;
}

// 2. Incidents — no mock fallback. An unreachable backend yields an empty
// list plus isFallback, and pages show an offline state instead of sample
// rows that look exactly like real detections.
export const incidentsApi = {
  async getIncidents(fallback: Incident[] = [], limit = 500): Promise<ApiResponse<Incident[]>> {
    return safeFetch<Incident[]>(`/incidents?limit=${limit}`, { method: 'GET' }, fallback);
  },

  async getIncident(id: number, fallback?: Incident): Promise<ApiResponse<Incident>> {
    return safeFetch<Incident>(`/incidents/${id}`, { method: 'GET' }, fallback);
  },

  async acknowledgeIncident(id: number): Promise<ApiResponse<{ success: boolean; id: number }>> {
    return safeFetch<{ success: boolean; id: number }>(`/incidents/${id}/acknowledge`, {
      method: 'POST',
    });
  },

  async resolveIncident(id: number, reason: string): Promise<ApiResponse<Incident>> {
    return safeFetch<Incident>(`/incidents/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
};

// 3d. Offline video replay — upload a recorded clip and, once activated,
// it's added to .env's CAMERA_SOURCES so the real AI pipeline analyses it
// (a restart is required; see integration/api.py "Offline video replay").
export interface ApiVideo {
  id: string;
  cameraId: string;
  filename: string;
  sizeBytes: number;
  uploadedAt: string;
  isActive: boolean;
  needsRestart: boolean;
}

export interface VideoActivationResult {
  cameraId: string;
  needsRestart: boolean;
}

export const videosApi = {
  async getVideos(fallback: ApiVideo[] = []): Promise<ApiResponse<ApiVideo[]>> {
    return safeFetch<ApiVideo[]>('/videos', { method: 'GET' }, fallback);
  },

  /** Bespoke upload, not safeFetch: safeFetch hardcodes a 4s timeout and a
   * JSON Content-Type, both wrong for a large binary video. Uses XHR (not
   * fetch) so upload progress can be reported for a multi-hundred-MB file. */
  uploadVideo(file: File, onProgress?: (pct: number) => void): Promise<ApiResponse<ApiVideo>> {
    return new Promise((resolve) => {
      const token = import.meta.env.VITE_API_TOKEN as string | undefined;
      const url = `${API_CONFIG.baseUrl}/videos/upload?filename=${encodeURIComponent(file.name)}`;
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      xhr.upload.onprogress = (event) => {
        if (onProgress && event.lengthComputable) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };

      xhr.onload = () => {
        let body: any = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // non-JSON body
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ data: body as ApiVideo, error: null, isFallback: false, status: xhr.status });
        } else {
          resolve({
            data: null,
            error: `HTTP ${xhr.status}: ${body?.detail || xhr.statusText || 'Upload failed'}`,
            isFallback: true,
            status: xhr.status,
          });
        }
      };

      xhr.onerror = () => {
        resolve({ data: null, error: 'Network request failed', isFallback: true, status: null });
      };

      xhr.send(file);
    });
  },

  async activateVideo(id: string): Promise<ApiResponse<VideoActivationResult>> {
    return safeFetch<VideoActivationResult>(`/videos/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
    });
  },

  async deactivateVideo(id: string): Promise<ApiResponse<VideoActivationResult>> {
    return safeFetch<VideoActivationResult>(`/videos/${encodeURIComponent(id)}/deactivate`, {
      method: 'POST',
    });
  },

  async deleteVideo(
    id: string
  ): Promise<ApiResponse<{ success: boolean; id: string; needsRestart: boolean }>> {
    return safeFetch<{ success: boolean; id: string; needsRestart: boolean }>(
      `/videos/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
  },
};

// 4. Watchlist
export const watchlistApi = {
  async getWatchlist(fallback: WatchlistPerson[] = []): Promise<ApiResponse<WatchlistPerson[]>> {
    return safeFetch<WatchlistPerson[]>('/watchlist', { method: 'GET' }, fallback);
  },

  async enrollPerson(person: WatchlistPerson): Promise<ApiResponse<WatchlistPerson>> {
    return safeFetch<WatchlistPerson>('/watchlist', { method: 'POST', body: JSON.stringify(person) });
  },

  async deletePerson(id: number): Promise<ApiResponse<{ success: boolean; id: number }>> {
    return safeFetch<{ success: boolean; id: number }>(`/watchlist/${id}`, { method: 'DELETE' });
  },
};

// 5. Settings — the GET keeps the locally saved values as its offline seed;
// SettingsPage labels them as such.
export const settingsApi = {
  async getSettings(): Promise<
    ApiResponse<{ thresholds: ThresholdSettings; integrations: IntegrationSettings }>
  > {
    const fallback = {
      thresholds: loadThresholdSettings(),
      integrations: loadIntegrationSettings(),
    };
    return safeFetch<{ thresholds: ThresholdSettings; integrations: IntegrationSettings }>(
      '/settings',
      { method: 'GET' },
      fallback
    );
  },

  async updateThresholds(thresholds: ThresholdSettings): Promise<ApiResponse<ThresholdSettings>> {
    return safeFetch<ThresholdSettings>('/settings/thresholds', {
      method: 'PUT',
      body: JSON.stringify(thresholds),
    });
  },

  async updateIntegrations(
    integrations: IntegrationSettings
  ): Promise<ApiResponse<IntegrationSettings>> {
    return safeFetch<IntegrationSettings>('/settings/integrations', {
      method: 'PUT',
      body: JSON.stringify(integrations),
    });
  },
};

// 6. System health, metadata and integration diagnostics.
export interface PipelineCamera {
  health?: string;
  fps?: number;
  active?: boolean;
  motion?: number;
  zones?: number;
  lastFrameAt?: number;
  detections?: number;
  persons?: number;
  vehicles?: number;
  maxTier?: 'green' | 'yellow' | 'red' | null;
  lowLightBoost?: boolean;
  brightness?: number;
}

export interface SystemHealth {
  status: 'ok' | 'degraded' | 'pipeline-stopped';
  checkedAt: number;
  api: { status: string; startedAt: number; uptimeSeconds: number; websocketClients: number };
  pipeline: {
    running: boolean;
    detail: string | null;
    pid?: number;
    startedAt?: number;
    updatedAt?: number;
    ageSeconds?: number;
    cameras?: Record<string, PipelineCamera>;
    models?: Record<string, string>;
    rssMb?: number;
  };
  database: {
    ok: boolean;
    total?: number;
    open?: number;
    acknowledged?: number;
    resolved?: number;
    openRed?: number;
    openYellow?: number;
    lastIncidentAt?: number | null;
    error?: string;
  };
  evidence: { dir: string; files: number; sizeMb: number };
  disk: { freeGb: number; totalGb: number; percentUsed: number };
  host: {
    cpuPercent: number;
    cpuCount: number;
    memoryPercent: number;
    memoryUsedGb: number;
    memoryTotalGb: number;
    apiRssMb: number;
    gpuPercent: number | null;
  } | null;
  models: Record<string, { path: string; present: boolean; sizeMb: number | null }>;
  zones: Record<string, number>;
  watchlist: { enrolled: number | null };
}

export interface ApiMeta {
  resolutionReasons: string[];
  tierThresholds: { yellow: number; red: number };
  // Per-zone sensitivity: each zone tier escalates at its own thresholds
  // now, not one shared yellow/red pair — see ZONE_TIER_THRESHOLDS.
  tierThresholdsByZone?: Record<'red' | 'yellow' | 'green' | 'none', { yellow: number; red: number }>;
  cameraResolution: string;
  livePublishFps: number;
}

export interface IntegrationTestResult {
  webhook?: { ok: boolean; status?: number; latencyMs?: number; url?: string; detail?: string };
  syslog?: { ok: boolean; detail?: string };
}

export const systemApi = {
  async getHealth(): Promise<ApiResponse<SystemHealth>> {
    return safeFetch<SystemHealth>('/system/health', { method: 'GET' });
  },

  async getMeta(): Promise<ApiResponse<ApiMeta>> {
    return safeFetch<ApiMeta>('/meta', { method: 'GET' });
  },

  async testIntegrations(): Promise<ApiResponse<IntegrationTestResult>> {
    return safeFetch<IntegrationTestResult>('/integrations/test', { method: 'POST' });
  },
};

export interface DemoStatus {
  step: number;
  totalSteps: number;
  isRunning: boolean;
  currentIncidentId?: number | null;
  latestScore?: number | null;
  latestTier?: string | null;
  latestLevel?: string | null;
  latestReasons?: string[];
  logs: Array<{
    step: number;
    time: string;
    message: string;
  }>;
}

export const demoApi = {
  async getStatus(): Promise<ApiResponse<DemoStatus>> {
    return safeFetch<DemoStatus>(
      '/demo/status',
      { method: 'GET' },
      { step: 0, totalSteps: 15, isRunning: false, logs: [] }
    );
  },
  async runFullDemo(): Promise<ApiResponse<DemoStatus>> {
    return safeFetch<DemoStatus>('/demo/run', { method: 'POST' });
  },
  async stepDemo(): Promise<ApiResponse<DemoStatus>> {
    return safeFetch<DemoStatus>('/demo/step', { method: 'POST' });
  },
  async resetDemo(): Promise<ApiResponse<DemoStatus>> {
    return safeFetch<DemoStatus>('/demo/reset', { method: 'POST' });
  },
};

