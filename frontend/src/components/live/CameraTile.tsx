import React, { useEffect, useRef, useState } from 'react';
import { Video, Maximize2, Minimize2, Trash2, AlertTriangle, RefreshCw, Square, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CameraTileProps {
  cameraName: string;
  label?: string;
  streamUrl?: string;
  isActive?: boolean;
  fps?: string | number;
  activity?: string;
  activityGate?: 'HIGH' | 'LOW';
  lowLightBoost?: boolean;
  /** Where the picture comes from — see integration/api.py _camera_status. */
  source?: 'pipeline' | 'direct' | 'idle';
  health?: string;
  zones?: number;
  detections?: number | null;
  maxTier?: 'green' | 'yellow' | 'red' | null;
  resolution?: string;
  /** Server-clock unix seconds of the last annotated frame (pipeline only). */
  lastFrameAt?: number | null;
  /** Server-clock "now" from the same health snapshot — compared against
   *  lastFrameAt so browser/server clock skew cannot fake a stall. */
  serverNow?: number | null;
  isFocused?: boolean;
  /** Most recent watchlist hit on this camera, if any — see AlertProvider's
   * `alerts` (each already carries `watchlistMatch`/`watchlistSimilarity`
   * from the incident). Only pass one still recent enough to mean "this
   * person may still be in frame", not the camera's all-time history. */
  watchlistMatch?: { name: string; similarity: number; photoUrl?: string } | null;
  onToggleFocus?: () => void;
  onRemove?: () => void;
  /** Releases the device now instead of waiting for the idle timer (see
   * integration/api.py's /cameras/{id}/stop). Any viewer reconnects on its
   * own once someone requests the stream again. */
  onStop?: () => void;
  className?: string;
}

const RETRY_MS = 4000;

export const CameraTile: React.FC<CameraTileProps> = ({
  cameraName,
  label,
  streamUrl,
  fps = '0.0',
  activity,
  activityGate,
  lowLightBoost,
  source = 'idle',
  health,
  zones,
  detections,
  maxTier,
  resolution,
  lastFrameAt,
  serverNow,
  isFocused = false,
  watchlistMatch,
  onToggleFocus,
  onRemove,
  onStop,
  className,
}) => {
  // Stream lifecycle. An MJPEG <img> fires onLoad on its first frame and
  // onError when the request fails (e.g. 409: the camera is held by another
  // process). `attempt` is appended to the URL so a retry is a fresh request.
  const [streamState, setStreamState] = useState<'connecting' | 'live' | 'error'>('connecting');
  const [attempt, setAttempt] = useState(0);

  // Reconnect when the source behind the feed changes: pipeline started
  // (switch from preview to the model's output) or stopped (fall back).
  useEffect(() => {
    setStreamState('connecting');
    setAttempt((a) => a + 1);
  }, [source]);

  useEffect(() => {
    if (streamState !== 'error') return;
    const t = setTimeout(() => {
      setStreamState('connecting');
      setAttempt((a) => a + 1);
    }, RETRY_MS);
    return () => clearTimeout(t);
  }, [streamState]);

  const src = streamUrl
    ? `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}_r=${attempt}`
    : undefined;

  const handleReconnect = () => {
    setStreamState('connecting');
    setAttempt((a) => a + 1);
  };

  const stalled =
    source === 'pipeline' &&
    streamState === 'live' &&
    lastFrameAt != null &&
    serverNow != null &&
    serverNow - lastFrameAt > 6;

  // A reconnect (backend restart, or the browser dropping and re-opening the
  // MJPEG connection) usually resolves in well under a second. Showing the
  // "Connecting…" overlay the instant that happens made every brief blip
  // look like the camera feed breaking. Only surface it once the gap has
  // actually lasted long enough to matter; a quick reconnect now finishes
  // silently, with the last frame still on screen the whole time.
  const isLive = streamState === 'live' && !stalled;
  const [overlayVisible, setOverlayVisible] = useState(false);
  const overlayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isLive) {
      if (overlayTimer.current) {
        clearTimeout(overlayTimer.current);
        overlayTimer.current = null;
      }
      setOverlayVisible(false);
      return;
    }
    if (overlayTimer.current) return;
    overlayTimer.current = setTimeout(() => {
      setOverlayVisible(true);
      overlayTimer.current = null;
    }, 900);
    return () => {
      if (overlayTimer.current) {
        clearTimeout(overlayTimer.current);
        overlayTimer.current = null;
      }
    };
  }, [isLive]);

  const sourceBadge =
    source === 'pipeline'
      ? { text: 'AI PIPELINE', cls: 'bg-accent-green/10 text-accent-green border-accent-green/30' }
      : source === 'direct'
      ? { text: 'PREVIEW · NO ALERTS', cls: 'bg-accent-yellow/15 text-accent-yellow border-accent-yellow/30' }
      : { text: 'STANDBY', cls: 'bg-white/5 text-text-dim border-white/15' };

  const healthDot =
    health === 'online'
      ? 'bg-accent-green'
      : health === 'reconnecting'
      ? 'bg-accent-yellow'
      : health === 'offline'
      ? 'bg-accent-red'
      : 'bg-text-muted';

  return (
    <div
      className={cn(
        'card-3d group relative rounded-2xl border border-white/10 bg-[#07070c] overflow-hidden transition-colors duration-100 shadow-md',
        isFocused ? 'ring-1 ring-accent-teal border-accent-teal' : 'hover:border-white/20',
        maxTier === 'red' && 'border-accent-red/60',
        className
      )}
    >
      <div className="relative aspect-video w-full bg-[#05070a] flex items-center justify-center overflow-hidden">
        {src && (
          <img
            key={attempt}
            src={src}
            alt={`Live feed from ${cameraName}${label ? ` — ${label}` : ''}`}
            onLoad={() => setStreamState('live')}
            onError={() => setStreamState('error')}
            className="w-full h-full object-contain select-none"
          />
        )}

        {/* Connecting / error / stalled overlays — never a silent black tile,
            but only once a reconnect has actually taken a moment (see the
            overlayVisible effect above), so a quick blip doesn't flash it. */}
        {(!src || overlayVisible) && (
          <div
            role="status"
            aria-live="polite"
            className="absolute inset-0 z-10 flex flex-col items-center justify-center text-center p-4 gap-2 bg-black/70"
          >
            {streamState === 'error' || stalled ? (
              <AlertTriangle className="w-7 h-7 text-accent-yellow" />
            ) : (
              <Video className="w-7 h-7 text-text-muted" />
            )}
            <div className="font-mono text-xs text-text-primary">
              {!src
                ? 'No stream configured'
                : stalled
                ? 'Feed stalled — no new frames from the pipeline'
                : streamState === 'error'
                ? 'Stream unavailable — camera busy or disconnected'
                : 'Connecting to camera…'}
            </div>
            {streamState === 'error' && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleReconnect();
                }}
                className="px-2.5 py-1 rounded border border-white/20 text-[11px] font-mono text-text-dim hover:text-white"
              >
                Retry now (auto-retrying)
              </button>
            )}
          </div>
        )}

        {/* WATCHLIST MATCH BANNER — the whole point of the watchlist: a
            match must be unmissable on the feed itself, not just a number
            on the Watchlist page. Full-width so it reads before anything
            else on the tile. */}
        {watchlistMatch && (
          <div className="absolute top-0 inset-x-0 z-30 flex items-center justify-center gap-1.5 py-1 px-2 bg-accent-red text-white shadow-lg animate-pulse">
            {watchlistMatch.photoUrl ? (
              <img
                src={watchlistMatch.photoUrl}
                alt={`Enrolled photo of ${watchlistMatch.name}`}
                className="w-4 h-4 rounded-full object-cover border border-white/60 shrink-0"
              />
            ) : (
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
            )}
            <span className="font-mono text-[11px] font-bold tracking-wide truncate">
              PERSON MATCHED FROM WATCHLIST: {watchlistMatch.name.toUpperCase()} ({Math.round(watchlistMatch.similarity * 100)}%)
            </span>
          </div>
        )}

        {/* TOP-LEFT: camera name, health, source */}
        <div className={cn('absolute left-3 z-20 flex flex-wrap items-center gap-2 max-w-[75%]', watchlistMatch ? 'top-9' : 'top-3')}>
          <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-black/85 border border-white/10 shadow-sm max-w-full min-w-0">
            <span className={cn('inline-flex rounded-full h-1.5 w-1.5 shrink-0', healthDot)} aria-hidden />
            <span className="font-mono text-xs font-bold text-white tracking-wider uppercase truncate min-w-0">
              {cameraName}
            </span>
            {label && (
              <span className="hidden sm:inline font-mono text-[10px] text-text-dim border-l border-white/15 pl-1.5 truncate max-w-[12rem] shrink-0">
                {label}
              </span>
            )}
          </div>
          <span className={cn('font-mono text-[9px] px-1.5 py-0.5 rounded border font-semibold', sourceBadge.cls)}>
            {sourceBadge.text}
          </span>
          {activityGate && (
            <span
              className={`hidden md:inline-block font-mono text-[9px] px-1.5 py-0.5 rounded border font-semibold ${
                activityGate === 'HIGH'
                  ? 'bg-accent-teal/15 text-accent-teal border-accent-teal/30'
                  : 'bg-white/5 text-text-dim border-white/15'
              }`}
              title="Activity gate: full pipeline on motion, keep-alive rate when idle"
            >
              {activityGate === 'HIGH' ? 'MOTION' : 'IDLE'}
            </span>
          )}
          {lowLightBoost && (
            <span className="hidden md:inline-block font-mono text-[9px] px-1.5 py-0.5 rounded bg-accent-yellow/15 text-accent-yellow border border-accent-yellow/30 font-semibold">
              LOW-LIGHT BOOST
            </span>
          )}
        </div>

        {/* TOP-RIGHT: controls */}
        <div className={cn('absolute right-3 z-20 flex items-center gap-1.5', watchlistMatch ? 'top-9' : 'top-3')}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleReconnect();
            }}
            title="Reconnect this feed"
            aria-label={`Reconnect camera ${cameraName}`}
            className="p-1.5 rounded bg-black/85 border border-white/10 text-text-dim hover:text-accent-teal hover:border-accent-teal/40 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {onStop && source !== 'idle' && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStop();
              }}
              title="Stop this camera (release the device now)"
              aria-label={`Stop camera ${cameraName}`}
              className="p-1.5 rounded bg-black/85 border border-white/10 text-text-muted hover:text-accent-yellow hover:border-accent-yellow/40 transition-colors"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              title="Remove camera"
              aria-label={`Remove camera ${cameraName}`}
              className="p-1.5 rounded bg-black/85 border border-white/10 text-text-muted hover:text-accent-red hover:border-accent-red/40 hover:bg-accent-red/10 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          {onToggleFocus && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleFocus();
              }}
              title={isFocused ? 'Return to grid view' : 'Focus camera feed'}
              aria-label={isFocused ? 'Return to grid view' : `Focus camera ${cameraName}`}
              className="p-1.5 rounded bg-black/85 border border-white/10 text-text-dim hover:text-white hover:border-accent-teal/40 transition-colors"
            >
              {isFocused ? (
                <Minimize2 className="w-3.5 h-3.5 text-accent-teal" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
            </button>
          )}
        </div>

        {/* BOTTOM STRIP: measured values only */}
        <div className="absolute bottom-0 left-0 right-0 z-20 px-3.5 py-2 bg-gradient-to-t from-black via-black/90 to-black/60 border-t border-white/10 flex items-center justify-between font-mono text-[11px] text-text-dim gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <span>
              FPS: <span className="text-accent-teal font-semibold">{fps}</span>
            </span>
            {activity && (
              <>
                <span className="text-white/20">|</span>
                <span className="truncate">{activity}</span>
              </>
            )}
            {detections != null && (
              <>
                <span className="text-white/20">|</span>
                <span>
                  TARGETS: <span className="text-text-primary font-semibold">{detections}</span>
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-text-muted shrink-0">
            {zones != null && (
              <span className={zones === 0 ? 'text-accent-yellow' : ''} title={zones === 0 ? 'No zones drawn: border scoring is inactive' : undefined}>
                {zones} ZONE{zones === 1 ? '' : 'S'}
              </span>
            )}
            {resolution && <span className="hidden sm:inline">{resolution}</span>}
          </div>
        </div>
      </div>
    </div>
  );
};
