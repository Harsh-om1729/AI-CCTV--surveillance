import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ApiCamera, ApiMeta, camerasApi, systemApi, SystemHealth } from '@/lib/api';

/**
 * One poller for the whole app. Topbar, sidebar, dashboard, live feeds and
 * settings all need camera and pipeline status; each polling on its own
 * would multiply the load, and they could disagree with each other.
 *
 * The last known values are kept when the backend stops answering, and
 * `reachable` goes false — so a brief blip does not blank the camera grid and
 * restart every video stream, but the UI still says it is offline.
 */
interface SystemHealthState {
  health: SystemHealth | null;
  cameras: ApiCamera[];
  meta: ApiMeta | null;
  /** null until the first check completes. */
  reachable: boolean | null;
  lastCheckedAt: number | null;
  error: string | null;
  refresh: () => Promise<void>;
}

const POLL_MS = 5000;

const SystemHealthContext = createContext<SystemHealthState | null>(null);

export const SystemHealthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [cameras, setCameras] = useState<ApiCamera[]>([]);
  const [meta, setMeta] = useState<ApiMeta | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [h, c] = await Promise.all([systemApi.getHealth(), camerasApi.getCameras([])]);
      if (!mounted.current) return;
      setReachable(!h.isFallback);
      setError(h.error);
      setLastCheckedAt(Date.now());
      if (!h.isFallback && h.data) setHealth(h.data);
      if (!c.isFallback && c.data) setCameras(c.data);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      // Skip the *recurring* poll while hidden: nobody is looking, and a
      // wall of background tabs should not keep the edge node busy.
      if (!document.hidden) await refresh();
      if (mounted.current) timer = setTimeout(tick, POLL_MS);
    };
    // The first fetch always runs, tab hidden or not — otherwise a dashboard
    // that happens to load in a background/unfocused tab (a second monitor,
    // another window on top, a tab opened but not switched to) sits on
    // "Checking system..." / "Loading cameras..." forever, since nothing
    // else ever triggers an initial fetch to get it out of that state.
    refresh().then(() => {
      if (mounted.current) timer = setTimeout(tick, POLL_MS);
    });
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted.current = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // Vocabularies (resolution reasons) change only with a backend deploy.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await systemApi.getMeta();
      if (!cancelled && !res.isFallback && res.data) setMeta(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [reachable]);

  return (
    <SystemHealthContext.Provider
      value={{ health, cameras, meta, reachable, lastCheckedAt, error, refresh }}
    >
      {children}
    </SystemHealthContext.Provider>
  );
};

export function useSystemHealth(): SystemHealthState {
  const ctx = useContext(SystemHealthContext);
  if (!ctx) throw new Error('useSystemHealth must be used inside <SystemHealthProvider>');
  return ctx;
}

/** Human label for a camera's live status, shared by every page. */
export function describeCamera(cam: ApiCamera | undefined, reachable: boolean | null) {
  if (reachable === false) return { label: 'Backend offline', tone: 'red' as const };
  if (!cam) return { label: 'Unknown', tone: 'muted' as const };
  if (cam.source === 'pipeline') {
    if (cam.health === 'online') return { label: 'AI pipeline · live', tone: 'green' as const };
    if (cam.health === 'reconnecting') return { label: 'Reconnecting', tone: 'yellow' as const };
    return { label: 'Camera offline', tone: 'red' as const };
  }
  if (cam.source === 'direct') return { label: 'Preview only · no alerts', tone: 'yellow' as const };
  return { label: 'Standby', tone: 'muted' as const };
}
