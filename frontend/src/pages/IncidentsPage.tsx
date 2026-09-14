import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Incident } from '@/lib/mockIncidents';
import { apiAssetUrl, incidentsApi } from '@/lib/api';
import { threatStatusLabel } from '@/lib/threatStatus';
import { useSystemHealth } from '@/components/system/SystemHealthProvider';
import { EvidenceImage } from '@/components/ui/EvidenceImage';
import { useBackendData } from '@/lib/useBackendData';
import { DataSourceBadge } from '@/components/ui/DataSourceBadge';
import { useAlerts } from '@/components/alerts/AlertProvider';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import {
  User,
  Car,
  HelpCircle,
  Video,
  Clock,
  Search,
  ArrowUp,
  ArrowDown,
  FilterX,
  Maximize2,
  Eye,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';

// Status vocabulary from incidents.db (database/incident_store.py).
const STATUS_BADGE = {
  open: { variant: 'yellow', label: 'OPEN' },
  acknowledged: { variant: 'purple', label: 'ACKNOWLEDGED' },
  resolved: { variant: 'green', label: 'RESOLVED' },
} as const;

type StatusFilter = 'all' | 'open' | 'acknowledged' | 'resolved';

const PAGE_SIZE = 100;

export const IncidentsPage: React.FC = () => {
  const navigate = useNavigate();
  const { alerts } = useAlerts();
  // Camera locations come from the backend's camera list; this page used to
  // carry a hardcoded map of four invented sites.
  const { cameras, meta } = useSystemHealth();
  const camMeta = useMemo(
    () => Object.fromEntries(cameras.map((c) => [c.id, c.location])) as Record<string, string>,
    [cameras]
  );

  // Stored incidents from incidents.db. `alerts` holds what arrived over the
  // WebSocket since this tab opened; those rows are also in the database, so
  // merge by id rather than concatenating or a just-fired alert appears twice.
  const {
    data: stored,
    setData: setStored,
    isMock,
    error,
    loading,
    reload,
  } = useBackendData<Incident[]>(() => incidentsApi.getIncidents(), []);

  const incidentsData = useMemo(() => {
    const byId = new Map<number, Incident>();
    for (const i of stored) byId.set(i.id, i);
    // Fetched rows win: they carry operator actions (acknowledged,
    // resolved) that the WebSocket copy of the same alert predates.
    for (const a of alerts) if (!byId.has(a.id)) byId.set(a.id, a);
    return Array.from(byId.values()).sort((a, b) => b.id - a.id);
  }, [stored, alerts]);

  // Filter States - centered around Detection Types (Person, Vehicle, Unknown)
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'person' | 'vehicle' | 'unknown'>('all');
  const [selectedCamera, setSelectedCamera] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortDirection, setSortDirection] = useState<'desc' | 'asc'>('desc');

  // Evidence Preview Modal State
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<StatusFilter>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [activeEvidence, setActiveEvidence] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resolveReason, setResolveReason] = useState('');
  const reasons = meta?.resolutionReasons ?? [];

  // ?incident=<id> opens that incident — the "View Evidence" target of
  // alert toasts and the dashboard's recent-alert list.
  const [searchParams, setSearchParams] = useSearchParams();
  const incidentParam = searchParams.get('incident');

  const openIncident = (incident: Incident) => {
    setSelectedIncident(incident);
    setActiveEvidence(null);
    setActionError(null);
    setResolveReason('');
  };

  const closeModal = () => {
    setSelectedIncident(null);
    if (incidentParam) {
      const next = new URLSearchParams(searchParams);
      next.delete('incident');
      setSearchParams(next, { replace: true });
    }
  };

  useEffect(() => {
    if (!incidentParam) return;
    const id = Number(incidentParam);
    if (!Number.isFinite(id)) return;
    const found = incidentsData.find((i) => i.id === id);
    if (found) {
      openIncident(found);
      return;
    }
    if (loading) return;
    // Older than the loaded window: fetch it directly.
    let cancelled = false;
    incidentsApi.getIncident(id).then((res) => {
      if (!cancelled && !res.isFallback && res.data) openIncident(res.data);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentParam, loading]);

  const applyUpdate = (updated: Incident) => {
    setStored((prev) => prev.map((i) => (i.id === updated.id ? { ...i, ...updated } : i)));
    setSelectedIncident((cur) => (cur && cur.id === updated.id ? { ...cur, ...updated } : cur));
  };

  const handleAcknowledge = async () => {
    if (!selectedIncident) return;
    setActionBusy(true);
    setActionError(null);
    const res = await incidentsApi.acknowledgeIncident(selectedIncident.id);
    if (res.isFallback) {
      setActionError(`Acknowledge failed — ${res.error ?? 'backend unreachable'}`);
    } else {
      const fresh = await incidentsApi.getIncident(selectedIncident.id);
      applyUpdate(fresh.data && !fresh.isFallback ? fresh.data : { ...selectedIncident, status: 'acknowledged' });
    }
    setActionBusy(false);
  };

  const handleResolve = async () => {
    if (!selectedIncident || !resolveReason) return;
    setActionBusy(true);
    setActionError(null);
    const res = await incidentsApi.resolveIncident(selectedIncident.id, resolveReason);
    if (res.isFallback || !res.data) {
      setActionError(`Resolve failed — ${res.error ?? 'backend unreachable'}`);
    } else {
      applyUpdate(res.data);
    }
    setActionBusy(false);
  };

  // Category counts
  const personCount = incidentsData.filter((i) => i.category === 'person').length;
  const vehicleCount = incidentsData.filter((i) => i.category === 'vehicle').length;
  const unknownCount = incidentsData.filter((i) => i.category === 'unknown').length;

  // Extract unique cameras from data
  const availableCameras = useMemo(() => {
    const cams = Array.from(new Set(incidentsData.map((i) => i.cameraName)));
    return cams.sort();
  }, [incidentsData]);

  // Filtered & Sorted Detections
  const filteredIncidents = useMemo(() => {
    return incidentsData
      .filter((incident) => {
        // Category filter (Person / Vehicle / Unknown)
        if (selectedCategory !== 'all' && incident.category !== selectedCategory) {
          return false;
        }
        // Camera filter
        if (selectedCamera !== 'all' && incident.cameraName !== selectedCamera) {
          return false;
        }
        // Operator status filter
        if (selectedStatus !== 'all' && (incident.status ?? 'open') !== selectedStatus) {
          return false;
        }
        // Search query (Track ID or Camera)
        if (searchQuery.trim()) {
          const q = searchQuery.trim().toLowerCase();
          const trackMatch = incident.trackId.toString().includes(q);
          const camMatch = incident.cameraName.toLowerCase().includes(q);
          const locationMatch = (camMeta[incident.cameraName] || '').toLowerCase().includes(q);
          const idMatch = incident.id.toString() === q.replace('#', '');
          if (!trackMatch && !camMatch && !locationMatch && !idMatch) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => {
        return sortDirection === 'desc'
          ? b.timestamp - a.timestamp
          : a.timestamp - b.timestamp;
      });
  }, [selectedCategory, selectedCamera, selectedStatus, searchQuery, sortDirection, incidentsData, camMeta]);

  // Navigate directly to the camera where target is detected
  const handleGoToCamera = (cameraName: string) => {
    navigate(`/live?camera=${cameraName}`);
  };

  const handleResetFilters = () => {
    setSelectedCategory('all');
    setSelectedCamera('all');
    setSelectedStatus('all');
    setSearchQuery('');
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleString('en-GB', {
      hour12: false,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className="space-y-6">
      {/* Where these rows came from. Without it a page served from
          mockIncidents.ts looks identical to one served from incidents.db. */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono uppercase tracking-wider text-text-dim">
          {incidentsData.length} incident{incidentsData.length === 1 ? '' : 's'}
        </span>
        <DataSourceBadge isMock={isMock} error={error} />
      </div>

      {/* 1. Category KPI Cards: Person Detect / Vehicle Detect / Unknown Detect */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Person Detect */}
        <div
          onClick={() => setSelectedCategory(selectedCategory === 'person' ? 'all' : 'person')}
          className={`card-3d p-4 rounded-2xl border transition-all cursor-pointer select-none ${
            selectedCategory === 'person'
              ? 'border-accent-teal ring-1 ring-accent-teal/50 bg-accent-teal/10'
              : 'border-ink/10 hover:border-ink/20'
          }`}
        >
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <span className="text-xs font-bold text-accent-teal uppercase tracking-wider block">
                Person Detect
              </span>
              <span className="text-3xl font-extrabold text-text-primary block">
                {personCount}
              </span>
              <span className="text-[11px] text-text-dim">
                Human & foot intrusions
              </span>
            </div>
            <div className="w-10 h-10 rounded-xl bg-accent-teal/15 border border-accent-teal/30 text-accent-teal flex items-center justify-center">
              <User className="w-5 h-5" />
            </div>
          </div>
        </div>

        {/* Vehicle Detect */}
        <div
          onClick={() => setSelectedCategory(selectedCategory === 'vehicle' ? 'all' : 'vehicle')}
          className={`card-3d p-4 rounded-2xl border transition-all cursor-pointer select-none ${
            selectedCategory === 'vehicle'
              ? 'border-accent-yellow ring-1 ring-accent-yellow/50 bg-accent-yellow/10'
              : 'border-ink/10 hover:border-ink/20'
          }`}
        >
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <span className="text-xs font-bold text-accent-yellow uppercase tracking-wider block">
                Vehicle Detect
              </span>
              <span className="text-3xl font-extrabold text-text-primary block">
                {vehicleCount}
              </span>
              <span className="text-[11px] text-text-dim">
                Automobile & perimeter transport
              </span>
            </div>
            <div className="w-10 h-10 rounded-xl bg-accent-yellow/15 border border-accent-yellow/30 text-accent-yellow flex items-center justify-center">
              <Car className="w-5 h-5" />
            </div>
          </div>
        </div>

        {/* Unknown Detect */}
        <div
          onClick={() => setSelectedCategory(selectedCategory === 'unknown' ? 'all' : 'unknown')}
          className={`card-3d p-4 rounded-2xl border transition-all cursor-pointer select-none ${
            selectedCategory === 'unknown'
              ? 'border-accent-green ring-1 ring-accent-green/50 bg-accent-green/10'
              : 'border-ink/10 hover:border-ink/20'
          }`}
        >
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <span className="text-xs font-bold text-accent-green uppercase tracking-wider block">
                Unknown Detect
              </span>
              <span className="text-3xl font-extrabold text-text-primary block">
                {unknownCount}
              </span>
              <span className="text-[11px] text-text-dim">
                Thermal & unidentified shapes
              </span>
            </div>
            <div className="w-10 h-10 rounded-xl bg-accent-green/15 border border-accent-green/30 text-accent-green flex items-center justify-center">
              <HelpCircle className="w-5 h-5" />
            </div>
          </div>
        </div>
      </div>

      {/* 2. Target Category Filter Bar & Search */}
      <div className="card-3d p-4 bg-gradient-to-b from-bg-surface to-bg-primary border border-ink/10 rounded-2xl shadow-[0_15px_35px_rgba(0,0,0,0.8)] space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          {/* Category Filter Pills */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-text-dim uppercase tracking-wider mr-1">
              Category:
            </span>

            <button
              onClick={() => setSelectedCategory('all')}
              className={`px-3 py-1.5 text-xs font-mono rounded-xl transition-all border ${
                selectedCategory === 'all'
                  ? 'bg-accent-teal/20 text-accent-teal border-accent-teal/50 font-bold shadow-[0_0_12px_rgba(0,240,255,0.25)]'
                  : 'bg-bg-elevated text-text-dim border-ink/10 hover:text-text-primary'
              }`}
            >
              ALL DETECTIONS ({incidentsData.length})
            </button>

            <button
              onClick={() => setSelectedCategory('person')}
              className={`px-3 py-1.5 text-xs font-mono rounded-xl transition-all border flex items-center gap-1.5 ${
                selectedCategory === 'person'
                  ? 'bg-accent-teal/20 text-accent-teal border-accent-teal/50 font-bold shadow-[0_0_12px_rgba(0,240,255,0.25)]'
                  : 'bg-bg-elevated text-text-dim border-ink/10 hover:text-accent-teal'
              }`}
            >
              <User className="w-3.5 h-3.5" />
              PERSON DETECT ({personCount})
            </button>

            <button
              onClick={() => setSelectedCategory('vehicle')}
              className={`px-3 py-1.5 text-xs font-mono rounded-xl transition-all border flex items-center gap-1.5 ${
                selectedCategory === 'vehicle'
                  ? 'bg-accent-yellow/20 text-accent-yellow border-accent-yellow/50 font-bold shadow-[0_0_12px_rgba(255,170,0,0.25)]'
                  : 'bg-bg-elevated text-text-dim border-ink/10 hover:text-accent-yellow'
              }`}
            >
              <Car className="w-3.5 h-3.5" />
              VEHICLE DETECT ({vehicleCount})
            </button>

            <button
              onClick={() => setSelectedCategory('unknown')}
              className={`px-3 py-1.5 text-xs font-mono rounded-xl transition-all border flex items-center gap-1.5 ${
                selectedCategory === 'unknown'
                  ? 'bg-accent-green/20 text-accent-green border-accent-green/50 font-bold shadow-[0_0_12px_rgba(0,255,136,0.25)]'
                  : 'bg-bg-elevated text-text-dim border-ink/10 hover:text-accent-green'
              }`}
            >
              <HelpCircle className="w-3.5 h-3.5" />
              UNKNOWN DETECT ({unknownCount})
            </button>
          </div>

          {/* Quick Reset Filters */}
          {(selectedCategory !== 'all' || selectedCamera !== 'all' || selectedStatus !== 'all' || searchQuery) && (
            <button
              onClick={handleResetFilters}
              className="flex items-center gap-1.5 text-xs font-mono text-text-dim hover:text-accent-teal transition-colors"
            >
              <FilterX className="w-3.5 h-3.5" />
              <span>Reset Filters</span>
            </button>
          )}
        </div>

        {/* Camera Filter & Search Row */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-2 border-t border-ink/10">
          <div className="sm:col-span-2 relative">
            <Search className="w-4 h-4 text-text-muted absolute left-3 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by incident #, track ID, camera ID or location..."
              aria-label="Search incidents"
              className="w-full pl-9 pr-3 py-2 bg-bg-surface border border-ink/10 rounded-xl text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-teal focus:ring-1 focus:ring-accent-teal font-mono transition-all"
            />
          </div>

          <div>
            <select
              aria-label="Filter by camera"
              value={selectedCamera}
              onChange={(e) => setSelectedCamera(e.target.value)}
              className="w-full px-3 py-2 bg-bg-surface border border-ink/10 rounded-xl text-xs text-text-primary focus:outline-none focus:border-accent-teal focus:ring-1 focus:ring-accent-teal font-mono transition-all"
            >
              <option value="all">All Cameras ({availableCameras.length})</option>
              {availableCameras.map((cam) => (
                <option key={cam} value={cam}>
                  {cam === 'unknown' ? 'Camera not recorded' : cam.toUpperCase()}
                  {camMeta[cam] ? ` - ${camMeta[cam]}` : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <select
              aria-label="Filter by status"
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value as StatusFilter)}
              className="w-full px-3 py-2 bg-bg-surface border border-ink/10 rounded-xl text-xs text-text-primary focus:outline-none focus:border-accent-teal focus:ring-1 focus:ring-accent-teal font-mono transition-all"
            >
              <option value="all">All statuses</option>
              <option value="open">Open — needs action</option>
              <option value="acknowledged">Acknowledged</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>
        </div>
      </div>

      {/* 3. Incident table, with loading / offline / empty states */}
      {loading && incidentsData.length === 0 ? (
        <div role="status" className="card-3d p-10 border border-ink/10 rounded-2xl text-center text-xs font-mono text-text-dim">
          Loading incidents…
        </div>
      ) : isMock && incidentsData.length === 0 ? (
        <div role="alert" className="card-3d p-10 border border-accent-red/40 bg-accent-red/5 rounded-2xl text-center space-y-3">
          <AlertTriangle className="w-6 h-6 text-accent-red mx-auto" />
          <h3 className="text-sm font-semibold text-text-primary">Backend unreachable</h3>
          <p className="text-xs text-text-dim max-w-md mx-auto">
            {error ?? 'The API did not answer.'} Nothing is shown rather than sample data.
          </p>
          <Button variant="secondary" size="sm" onClick={() => reload()}>
            Retry
          </Button>
        </div>
      ) : incidentsData.length === 0 ? (
        <div className="card-3d p-10 border border-dashed border-ink/15 rounded-2xl text-center space-y-2">
          <CheckCircle2 className="w-6 h-6 text-accent-green mx-auto" />
          <h3 className="text-sm font-semibold text-text-primary">No incidents recorded</h3>
          <p className="text-xs text-text-dim">
            Alerts raised by the AI pipeline appear here, with their evidence, as they happen.
          </p>
        </div>
      ) : filteredIncidents.length > 0 ? (
        <>
        <Table>
          <TableHeader>
            <TableRow isHoverable={false}>
              <TableHead>
                <button
                  onClick={() =>
                    setSortDirection((prev) => (prev === 'desc' ? 'asc' : 'desc'))
                  }
                  className="flex items-center gap-1.5 text-text-dim hover:text-text-primary transition-colors select-none font-mono"
                  title="Toggle sort direction by timestamp"
                >
                  <span>TIMESTAMP</span>
                  {sortDirection === 'desc' ? (
                    <ArrowDown className="w-3.5 h-3.5 text-accent-teal" />
                  ) : (
                    <ArrowUp className="w-3.5 h-3.5 text-accent-teal" />
                  )}
                </button>
              </TableHead>
              <TableHead>DETECTION TYPE</TableHead>
              <TableHead>CAMERA LOCATION</TableHead>
              <TableHead>TRACK ID</TableHead>
              <TableHead>THREAT LEVEL</TableHead>
              <TableHead>STATUS</TableHead>
              <TableHead>SNAPSHOT</TableHead>
              <TableHead className="text-right">EVIDENCE</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredIncidents.slice(0, visibleCount).map((incident) => {
              const isPerson = incident.category === 'person';
              const isVehicle = incident.category === 'vehicle';
              const isRed = incident.tier === 'red';
              const isYellow = incident.tier === 'yellow';

              return (
                <TableRow
                  key={incident.id}
                  className={isRed ? 'bg-accent-red/[0.03]' : ''}
                >
                  {/* Timestamp */}
                  <TableCell className="font-mono text-xs text-text-dim font-medium">
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3 h-3 text-text-muted" />
                      <span>{formatTime(incident.timestamp)}</span>
                    </div>
                  </TableCell>

                  {/* Detection Type: Person Detect / Vehicle Detect / Unknown Detect */}
                  <TableCell>
                    {isPerson ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-teal/15 text-accent-teal border border-accent-teal/40 font-mono text-xs font-bold shadow-[0_0_8px_rgba(0,240,255,0.2)]">
                        <User className="w-3.5 h-3.5" />
                        PERSON DETECT
                      </span>
                    ) : isVehicle ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-yellow/15 text-accent-yellow border border-accent-yellow/40 font-mono text-xs font-bold">
                        <Car className="w-3.5 h-3.5" />
                        VEHICLE DETECT
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-green/15 text-accent-green border border-accent-green/40 font-mono text-xs font-bold">
                        <HelpCircle className="w-3.5 h-3.5" />
                        UNKNOWN DETECT
                      </span>
                    )}
                  </TableCell>

                  {/* Camera Location */}
                  <TableCell>
                    <div className="space-y-0.5">
                      <div className="font-mono text-xs font-bold text-text-primary uppercase flex items-center gap-1.5">
                        <Video className="w-3 h-3 text-accent-teal" />
                        <span>{incident.cameraName}</span>
                      </div>
                      <div className="text-[11px] text-text-dim">
                        {camMeta[incident.cameraName] ||
                          (incident.cameraName === 'unknown' ? 'Camera not recorded' : '—')}
                      </div>
                    </div>
                  </TableCell>

                  {/* Track ID */}
                  <TableCell className="font-mono text-xs text-accent-teal font-semibold">
                    #TRK-{incident.trackId}
                  </TableCell>

                  {/* Threat Level */}
                  <TableCell>
                    <Badge
                      variant={isRed ? 'red' : isYellow ? 'yellow' : 'green'}
                      dot
                      pulse={isRed}
                      size="sm"
                    >
                      {threatStatusLabel(incident.tier)} ({incident.score.toFixed(0)})
                    </Badge>
                  </TableCell>

                  {/* Operator status */}
                  <TableCell>
                    <Badge variant={STATUS_BADGE[incident.status ?? 'open'].variant} size="sm">
                      {STATUS_BADGE[incident.status ?? 'open'].label}
                    </Badge>
                  </TableCell>

                  {/* Snapshot Thumbnail Preview */}
                  <TableCell>
                    <button
                      onClick={() => openIncident(incident)}
                      title="Inspect snapshot frame"
                      aria-label={`Open evidence for incident ${incident.id}`}
                      className="w-14 h-9 rounded-lg border border-ink/15 bg-black overflow-hidden hover:border-accent-teal transition-all group relative block"
                    >
                      <EvidenceImage
                        src={apiAssetUrl(incident.snapshotUrl)}
                        alt={`Evidence thumbnail for incident ${incident.id}`}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                        compact
                      />
                      <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <Maximize2 className="w-3 h-3 text-accent-teal" />
                      </div>
                    </button>
                  </TableCell>

                  {/* View Evidence -> Sleek dashboard-styled button */}
                  <TableCell className="text-right">
                    <button
                      onClick={() => openIncident(incident)}
                      className="px-2.5 py-1 rounded-lg bg-ink/[0.06] hover:bg-accent-teal/20 text-text-dim hover:text-accent-teal border border-ink/10 hover:border-accent-teal/40 transition-all font-mono text-[10px] font-semibold inline-flex items-center gap-1 shadow-sm"
                      title="Open evidence, score breakdown and actions"
                    >
                      <Eye className="w-3 h-3" />
                      <span>View Evidence</span>
                    </button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {filteredIncidents.length > visibleCount && (
          <div className="text-center">
            <Button variant="secondary" size="sm" onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, filteredIncidents.length - visibleCount)} more (
              {filteredIncidents.length - visibleCount} not shown)
            </Button>
          </div>
        )}
        </>
      ) : (
        /* Empty State */
        <div className="card-3d p-12 bg-bg-elevated border border-dashed border-ink/15 rounded-2xl text-center space-y-3">
          <div className="p-3 bg-bg-elevated border border-ink/10 rounded-full w-12 h-12 flex items-center justify-center mx-auto text-text-muted">
            <FilterX className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-semibold text-text-primary">No Detections Found</h3>
          <p className="text-xs text-text-dim max-w-sm mx-auto">
            No targets match the active category and camera filters.
          </p>
          <Button variant="secondary" size="sm" onClick={handleResetFilters}>
            Reset Filters
          </Button>
        </div>
      )}

      {/* Snapshot Preview Modal with direct "Open Live Camera Feed" CTA */}
      {selectedIncident && (
        <Modal
          isOpen={Boolean(selectedIncident)}
          onClose={closeModal}
          title={
            <div className="flex items-center gap-2">
              {selectedIncident.category === 'person' ? (
                <User className="w-5 h-5 text-accent-teal" />
              ) : selectedIncident.category === 'vehicle' ? (
                <Car className="w-5 h-5 text-accent-yellow" />
              ) : (
                <HelpCircle className="w-5 h-5 text-accent-green" />
              )}
              <span>
                Evidence Frame: {selectedIncident.category.toUpperCase()} DETECT (#TRK-{selectedIncident.trackId})
              </span>
            </div>
          }
          description={`Incident #${selectedIncident.id} · ${
            selectedIncident.cameraName === 'unknown'
              ? 'camera not recorded'
              : `${selectedIncident.cameraName.toUpperCase()}${
                  camMeta[selectedIncident.cameraName] ? ` — ${camMeta[selectedIncident.cameraName]}` : ''
                }`
          }`}
          size="xl"
          footer={
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 w-full">
              <span className="font-mono text-xs text-text-dim">
                Captured: {formatTime(selectedIncident.timestamp)}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {(selectedIncident.status ?? 'open') === 'open' && (
                  <Button variant="secondary" size="sm" disabled={actionBusy} onClick={handleAcknowledge}>
                    Acknowledge
                  </Button>
                )}
                {selectedIncident.status !== 'resolved' && (
                  <>
                    <select
                      aria-label="Resolution reason"
                      value={resolveReason}
                      onChange={(e) => setResolveReason(e.target.value)}
                      disabled={actionBusy || reasons.length === 0}
                      className="px-2 py-1.5 bg-bg-surface border border-ink/15 rounded-lg text-xs text-text-primary font-mono focus:outline-none focus:border-accent-teal"
                    >
                      <option value="">{reasons.length ? 'Resolve as…' : 'Reasons unavailable'}</option>
                      {reasons.map((r) => (
                        <option key={r} value={r}>
                          {r.replace(/_/g, ' ')}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={actionBusy || !resolveReason}
                      onClick={handleResolve}
                    >
                      Resolve
                    </Button>
                  </>
                )}
                {selectedIncident.cameraName !== 'unknown' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={<Video className="w-4 h-4" />}
                    onClick={() => {
                      const cam = selectedIncident.cameraName;
                      closeModal();
                      handleGoToCamera(cam);
                    }}
                  >
                    Live camera
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={closeModal}>
                  Close
                </Button>
              </div>
            </div>
          }
        >
          <div className="space-y-4">
            <div className="relative aspect-video w-full rounded-xl overflow-hidden border border-ink/15 bg-black shadow-2xl">
              <EvidenceImage
                src={apiAssetUrl(activeEvidence ?? selectedIncident.snapshotUrl)}
                alt={`Evidence frame for incident ${selectedIncident.id}`}
                className="w-full h-full object-contain"
              />
            </div>

            {/* Evidence strip: full frame, target crop, and the burst frames
                captured just before the alert. */}
            {(selectedIncident.cropUrl || selectedIncident.burstUrls.length > 0) && (
              <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Evidence frames">
                {[
                  { label: 'Full frame', url: selectedIncident.snapshotUrl },
                  ...(selectedIncident.cropUrl ? [{ label: 'Target crop', url: selectedIncident.cropUrl }] : []),
                  ...selectedIncident.burstUrls.map((url, i) => ({ label: `Before ${i + 1}`, url })),
                ].map((frame) => {
                  const active = (activeEvidence ?? selectedIncident.snapshotUrl) === frame.url;
                  return (
                    <button
                      type="button"
                      key={frame.label}
                      onClick={() => setActiveEvidence(frame.url)}
                      aria-label={`Show ${frame.label}`}
                      aria-pressed={active}
                      className={`shrink-0 w-24 rounded-lg overflow-hidden border text-left ${
                        active ? 'border-accent-teal' : 'border-ink/15 hover:border-ink/40'
                      }`}
                    >
                      <div className="aspect-video bg-black">
                        <EvidenceImage
                          src={apiAssetUrl(frame.url)}
                          alt={frame.label}
                          className="w-full h-full object-cover"
                          compact
                        />
                      </div>
                      <span className="block text-[10px] font-mono text-text-dim px-1 py-0.5">{frame.label}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 bg-bg-elevated rounded-xl border border-ink/10 font-mono text-xs">
              <div>
                <span className="text-[10px] text-text-dim block uppercase">Target</span>
                <span className="text-text-primary font-bold uppercase">{selectedIncident.category}</span>
                <span className="text-[10px] text-text-muted block">
                  {selectedIncident.personId != null ? `Person #${selectedIncident.personId}` : `Track ${selectedIncident.trackId}`}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-text-dim block uppercase">Zone</span>
                <span className="text-accent-teal font-bold uppercase">
                  {selectedIncident.zoneTier === 'none' ? 'Outside zones' : selectedIncident.zoneTier}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-text-dim block uppercase">Threat score</span>
                <span className="text-text-primary font-bold">
                  {selectedIncident.score.toFixed(1)} / 100 · {threatStatusLabel(selectedIncident.tier)}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-text-dim block uppercase">Status</span>
                <Badge variant={STATUS_BADGE[selectedIncident.status ?? 'open'].variant} size="sm">
                  {STATUS_BADGE[selectedIncident.status ?? 'open'].label}
                </Badge>
                {selectedIncident.resolutionReason && (
                  <span className="text-[10px] text-text-muted block mt-0.5">
                    {selectedIncident.resolutionReason.replace(/_/g, ' ')}
                  </span>
                )}
              </div>
            </div>

            {/* Why it scored what it did */}
            <div className="p-3 rounded-xl border border-ink/10 bg-bg-elevated font-mono text-xs">
              <span className="text-[10px] text-text-dim uppercase block mb-2">Score breakdown</span>
              {selectedIncident.breakdown.recorded === false ? (
                <p className="text-text-muted">
                  Not recorded for this incident — it predates breakdown logging. Newer incidents show
                  each component here.
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    ['Sector / zone', selectedIncident.breakdown.sectorRisk, 40],
                    ['Time / curfew', selectedIncident.breakdown.timeRisk, 25],
                    ['Movement', selectedIncident.breakdown.kinematicsRisk, 20],
                    ['Class confidence', selectedIncident.breakdown.classConfidence, 15],
                    ['Crossing direction', selectedIncident.breakdown.directionRisk, null],
                    ['Loitering', selectedIncident.breakdown.loiterRisk, null],
                    ['Group', selectedIncident.breakdown.groupRisk, null],
                  ]
                    .filter(([, v]) => v != null)
                    .map(([label, value, max]) => (
                      <div key={label as string} className="p-2 rounded bg-ink/[0.03] border border-ink/5">
                        <span className="text-[10px] text-text-dim block">{label as string}</span>
                        <span className="text-text-primary font-semibold">
                          {Number(value).toFixed(1)}
                          {max ? <span className="text-text-muted"> / {max as number}</span> : null}
                        </span>
                      </div>
                    ))}
                </div>
              )}
              {selectedIncident.breakdown.overrideReason && (
                <p className="mt-2 text-accent-red">Override: {selectedIncident.breakdown.overrideReason}</p>
              )}
            </div>

            {actionError && (
              <div role="alert" className="p-2.5 rounded-lg border border-accent-red/40 bg-accent-red/10 text-accent-red text-xs font-mono">
                {actionError}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
};
