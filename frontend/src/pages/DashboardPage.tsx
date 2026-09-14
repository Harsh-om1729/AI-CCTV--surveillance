import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Incident } from '@/lib/mockIncidents';
import { apiAssetUrl, cameraStreamUrl, incidentsApi } from '@/lib/api';
import { useBackendData } from '@/lib/useBackendData';
import { threatStatusLabel, threatStatusVariant } from '@/lib/threatStatus';

import { DataSourceBadge } from '@/components/ui/DataSourceBadge';
import { EvidenceImage } from '@/components/ui/EvidenceImage';
import { useAlerts } from '@/components/alerts/AlertProvider';
import { useSystemHealth } from '@/components/system/SystemHealthProvider';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/Table';
import { CameraTile } from '@/components/live';
import { OfflineVideoPanel } from '@/components/dashboard/OfflineVideoPanel';
import {
  Activity,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Siren,
  Video,
  ArrowRight,
  User,
  Radio,
  Camera,
  ScanEye,
  GitBranch,
  Footprints,
  Database,
  Play,
  MapPin,
  ChevronRight,
  Cpu,
  Wifi,
  HardDrive,
  Server,
  CheckCircle2,
} from 'lucide-react';

// The system in one glance, in the order data actually flows. Each chip
// links to the page that goes deeper on that stage — this is what lets a
// judge who has never seen IBVAP before understand it in five seconds.
const PIPELINE_STAGES = [
  { label: 'Camera Input', icon: Camera, to: '/live' },
  { label: 'AI Detection', icon: ScanEye, to: '/analysis' },
  { label: 'Tracking', icon: GitBranch, to: '/analysis' },
  { label: 'Behaviour Analysis', icon: Footprints, to: '/analysis' },
  { label: 'Alert', icon: ShieldAlert, to: '/alerts' },
  { label: 'Evidence / Log', icon: Database, to: '/alerts' },
] as const;

const tierTextClass = (tier: 'green' | 'yellow' | 'red') =>
  tier === 'red' ? 'text-accent-red' : tier === 'yellow' ? 'text-accent-yellow' : 'text-accent-green';

// Four near-identical stat cards — one small component beats four copies of
// the same border/icon-box markup.
const KpiCard: React.FC<{
  label: string;
  value: React.ReactNode;
  sublabel: React.ReactNode;
  icon: React.ElementType;
  tone: 'teal' | 'green' | 'yellow' | 'red';
}> = ({ label, value, sublabel, icon: Icon, tone }) => {
  const toneCls = {
    teal: { border: 'border-t-accent-teal', icon: 'text-accent-teal', value: 'text-text-primary' },
    green: { border: 'border-t-accent-green', icon: 'text-accent-green', value: 'text-accent-green' },
    yellow: { border: 'border-t-accent-yellow', icon: 'text-accent-yellow', value: 'text-accent-yellow' },
    red: { border: 'border-t-accent-red', icon: 'text-accent-red', value: 'text-accent-red' },
  }[tone];
  return (
    <Card variant="default" className={`border-t-2 ${toneCls.border} ${tone === 'red' ? 'bg-accent-red/[0.04]' : ''}`}>
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <span className="text-xs font-semibold text-text-dim uppercase tracking-wider block">{label}</span>
          <span className={`text-3xl font-bold tracking-tight block ${toneCls.value}`}>{value}</span>
          <span className="text-[11px] text-text-muted font-medium">{sublabel}</span>
        </div>
        <div className={`w-10 h-10 rounded-xl bg-bg-elevated border border-ink/10 flex items-center justify-center shrink-0 ${toneCls.icon}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </Card>
  );
};

const StatChip: React.FC<{ label: string; value: React.ReactNode; icon: React.ElementType; valueClassName?: string }> = ({
  label,
  value,
  icon: Icon,
  valueClassName,
}) => (
  <div className="p-2.5 rounded-xl bg-bg-surface border border-ink/[0.06] space-y-0.5 min-w-0">
    <span className="flex items-center gap-1.5 text-[10px] text-text-dim uppercase tracking-wider">
      <Icon className="w-3 h-3 shrink-0" /> {label}
    </span>
    <span className={`block text-sm font-bold font-mono truncate ${valueClassName ?? 'text-text-primary'}`}>{value}</span>
  </div>
);

const StatusRow: React.FC<{
  icon: React.ElementType;
  label: string;
  ok: boolean;
  okLabel: string;
  badLabel: string;
  unknown?: boolean;
}> = ({ icon: Icon, label, ok, okLabel, badLabel, unknown }) => (
  <div className="flex items-center justify-between text-xs">
    <span className="flex items-center gap-1.5 text-text-dim">
      <Icon className="w-3.5 h-3.5" />
      {label}
    </span>
    <span
      className={`flex items-center gap-1.5 font-mono font-semibold ${
        unknown ? 'text-text-muted' : ok ? 'text-accent-green' : 'text-accent-red'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${unknown ? 'bg-text-muted' : ok ? 'bg-accent-green' : 'bg-accent-red'}`} />
      {unknown ? 'Checking…' : ok ? okLabel : badLabel}
    </span>
  </div>
);

export const DashboardPage: React.FC = () => {
  const navigate = useNavigate();
  const { alerts, backendStatus } = useAlerts();
  const { health, cameras, reachable } = useSystemHealth();
  const { data: stored, isMock, error } = useBackendData<Incident[]>(() => incidentsApi.getIncidents(), []);

  // WebSocket alerts are already rows in the database, so key by id instead
  // of stacking them on top of the fetch.
  const activeAlerts = React.useMemo(() => {
    const byId = new Map<number, Incident>();
    for (const i of stored) byId.set(i.id, i);
    for (const a of alerts) if (!byId.has(a.id)) byId.set(a.id, a);
    return Array.from(byId.values()).sort((a, b) => b.id - a.id);
  }, [stored, alerts]);

  const pipelineRunning = Boolean(health?.pipeline.running);
  const serverNow = health?.checkedAt ?? null;
  const liveCams = cameras.filter((c) => c.health === 'online' && c.source !== 'idle').length;

  const camerasWithStream = useMemo(
    () => cameras.map((c) => ({ ...c, streamUrl: cameraStreamUrl(c.id) })),
    [cameras]
  );
  const normalCams = camerasWithStream.filter((c) => c.maxTier !== 'red' && c.maxTier !== 'yellow').length;
  const watchCams = camerasWithStream.filter((c) => c.maxTier === 'yellow').length;
  const criticalCams = camerasWithStream.filter((c) => c.maxTier === 'red').length;

  const gridCameras = camerasWithStream.slice(0, 6);
  const extraCameraCount = camerasWithStream.length - gridCameras.length;

  const latestAlert = activeAlerts[0];
  const alertReasons: string[] = useMemo(() => {
    if (!latestAlert) return [];
    const recorded = latestAlert.breakdown?.threatReasons;
    if (recorded && recorded.length) return recorded;
    const fallback: string[] = [];
    if (latestAlert.whatHeIsDoing) fallback.push(latestAlert.whatHeIsDoing);
    if (latestAlert.direction) fallback.push(`Movement direction: ${latestAlert.direction}`);
    if (latestAlert.zoneTier && latestAlert.zoneTier !== 'none') {
      fallback.push(`Detected inside the ${latestAlert.zoneTier.toUpperCase()} zone`);
    }
    if (latestAlert.threatLevel) fallback.push(`Threat level: ${latestAlert.threatLevel}`);
    return fallback;
  }, [latestAlert]);

  const recentIncidents = useMemo(
    () => [...activeAlerts].sort((a, b) => b.timestamp - a.timestamp).slice(0, 6),
    [activeAlerts]
  );

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const diskPct = health?.disk.percentUsed ?? 0;
  const diskTone = diskPct > 90 ? 'bg-accent-red' : diskPct > 75 ? 'bg-accent-yellow' : 'bg-accent-teal';
  const allSystemsOk = reachable === true && pipelineRunning && (health?.database.ok ?? false) && backendStatus === 'connected';

  return (
    <div className="space-y-5">
      {/* Header + "how it works" strip — orients a first-time viewer before
          any numbers are shown. */}
      <div className="bg-bg-surface border border-border-subtle rounded-2xl p-4 shadow-lg space-y-4">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-text-primary flex items-center gap-2">
              <span>IBVAP — Border Video Analytics Overview</span>
              <DataSourceBadge isMock={isMock} error={error} />
            </h1>
            <p className="text-xs text-text-dim mt-0.5">
              Camera → AI Detection → Tracking → Behaviour Analysis → Alert → Evidence, running end to end.
            </p>
          </div>
          <Button variant="secondary" size="sm" leftIcon={<Play className="w-3.5 h-3.5" />} onClick={() => navigate('/demo')}>
            Guided Demo
          </Button>
        </div>

        <div className="flex items-center overflow-x-auto pb-0.5">
          {PIPELINE_STAGES.map((stage, i) => {
            const Icon = stage.icon;
            return (
              <React.Fragment key={stage.label}>
                <button
                  onClick={() => navigate(stage.to)}
                  className="flex flex-col items-center gap-1 shrink-0 px-2 group min-w-[86px]"
                >
                  <div className="w-9 h-9 rounded-full border border-ink/15 bg-ink/[0.03] flex items-center justify-center text-accent-teal group-hover:border-accent-teal/50 group-hover:bg-accent-teal/10 transition-colors">
                    <Icon className="w-4 h-4" />
                  </div>
                  <span className="text-[10px] text-text-dim group-hover:text-text-primary text-center leading-tight">
                    {stage.label}
                  </span>
                </button>
                {i < PIPELINE_STAGES.length - 1 && <div className="h-px flex-1 min-w-[10px] bg-ink/10" />}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* System status conditions an operator must know before trusting the numbers */}
      {(reachable === false || isMock) && (
        <div role="alert" className="p-3 rounded-xl border border-accent-red/40 bg-accent-red/10 text-xs font-mono text-accent-red">
          Backend unreachable — no live data is shown. Start it with ./run.sh up; this page recovers
          automatically once the API answers.
        </div>
      )}
      {reachable && health && !pipelineRunning && (
        <div role="status" className="p-3 rounded-xl border border-accent-yellow/40 bg-accent-yellow/10 text-xs font-mono text-accent-yellow">
          The AI pipeline is not running: cameras are not being analysed and no new alerts will be raised.
          Start it with ./run.sh (or ./run.sh all for everything), or try the Guided Demo above.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
        <span className="flex items-center gap-2 bg-bg-surface px-3 py-1.5 rounded-lg border border-border-subtle">
          <span className={`w-2 h-2 rounded-full ${pipelineRunning ? 'bg-accent-green' : 'bg-accent-yellow'}`} />
          {pipelineRunning ? 'AI PIPELINE RUNNING' : 'AI PIPELINE STOPPED'}
        </span>
        <span className="flex items-center gap-2 bg-bg-surface px-3 py-1.5 rounded-lg border border-border-subtle">
          <span className={`w-2 h-2 rounded-full ${backendStatus === 'connected' ? 'bg-accent-green' : 'bg-accent-yellow'}`} />
          {backendStatus === 'connected' ? 'ALERT FEED LIVE' : 'ALERT FEED RECONNECTING'}
        </span>
      </div>

      {/* KPI Stat Cards — per-camera status, not incident counts, so this
          reads at a glance the same way a wall display would. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Total Cameras"
          icon={Video}
          tone="teal"
          value={cameras.length}
          sublabel={
            <>
              <span className="text-accent-green font-semibold">{liveCams} Online</span>
              {cameras.length - liveCams > 0 && (
                <>
                  {' '}
                  · <span className="text-accent-red font-semibold">{cameras.length - liveCams} Offline</span>
                </>
              )}
            </>
          }
        />
        <KpiCard label="Normal" icon={ShieldCheck} tone="green" value={normalCams} sublabel="No immediate threat" />
        <KpiCard label="Under Watch" icon={AlertTriangle} tone="yellow" value={watchCams} sublabel="Needs attention" />
        <KpiCard label="Critical" icon={Siren} tone="red" value={criticalCams} sublabel="Immediate action" />
      </div>

      {/* Live Camera Feeds */}
      <Card
        title={
          <div className="flex items-center gap-2">
            <Video className="w-4 h-4 text-accent-teal" />
            <span>Live Camera Feeds</span>
          </div>
        }
        subtitle={`${liveCams}/${cameras.length} online — click a feed to open it`}
        action={
          <Button variant="ghost" size="sm" className="text-xs" rightIcon={<ArrowRight className="w-3.5 h-3.5" />} onClick={() => navigate('/live')}>
            View All
          </Button>
        }
      >
        {gridCameras.length === 0 ? (
          <div className="p-8 text-center text-xs text-text-dim font-mono">
            {reachable === false ? 'Backend offline — camera status unknown.' : 'No cameras configured. Set CAMERA_SOURCES in .env or use Camera Management.'}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {gridCameras.map((cam) => (
                <div key={cam.id} onClick={() => navigate(`/live?camera=${cam.id}`)} className="cursor-pointer">
                  <CameraTile
                    cameraName={cam.name}
                    streamUrl={cam.streamUrl}
                    fps={cam.fps}
                    source={cam.source}
                    health={cam.health}
                    zones={cam.zones}
                    detections={cam.detections}
                    maxTier={cam.maxTier}
                    lastFrameAt={cam.lastFrameAt}
                    serverNow={serverNow}
                    onToggleFocus={() => navigate(`/live?camera=${cam.id}`)}
                  />
                </div>
              ))}
            </div>
            {extraCameraCount > 0 && (
              <button
                onClick={() => navigate('/live')}
                className="mt-3 w-full text-center text-[11px] font-mono text-text-dim hover:text-text-primary py-2 rounded-lg border border-dashed border-ink/10 hover:border-ink/25 transition-colors"
              >
                +{extraCameraCount} more camera{extraCameraCount === 1 ? '' : 's'} — View All
              </button>
            )}
          </>
        )}
      </Card>

      {/* Offline Video Analysis — upload a recorded clip and activate it so
          the real AI pipeline analyses it, same as a live camera. */}
      <OfflineVideoPanel />

      {/* Latest Alert / threat reasoning */}
      <Card
        title={
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-accent-red" />
            <span>Latest Alert</span>
          </div>
        }
        subtitle={latestAlert ? `#TRK-${latestAlert.trackId} on ${latestAlert.cameraName}` : 'No alerts recorded yet'}
        action={
          latestAlert && (
            <Badge variant={threatStatusVariant(latestAlert.tier)} size="sm">
              {threatStatusLabel(latestAlert.tier)}
            </Badge>
          )
        }
      >
        {!latestAlert ? (
          <div className="p-6 text-center text-xs text-text-dim font-mono">🟢 No alerts recorded — border perimeters secure.</div>
        ) : (
          <div className="flex flex-col md:flex-row gap-5">
            <div className="flex-1 space-y-3.5 min-w-0">
              {/* The reason this fired is the headline — an operator should
                  be able to tell what's wrong without reading a score. */}
              <div>
                <h3 className="text-lg font-bold text-text-primary capitalize leading-snug">
                  {latestAlert.category} detected
                  {latestAlert.zoneTier !== 'none' ? ` in the ${latestAlert.zoneTier} zone` : ''}
                </h3>
                {latestAlert.whatHeIsDoing && (
                  <p className="text-sm text-text-primary/90 mt-1 leading-relaxed">{latestAlert.whatHeIsDoing}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <span className="text-[11px] font-bold text-text-dim uppercase tracking-wider">Why is this a threat?</span>
                {alertReasons.length === 0 ? (
                  <p className="text-xs text-text-muted font-mono">No scoring breakdown recorded for this incident.</p>
                ) : (
                  <ul className="space-y-1">
                    {alertReasons.map((reason, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-text-dim">
                        <ChevronRight className="w-3.5 h-3.5 mt-0.5 text-accent-teal shrink-0" />
                        <span>{reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Supporting numbers — deliberately smaller and after the
                  reason, not before it. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <StatChip label="Track ID" value={`#${latestAlert.trackId}`} icon={User} />
                <StatChip label="Camera" value={latestAlert.cameraName} icon={Camera} />
                <StatChip
                  label="Zone"
                  value={latestAlert.zoneTier === 'none' ? '—' : `${latestAlert.zoneTier}${latestAlert.direction ? ` (${latestAlert.direction})` : ''}`}
                  icon={MapPin}
                  valueClassName={latestAlert.zoneTier !== 'none' ? tierTextClass(latestAlert.zoneTier as 'green' | 'yellow' | 'red') : undefined}
                />
                <StatChip
                  label="Threat Score"
                  value={`${latestAlert.score.toFixed(0)} / 100`}
                  icon={Activity}
                  valueClassName={tierTextClass(latestAlert.tier)}
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="text-xs"
                rightIcon={<ArrowRight className="w-3.5 h-3.5" />}
                onClick={() => navigate(`/alerts?incident=${latestAlert.id}`)}
              >
                Open in Alerts &amp; Events
              </Button>
            </div>

            <div className="w-full md:w-64 shrink-0">
              <EvidenceImage
                src={apiAssetUrl(latestAlert.cropUrl ?? latestAlert.snapshotUrl)}
                alt={`Evidence for track ${latestAlert.trackId}`}
                className="w-full aspect-video object-cover rounded-xl border border-ink/10"
              />
            </div>
          </div>
        )}
      </Card>

      {/* Recent Incidents + Border Overview + System Status */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <Database className="w-4 h-4 text-accent-teal" />
              Recent Incidents
            </h2>
            <Button variant="ghost" size="sm" className="text-xs" rightIcon={<ArrowRight className="w-3.5 h-3.5" />} onClick={() => navigate('/alerts')}>
              View All
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow isHoverable={false}>
                <TableHead>Time</TableHead>
                <TableHead>Camera</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Zone</TableHead>
                <TableHead>Threat</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentIncidents.length === 0 ? (
                <TableRow isHoverable={false}>
                  <TableCell colSpan={6} className="text-center text-text-dim font-mono text-xs py-6">
                    No incidents recorded yet
                  </TableCell>
                </TableRow>
              ) : (
                recentIncidents.map((inc) => (
                  <TableRow key={inc.id} className="cursor-pointer" onClick={() => navigate(`/alerts?incident=${inc.id}`)}>
                    <TableCell className="font-mono text-xs text-text-dim whitespace-nowrap">{formatTime(inc.timestamp)}</TableCell>
                    <TableCell className="font-mono text-xs font-bold text-text-primary uppercase">{inc.cameraName}</TableCell>
                    <TableCell className="text-xs text-text-primary truncate max-w-[260px]" title={inc.whatHeIsDoing || undefined}>
                      {inc.whatHeIsDoing || `${inc.category} detected`}
                    </TableCell>
                    <TableCell>
                      <span className={`text-xs font-mono font-semibold ${inc.zoneTier !== 'none' ? tierTextClass(inc.zoneTier as 'green' | 'yellow' | 'red') : 'text-text-dim'}`}>
                        {inc.zoneTier === 'none' ? '—' : inc.zoneTier.toUpperCase()}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-text-dim">{inc.score.toFixed(0)}</TableCell>
                    <TableCell>
                      <Badge size="sm" variant={threatStatusVariant(inc.tier)}>
                        {threatStatusLabel(inc.tier)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="lg:col-span-4 space-y-3">
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <MapPin className="w-4 h-4 text-accent-teal" />
            Border Overview
          </h2>
          <Card bodyClassName="p-4">
            <div className="relative w-full aspect-[4/3] rounded-xl bg-bg-primary border border-ink/10 overflow-hidden">
              <div className="absolute left-0 right-0 top-1/2 h-px bg-accent-red/40" />
              {camerasWithStream.length === 0 ? (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-text-dim font-mono">No cameras configured</div>
              ) : (
                camerasWithStream.map((cam, i) => {
                  const col = camerasWithStream.length > 1 ? i / (Math.min(camerasWithStream.length, 8) - 1 || 1) : 0.5;
                  const left = 10 + (col % 1.001) * 80;
                  const top = Math.floor(i / 4) % 2 === 0 ? 32 : 68;
                  const dotColor =
                    cam.maxTier === 'red'
                      ? 'bg-accent-red'
                      : cam.maxTier === 'yellow'
                      ? 'bg-accent-yellow'
                      : cam.health === 'online'
                      ? 'bg-accent-green'
                      : 'bg-text-muted';
                  return (
                    <button
                      key={cam.id}
                      type="button"
                      onClick={() => navigate(`/live?camera=${cam.id}`)}
                      title={`${cam.name} — ${cam.location}`}
                      className="absolute flex flex-col items-center gap-1 -translate-x-1/2 -translate-y-1/2 group"
                      style={{ left: `${left}%`, top: `${top}%` }}
                    >
                      <span className={`w-3 h-3 rounded-full ring-2 ring-black/60 ${dotColor} ${cam.maxTier === 'red' ? 'animate-pulse' : ''}`} />
                      <span className="text-[9px] font-mono text-text-dim group-hover:text-text-primary transition-colors">{cam.id.toUpperCase()}</span>
                    </button>
                  );
                })
              )}
            </div>
            <p className="text-[10px] text-text-dim font-mono mt-2">Illustrative sector layout, not to scale — click a dot to inspect that camera.</p>
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[10px] font-mono text-text-dim">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-accent-red" />Critical</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-accent-yellow" />Under Watch</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-accent-green" />Normal</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-text-muted" />Offline</span>
            </div>
          </Card>
        </div>

        <div className="lg:col-span-3 space-y-3">
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <Server className="w-4 h-4 text-accent-teal" />
            System Status
          </h2>
          <Card bodyClassName="p-4 space-y-3">
            <StatusRow icon={Cpu} label="AI Engine" ok={pipelineRunning} okLabel="Online" badLabel="Stopped" unknown={reachable === null} />
            <StatusRow icon={GitBranch} label="Tracking System" ok={pipelineRunning} okLabel="Online" badLabel="Stopped" unknown={reachable === null} />
            <StatusRow icon={Database} label="Database" ok={health?.database.ok ?? false} okLabel="Online" badLabel="Error" unknown={reachable === null} />
            <StatusRow icon={Radio} label="Alert Feed" ok={backendStatus === 'connected'} okLabel="Connected" badLabel="Reconnecting" />
            <StatusRow icon={Wifi} label="Network" ok={reachable === true} okLabel="Online" badLabel="Offline" unknown={reachable === null} />
            <div className="pt-1">
              <div className="flex items-center justify-between text-xs font-mono text-text-dim mb-1">
                <span className="flex items-center gap-1.5">
                  <HardDrive className="w-3.5 h-3.5" />
                  Storage
                </span>
                <span className="text-text-primary font-semibold">{health?.disk.percentUsed != null ? `${health.disk.percentUsed.toFixed(0)}%` : '—'}</span>
              </div>
              <div className="h-1.5 rounded-full bg-ink/5 overflow-hidden">
                <div className={`h-full rounded-full ${diskTone}`} style={{ width: `${Math.min(100, diskPct)}%` }} />
              </div>
            </div>
          </Card>
          <div
            className={`p-3 rounded-xl border text-xs font-mono flex items-center gap-2 ${
              allSystemsOk ? 'border-accent-green/30 bg-accent-green/10 text-accent-green' : 'border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow'
            }`}
          >
            {allSystemsOk ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
            <span>
              {allSystemsOk
                ? 'All critical systems operational'
                : reachable === false
                ? 'Backend unreachable — showing last known data'
                : 'Some systems need attention — see status above'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
