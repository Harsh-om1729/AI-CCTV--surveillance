import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiCamera, camerasApi, cameraStreamUrl } from '@/lib/api';
import { describeCamera, useSystemHealth } from '@/components/system/SystemHealthProvider';
import { CameraTile } from '@/components/live';
import { AddCameraModal } from '@/components/cameras';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  Grid2X2,
  Maximize2,
  ArrowLeft,
  Video,
  Radio,
  Layers,
  Plus,
  Settings2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';

export interface CameraItem extends Omit<ApiCamera, 'activityGate' | 'lowLightBoost'> {
  activityGate?: 'HIGH' | 'LOW';
  lowLightBoost?: boolean;
}

const LEGACY_CAMERAS_STORAGE_KEY = 'ibvap_cameras_data_v3';


export const LiveFeedsPage: React.FC = () => {
  const navigate = useNavigate();
  // One source of truth for cameras and their live status, shared with the
  // topbar, sidebar and dashboard (components/system/SystemHealthProvider).
  const { cameras: apiCameras, health, reachable, refresh } = useSystemHealth();
  const cameras: CameraItem[] = useMemo(
    () =>
      apiCameras.map((c) => ({
        ...c,
        streamUrl: cameraStreamUrl(c.id),
        activityGate: c.activityGate ?? undefined,
        lowLightBoost: c.lowLightBoost ?? undefined,
      })),
    [apiCameras]
  );
  const serverNow = health?.checkedAt ?? null;
  const [viewMode, setViewMode] = useState<'grid' | 'focus'>('grid');
  const [gridColumns, setGridColumns] = useState<'2' | '3'>('2');
  const [focusedCameraId, setFocusedCameraId] = useState<string>('cam0');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  const [searchParams] = useSearchParams();
  const urlCamera = searchParams.get('camera');

  // Drop the camera list older builds cached, which held the invented tiles.
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_CAMERAS_STORAGE_KEY);
    } catch {
      // storage unavailable
    }
  }, []);

  // Auto-focus camera when requested via query parameter (e.g. from Detections / View Evidence)
  useEffect(() => {
    if (urlCamera) {
      const match = cameras.find((c) => c.id.toLowerCase() === urlCamera.toLowerCase());
      if (match) {
        setFocusedCameraId(match.id);
        setViewMode('focus');
      }
    }
  }, [urlCamera, cameras]);

  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const handleTileClick = (camId: string) => {
    setFocusedCameraId(camId);
    setViewMode('focus');
  };


  const handleRemoveCamera = async (camId: string) => {
    if (cameras.length <= 1) {
      showToast('Cannot remove last remaining surveillance feed');
      return;
    }
    
    try {
      const res = await camerasApi.deleteCamera(camId);
      if (res.isFallback) {
        // e.g. 409 for a camera defined in .env — it was removed from the
        // grid anyway before, and came back on the next reload.
        showToast(`Could not remove ${camId.toUpperCase()}: ${res.error ?? 'backend unreachable'}`);
        return;
      }
      await refresh();
      if (focusedCameraId === camId) {
        setFocusedCameraId(cameras.find((c) => c.id !== camId)?.id || 'cam0');
      }
      showToast(`Removed camera channel ${camId.toUpperCase()}`);
    } catch (err) {
      // Surface the reason: a delete refused because the camera comes from
      // CAMERA_SOURCES in .env reads very differently from a network failure.
      showToast(
        `Failed to remove camera ${camId}: ${err instanceof Error ? err.message : 'unknown error'}`
      );
    }
  };

  const handleStopCamera = async (camId: string) => {
    const res = await camerasApi.stopCamera(camId);
    if (res.isFallback) {
      showToast(`Could not stop ${camId.toUpperCase()}: ${res.error ?? 'backend unreachable'}`);
      return;
    }
    await refresh();
    showToast(`Stopped camera ${camId.toUpperCase()} — it reconnects automatically when viewed again`);
  };

  const handleCameraAdded = async (camera: ApiCamera) => {
    await refresh();
    showToast(`Camera ${camera.id.toUpperCase()} added successfully`);
  };

  const focusedCamera =
    cameras.find((c) => c.id === focusedCameraId) || cameras[0];

  const onlineCount = cameras.filter((c) => c.health === 'online' && c.source !== 'idle').length;

  return (
    <div className="space-y-5">
      {/* Dynamic Toast Feedback */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 bg-bg-surface border border-accent-teal/50 rounded-sm shadow-xl font-mono text-xs text-text-primary animate-in fade-in slide-in-from-bottom-2">
          <CheckCircle2 className="w-4 h-4 text-accent-teal" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Top Toolbar / Filter Row */}
      <div className="card-3d flex flex-col lg:flex-row lg:items-center justify-between gap-3 p-4 rounded-2xl border border-ink/10 bg-gradient-to-b from-bg-surface to-bg-primary shadow-[0_15px_35px_rgba(0,0,0,0.8)]">
        {/* Left: Camera Count Indicator & Status */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Video className="w-4 h-4 text-accent-teal" />
            <span className="font-mono text-xs font-bold text-text-primary uppercase tracking-wider">
              Surveillance Grid
            </span>
          </div>

          <span className="text-text-primary/20">|</span>

          <Badge
            variant={cameras.length > 0 && onlineCount === cameras.length ? 'green' : 'yellow'}
            dot
            size="sm"
          >
            {cameras.length} CAMERAS · {onlineCount} LIVE
          </Badge>

          <span className="hidden sm:inline font-mono text-[11px] text-text-dim">
            {health?.pipeline.running ? 'AI PIPELINE RUNNING' : 'AI PIPELINE STOPPED — PREVIEW ONLY'}
          </span>
        </div>

        {/* Right: Actions & Layout Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Add Camera Button */}
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Plus className="w-4 h-4" />}
            onClick={() => setIsAddModalOpen(true)}
          >
            Add Camera
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Settings2 className="w-3.5 h-3.5" />}
            onClick={() => navigate('/cameras')}
          >
            Manage Cameras
          </Button>

          {/* Back to Grid Button (when in focus mode) */}
          {viewMode === 'focus' && (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<ArrowLeft className="w-3.5 h-3.5" />}
              onClick={() => setViewMode('grid')}
            >
              Back to Grid
            </Button>
          )}

          {/* Grid Columns Switcher (when in grid mode) */}
          {viewMode === 'grid' && cameras.length >= 4 && (
            <div className="hidden sm:inline-flex p-1 bg-bg-elevated border border-ink/10 rounded-xl shadow-inner">
              <button
                onClick={() => setGridColumns('2')}
                title="2 Columns Grid"
                className={`px-2.5 py-1 text-[11px] font-mono rounded-lg transition-all ${
                  gridColumns === '2'
                    ? 'bg-accent-teal/15 text-accent-teal font-bold border border-accent-teal/40'
                    : 'text-text-dim hover:text-text-primary'
                }`}
              >
                2 COL
              </button>
              <button
                onClick={() => setGridColumns('3')}
                title="3 Columns Grid"
                className={`px-2.5 py-1 text-[11px] font-mono rounded-lg transition-all ${
                  gridColumns === '3'
                    ? 'bg-accent-teal/15 text-accent-teal font-bold border border-accent-teal/40'
                    : 'text-text-dim hover:text-text-primary'
                }`}
              >
                3 COL
              </button>
            </div>
          )}

          {/* Layout Mode Toggle Buttons */}
          <div className="inline-flex p-1 bg-bg-elevated border border-ink/10 rounded-xl shadow-inner">
            <button
              onClick={() => setViewMode('grid')}
              title="Grid View"
              className={`flex items-center gap-1.5 px-3 py-1 text-xs font-mono font-semibold rounded-lg transition-all ${
                viewMode === 'grid'
                  ? 'bg-accent-teal/15 text-accent-teal border border-accent-teal/40'
                  : 'text-text-dim hover:text-text-primary'
              }`}
            >
              <Grid2X2 className="w-3.5 h-3.5" />
              <span>GRID</span>
            </button>

            <button
              onClick={() => setViewMode('focus')}
              title="Focus View (Single Camera Enlarged)"
              className={`flex items-center gap-1.5 px-3 py-1 text-xs font-mono font-semibold rounded-lg transition-all ${
                viewMode === 'focus'
                  ? 'bg-accent-teal/15 text-accent-teal border border-accent-teal/40'
                  : 'text-text-dim hover:text-text-primary'
              }`}
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span>FOCUS</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Surveillance View Area — with no-camera / offline / loading states */}
      {reachable === null && cameras.length === 0 ? (
        <div role="status" className="card-3d p-10 border border-ink/10 rounded-2xl text-center text-xs font-mono text-text-dim">
          Loading cameras…
        </div>
      ) : reachable === false && cameras.length === 0 ? (
        <div role="alert" className="card-3d p-10 border border-accent-red/40 bg-accent-red/5 rounded-2xl text-center space-y-2">
          <AlertCircle className="w-6 h-6 text-accent-red mx-auto" />
          <h3 className="text-sm font-semibold text-text-primary">Backend unreachable</h3>
          <p className="text-xs text-text-dim">Start it with ./run.sh up — this page reconnects on its own.</p>
          <Button variant="secondary" size="sm" onClick={() => refresh()}>
            Retry now
          </Button>
        </div>
      ) : cameras.length === 0 ? (
        <div className="card-3d p-10 border border-dashed border-ink/15 rounded-2xl text-center space-y-2">
          <Video className="w-6 h-6 text-text-muted mx-auto" />
          <h3 className="text-sm font-semibold text-text-primary">No cameras configured</h3>
          <p className="text-xs text-text-dim">
            Set CAMERA_SOURCES in .env (e.g. cam0=0 for the built-in webcam) or add one here.
          </p>
          <Button variant="primary" size="sm" leftIcon={<Plus className="w-4 h-4" />} onClick={() => setIsAddModalOpen(true)}>
            Add Camera
          </Button>
        </div>
      ) : viewMode === 'grid' ? (
        /* Responsive Camera Grid */
        <div
          className={`grid gap-4 ${
            gridColumns === '3'
              ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
              : 'grid-cols-1 md:grid-cols-2'
          }`}
        >
          {cameras.map((camera) => (
            <div
              key={camera.id}
              onClick={() => handleTileClick(camera.id)}
              className="cursor-pointer group/card focus:outline-none"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  handleTileClick(camera.id);
                }
              }}
            >
              <CameraTile
                cameraName={camera.name}
                label={camera.location}
                streamUrl={camera.streamUrl}
                isActive={camera.isActive}
                fps={camera.fps}
                activity={camera.activity}
                activityGate={camera.activityGate}
                lowLightBoost={camera.lowLightBoost}
                source={camera.source}
                health={camera.health}
                zones={camera.zones}
                detections={camera.detections}
                maxTier={camera.maxTier}
                resolution={camera.resolution}
                lastFrameAt={camera.lastFrameAt}
                serverNow={serverNow}
                onToggleFocus={() => handleTileClick(camera.id)}
                onRemove={() => handleRemoveCamera(camera.id)}
                onStop={() => handleStopCamera(camera.id)}
              />
            </div>
          ))}
        </div>
      ) : !focusedCamera ? null : (

        /* Single Camera Focus View */
        <div className="space-y-4">
          {/* Channel Selector Bar */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1.5">
            <span className="font-mono text-xs text-text-dim uppercase tracking-wider shrink-0 mr-1">
              Select Camera:
            </span>
            {cameras.map((cam) => (
              <button
                key={cam.id}
                onClick={() => setFocusedCameraId(cam.id)}
                className={`px-3 py-1 text-xs font-mono rounded-sm transition-all flex items-center gap-2 border shrink-0 ${
                  focusedCameraId === cam.id
                    ? 'bg-accent-teal/20 text-accent-teal border-accent-teal/50 font-semibold shadow-sm'
                    : 'bg-bg-surface text-text-dim border-border-subtle hover:text-text-primary hover:bg-bg-elevated'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    cam.health === 'online' ? 'bg-accent-green' : cam.health === 'offline' ? 'bg-accent-red' : 'bg-accent-yellow'
                  }`}
                />
                <span>{cam.name}</span>
                <span className="text-[10px] text-text-muted hidden sm:inline">
                  ({cam.location})
                </span>
              </button>
            ))}
          </div>

          {/* Large Focused Tile */}
          <div className="max-w-5xl mx-auto">
            <CameraTile
              cameraName={focusedCamera.name}
              label={focusedCamera.location}
              streamUrl={focusedCamera.streamUrl}
              isActive={focusedCamera.isActive}
              fps={focusedCamera.fps}
              activity={focusedCamera.activity}
              activityGate={focusedCamera.activityGate}
              lowLightBoost={focusedCamera.lowLightBoost}
              source={focusedCamera.source}
              health={focusedCamera.health}
              zones={focusedCamera.zones}
              detections={focusedCamera.detections}
              maxTier={focusedCamera.maxTier}
              resolution={focusedCamera.resolution}
              lastFrameAt={focusedCamera.lastFrameAt}
              serverNow={serverNow}
              isFocused={true}
              onToggleFocus={() => setViewMode('grid')}
              onRemove={() => handleRemoveCamera(focusedCamera.id)}
              onStop={() => handleStopCamera(focusedCamera.id)}
              className="shadow-2xl"
            />
          </div>

          {/* Diagnostics for the focused camera — measured values only. This
              strip used to state "~42ms latency", "3 ZONES ACTIVE" and
              "RTSP POOL OK" for every camera. */}
          {(() => {
            const st = describeCamera(focusedCamera, reachable);
            const tone = {
              green: 'text-accent-green',
              yellow: 'text-accent-yellow',
              red: 'text-accent-red',
              muted: 'text-text-dim',
            }[st.tone];
            const age =
              serverNow != null && focusedCamera.lastFrameAt != null
                ? serverNow - focusedCamera.lastFrameAt
                : null;
            return (
              <div className="card-3d max-w-5xl mx-auto p-3.5 bg-bg-surface border border-ink/10 rounded-2xl grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs shadow-lg">
                <div>
                  <span className="text-text-muted block text-[10px] uppercase">Status</span>
                  <span className={`font-semibold ${tone}`}>{st.label}</span>
                  <span className="text-[10px] text-text-dim block">
                    {age != null
                      ? `Last frame ${Math.max(0, age).toFixed(1)}s ago`
                      : focusedCamera.source === 'pipeline'
                      ? 'Waiting for frames'
                      : 'Not being analysed'}
                  </span>
                </div>
                <div>
                  <span className="text-text-muted block text-[10px] uppercase">Activity gate</span>
                  <span className="text-text-primary font-semibold">
                    {focusedCamera.activityGate === 'HIGH'
                      ? 'MOTION · full pipeline'
                      : focusedCamera.activityGate === 'LOW'
                      ? 'IDLE · keep-alive rate'
                      : '—'}
                  </span>
                  <span className="text-[10px] text-text-muted block">Reported by the AI pipeline</span>
                </div>
                <div>
                  <span className="text-text-muted block text-[10px] uppercase">Low-light</span>
                  <span className={focusedCamera.lowLightBoost ? 'text-accent-yellow font-semibold' : 'text-text-dim'}>
                    {focusedCamera.lowLightBoost == null ? '—' : focusedCamera.lowLightBoost ? 'BOOST ON' : 'Off'}
                  </span>
                  <span className="text-[10px] text-text-muted block">
                    {focusedCamera.brightness != null ? `Brightness ${focusedCamera.brightness}` : 'Pipeline only'}
                  </span>
                </div>
                <div>
                  <span className="text-text-muted block text-[10px] uppercase">Border scoring</span>
                  <span className="flex items-center gap-1 text-text-primary">
                    <Layers className="w-3 h-3" /> Fixed Priority
                  </span>
                  <span className="text-[10px] text-text-muted flex items-center gap-1">
                    <Radio className="w-2.5 h-2.5" />
                    {focusedCamera.detections ?? 0} target(s) in view
                  </span>
                </div>
              </div>
            );
          })()}
        </div>
      )}


      {/* Add Camera Modal — the one shared flow used from Live Surveillance
          and Camera Management, including RTSP Test Connection. */}
      <AddCameraModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onAdded={handleCameraAdded}
        existingIds={cameras.map((c) => c.id)}
      />
    </div>
  );
};
