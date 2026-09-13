import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Incident } from '@/lib/mockIncidents';
import { incidentsApi } from '@/lib/api';
import { useBackendData } from '@/lib/useBackendData';

import { DataSourceBadge } from '@/components/ui/DataSourceBadge';
import { useAlerts } from '@/components/alerts/AlertProvider';
import { describeCamera, useSystemHealth } from '@/components/system/SystemHealthProvider';
import {
  getDashboardStats,
  getHourlyThreatTimeline,
  getRealtimeThreatStream,
} from '@/lib/analyticsUtils';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import {
  Activity,
  ShieldAlert,
  AlertTriangle,
  Video,
  ArrowRight,
  Clock,
  Eye,
  User,
  Car,
  HelpCircle,
  Radio,
  Camera,
  ScanEye,
  GitBranch,
  Footprints,
  Database,
  Play,
} from 'lucide-react';

const CustomDashboardTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="p-3 bg-[#080a10] border border-[#1a1e2b] rounded-xl shadow-xl text-xs space-y-2 min-w-[160px]">
        <div className="text-white font-bold border-b border-white/10 pb-1 flex items-center justify-between">
          <span>{label}</span>
          <span className="text-[10px] text-accent-teal font-mono uppercase">OBSERVATION</span>
        </div>
        <div className="space-y-1 font-medium font-mono text-[11px]">
          <div className="flex items-center justify-between text-accent-red">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-red" />
              Critical:
            </span>
            <span className="font-bold">{payload.find((p: any) => p.dataKey === 'red')?.value || 0}</span>
          </div>
          <div className="flex items-center justify-between text-accent-yellow">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-yellow" />
              Caution:
            </span>
            <span className="font-bold">{payload.find((p: any) => p.dataKey === 'yellow')?.value || 0}</span>
          </div>
          <div className="flex items-center justify-between text-accent-green">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />
              Normal:
            </span>
            <span className="font-bold">{payload.find((p: any) => p.dataKey === 'green')?.value || 0}</span>
          </div>
        </div>
      </div>
    );
  }
  return null;
};

const CustomRealtimeTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    const tierColor =
      data.tier === 'red' ? 'text-accent-red' : data.tier === 'yellow' ? 'text-accent-yellow' : 'text-accent-green';

    return (
      <div className="p-3 bg-[#080a10] border border-[#1a1e2b] rounded-xl shadow-xl text-xs space-y-1.5 min-w-[190px]">
        <div className="text-white font-bold border-b border-white/10 pb-1 flex items-center justify-between">
          <span className="font-mono text-accent-teal">#TRK-{data.trackId}</span>
          <span className="text-[10px] text-text-muted font-mono">{data.timeLabel}</span>
        </div>
        <div className="space-y-1 font-mono text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-text-dim">Camera:</span>
            <span className="font-bold text-white uppercase">{data.cameraName}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-text-dim">Category:</span>
            <span className="font-semibold text-white capitalize">{data.category}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-text-dim">Tier:</span>
            <span className={`font-bold ${tierColor}`}>{data.tier.toUpperCase()}</span>
          </div>
          <div className="flex items-center justify-between border-t border-white/10 pt-1">
            <span className="text-text-dim font-bold">Threat Score:</span>
            <span className={`font-bold text-xs ${tierColor}`}>{data.threatScore.toFixed(1)} / 100</span>
          </div>
        </div>
      </div>
    );
  }
  return null;
};

const RenderRealtimeDot = (props: any) => {
  const { cx, cy, payload } = props;
  if (!cx || !cy) return null;
  const color = payload.tier === 'red' ? '#f02555' : payload.tier === 'yellow' ? '#f09f00' : '#00e077';
  return <circle cx={cx} cy={cy} r={4} fill={color} stroke="#05070a" strokeWidth={1.5} />;
};

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

export const DashboardPage: React.FC = () => {
  const navigate = useNavigate();
  const { alerts, backendStatus } = useAlerts();
  const { health, cameras, reachable } = useSystemHealth();
  const { data: stored, setData: setStored, isMock, error } = useBackendData<Incident[]>(() => incidentsApi.getIncidents(), []);

  // WebSocket alerts are already rows in the database, so key by id instead
  // of stacking them on top of the fetch.
  const activeAlerts = React.useMemo(() => {
    const byId = new Map<number, Incident>();
    for (const i of stored) byId.set(i.id, i);
    for (const a of alerts) if (!byId.has(a.id)) byId.set(a.id, a);
    return Array.from(byId.values()).sort((a, b) => b.id - a.id);
  }, [stored, alerts]);

  const [chartMode, setChartMode] = useState<'realtime' | '24h'>('realtime');

  const handleAcknowledge = async (id: number) => {
    const res = await incidentsApi.acknowledgeIncident(id);
    if (!res.isFallback) {
      setStored((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'acknowledged' } : i)));
    }
  };
  const handleResolve = async (id: number) => {
    const res = await incidentsApi.resolveIncident(id, 'genuine_intrusion');
    if (!res.isFallback && res.data) {
      const updated = res.data;
      setStored((prev) => prev.map((i) => (i.id === id ? { ...i, ...updated } : i)));
    }
  };

  const stats = getDashboardStats(activeAlerts);
  const timelineData = getHourlyThreatTimeline(activeAlerts);
  const realtimeStream = getRealtimeThreatStream(activeAlerts, 14);
  const latestAlert = activeAlerts[0];

  const openList = activeAlerts.filter((i) => (i.status ?? 'open') === 'open');
  const openTotal = health?.database.open ?? openList.length;
  const openRed = health?.database.openRed ?? openList.filter((i) => i.tier === 'red').length;
  const openYellow = health?.database.openYellow ?? openList.filter((i) => i.tier === 'yellow').length;
  const liveCams = cameras.filter((c) => c.health === 'online' && c.source !== 'idle').length;
  const pipelineRunning = Boolean(health?.pipeline.running);

  const recentCriticalAlerts = activeAlerts
    .filter((i) => i.tier === 'red' || i.tier === 'yellow')
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 5);

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div className="space-y-5">
      {/* Header + "how it works" strip — orients a first-time viewer before
          any numbers are shown. */}
      <div className="bg-[#0b0e17] border border-[#1b2234] rounded-2xl p-4 shadow-lg space-y-4">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
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
                  <div className="w-9 h-9 rounded-full border border-white/15 bg-white/[0.03] flex items-center justify-center text-accent-teal group-hover:border-accent-teal/50 group-hover:bg-accent-teal/10 transition-colors">
                    <Icon className="w-4 h-4" />
                  </div>
                  <span className="text-[10px] text-text-dim group-hover:text-white text-center leading-tight">
                    {stage.label}
                  </span>
                </button>
                {i < PIPELINE_STAGES.length - 1 && <div className="h-px flex-1 min-w-[10px] bg-white/10" />}
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
        <span className="flex items-center gap-2 bg-[#0a0d14] px-3 py-1.5 rounded-lg border border-[#161924]">
          <span className={`w-2 h-2 rounded-full ${pipelineRunning ? 'bg-accent-green' : 'bg-accent-yellow'}`} />
          {pipelineRunning ? 'AI PIPELINE RUNNING' : 'AI PIPELINE STOPPED'}
        </span>
        <span className="flex items-center gap-2 bg-[#0a0d14] px-3 py-1.5 rounded-lg border border-[#161924]">
          <span className={`w-2 h-2 rounded-full ${backendStatus === 'connected' ? 'bg-accent-green' : 'bg-accent-yellow'}`} />
          {backendStatus === 'connected' ? 'ALERT FEED LIVE' : 'ALERT FEED RECONNECTING'}
        </span>
      </div>

      {/* KPI Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card variant="default" className="border-t-2 border-t-accent-teal">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <span className="text-xs font-semibold text-text-dim uppercase tracking-wider block">Open Incidents</span>
              <span className="text-3xl font-bold tracking-tight text-white block">{openTotal}</span>
              <span className="text-[11px] text-text-muted font-medium">
                Awaiting acknowledgement · {health?.database.total ?? stats.totalIncidents} recorded
              </span>
            </div>
            <div className="w-10 h-10 rounded-xl bg-[#0e121c] border border-white/10 text-accent-teal flex items-center justify-center">
              <Activity className="w-5 h-5" />
            </div>
          </div>
        </Card>

        <Card variant="default" className="border-t-2 border-t-accent-red">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <span className="text-xs font-semibold text-text-dim uppercase tracking-wider block">Critical Threats</span>
              <span className="text-3xl font-bold tracking-tight text-accent-red block">{openRed}</span>
              <span className="text-[11px] text-accent-red/80 font-medium">Open RED — immediate response</span>
            </div>
            <div className="w-10 h-10 rounded-xl bg-[#0e121c] border border-white/10 text-accent-red flex items-center justify-center">
              <ShieldAlert className="w-5 h-5" />
            </div>
          </div>
        </Card>

        <Card variant="default" className="border-t-2 border-t-accent-yellow">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <span className="text-xs font-semibold text-text-dim uppercase tracking-wider block">Caution Alerts</span>
              <span className="text-3xl font-bold tracking-tight text-accent-yellow block">{openYellow}</span>
              <span className="text-[11px] text-text-muted font-medium">Open YELLOW in the loaded history</span>
            </div>
            <div className="w-10 h-10 rounded-xl bg-[#0e121c] border border-white/10 text-accent-yellow flex items-center justify-center">
              <AlertTriangle className="w-5 h-5" />
            </div>
          </div>
        </Card>

        <Card variant="default" className="border-t-2 border-t-accent-green">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <span className="text-xs font-semibold text-text-dim uppercase tracking-wider block">Cameras Live</span>
              <span
                className={`text-3xl font-bold tracking-tight block ${
                  cameras.length > 0 && liveCams === cameras.length ? 'text-accent-green' : 'text-accent-yellow'
                }`}
              >
                {liveCams} / {cameras.length}
              </span>
              <span className="text-[11px] text-text-muted font-medium">
                {reachable === false
                  ? 'Backend offline — status unknown'
                  : pipelineRunning
                  ? 'Analysed by the AI pipeline'
                  : 'Pipeline stopped — not analysed'}
              </span>
            </div>
            <div className="w-10 h-10 rounded-xl bg-[#0e121c] border border-white/10 text-accent-green flex items-center justify-center">
              <Video className="w-5 h-5" />
            </div>
          </div>
        </Card>
      </div>

      {/* Threat graph + camera status */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <Card
          className="lg:col-span-8"
          title={
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-accent-teal" />
              <span>Threat Activity Graph</span>
            </div>
          }
          subtitle={
            chartMode === 'realtime'
              ? 'Synchronized live threat scores for each incoming alert'
              : 'Hourly threat density across perimeter observation zones'
          }
          action={
            <div className="flex items-center gap-3 text-xs">
              <div className="flex items-center p-0.5 rounded-lg bg-[#07090f] border border-[#161924]">
                <button
                  onClick={() => setChartMode('realtime')}
                  className={`px-2.5 py-1 rounded text-[11px] font-mono font-medium transition-colors ${
                    chartMode === 'realtime' ? 'bg-[#141a29] text-white border border-white/10' : 'text-text-muted hover:text-white'
                  }`}
                >
                  Live Stream
                </button>
                <button
                  onClick={() => setChartMode('24h')}
                  className={`px-2.5 py-1 rounded text-[11px] font-mono font-medium transition-colors ${
                    chartMode === '24h' ? 'bg-[#141a29] text-white border border-white/10' : 'text-text-muted hover:text-white'
                  }`}
                >
                  24H Trend
                </button>
              </div>
            </div>
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 mb-2 rounded-lg bg-[#07090f] border border-[#161924] text-xs font-mono">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${backendStatus === 'connected' ? 'bg-accent-green' : 'bg-accent-yellow'}`} />
              <span className={`font-semibold ${backendStatus === 'connected' ? 'text-accent-green' : 'text-accent-yellow'}`}>
                {backendStatus === 'connected' ? 'NEW ALERTS APPEAR LIVE' : 'ALERT FEED RECONNECTING'}
              </span>
              <span className="text-text-dim text-[11px]">({activeAlerts.length} incidents loaded)</span>
            </div>
            {latestAlert && (
              <div className="flex items-center gap-1.5 text-[11px] text-text-dim">
                <span>Latest Alert:</span>
                <span className="font-bold text-white uppercase">{latestAlert.cameraName}</span>
                <span
                  className={`font-bold px-1.5 py-0.2 rounded text-[10px] ${
                    latestAlert.tier === 'red'
                      ? 'bg-accent-red/20 text-accent-red border border-accent-red/30'
                      : latestAlert.tier === 'yellow'
                      ? 'bg-accent-yellow/20 text-accent-yellow border border-accent-yellow/30'
                      : 'bg-accent-green/20 text-accent-green border border-accent-green/30'
                  }`}
                >
                  {latestAlert.tier.toUpperCase()}
                </span>
                <span className="text-white font-bold">(Score: {latestAlert.score.toFixed(1)})</span>
              </div>
            )}
          </div>

          <div className="h-72 w-full pt-1">
            <ResponsiveContainer width="100%" height="100%">
              {chartMode === 'realtime' ? (
                <AreaChart data={realtimeStream} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorThreatScore" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00d2df" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#00d2df" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#131622" vertical={false} />
                  <XAxis dataKey="timeLabel" stroke="#4b5563" tick={{ fill: '#8c98a8', fontSize: 10 }} axisLine={{ stroke: '#161924' }} />
                  <YAxis domain={[0, 100]} stroke="#4b5563" tick={{ fill: '#8c98a8', fontSize: 10 }} axisLine={{ stroke: '#161924' }} allowDecimals={false} />
                  <Tooltip content={<CustomRealtimeTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="threatScore"
                    stroke="#00d2df"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorThreatScore)"
                    isAnimationActive={false}
                    dot={<RenderRealtimeDot />}
                  />
                </AreaChart>
              ) : (
                <AreaChart data={timelineData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorRed" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f02555" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#f02555" stopOpacity={0.0} />
                    </linearGradient>
                    <linearGradient id="colorYellow" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f09f00" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#f09f00" stopOpacity={0.0} />
                    </linearGradient>
                    <linearGradient id="colorGreen" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00e077" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#00e077" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#131622" vertical={false} />
                  <XAxis dataKey="timeLabel" stroke="#4b5563" tick={{ fill: '#8c98a8', fontSize: 10 }} axisLine={{ stroke: '#161924' }} />
                  <YAxis stroke="#4b5563" tick={{ fill: '#8c98a8', fontSize: 10 }} axisLine={{ stroke: '#161924' }} allowDecimals={false} />
                  <Tooltip content={<CustomDashboardTooltip />} />
                  <Area type="monotone" dataKey="red" stroke="#f02555" strokeWidth={2} fillOpacity={1} fill="url(#colorRed)" isAnimationActive={false} />
                  <Area type="monotone" dataKey="yellow" stroke="#f09f00" strokeWidth={2} fillOpacity={1} fill="url(#colorYellow)" isAnimationActive={false} />
                  <Area type="monotone" dataKey="green" stroke="#00e077" strokeWidth={2} fillOpacity={1} fill="url(#colorGreen)" isAnimationActive={false} />
                </AreaChart>
              )}
            </ResponsiveContainer>
          </div>
        </Card>

        <Card
          className="lg:col-span-4 flex flex-col justify-between"
          title="Camera Status"
          subtitle={pipelineRunning ? 'Analysed by the AI pipeline' : 'AI pipeline stopped — preview only'}
          action={
            <Badge variant={cameras.length > 0 && liveCams === cameras.length ? 'green' : 'yellow'} dot size="sm">
              {liveCams}/{cameras.length} live
            </Badge>
          }
          footer={
            <div className="flex gap-2 w-full">
              <Button variant="secondary" size="sm" className="flex-1 justify-between text-xs" rightIcon={<ArrowRight className="w-3.5 h-3.5" />} onClick={() => navigate('/live')}>
                Live Feeds
              </Button>
              <Button variant="ghost" size="sm" className="flex-1 justify-between text-xs" rightIcon={<ArrowRight className="w-3.5 h-3.5" />} onClick={() => navigate('/cameras')}>
                Manage
              </Button>
            </div>
          }
        >
          <div className="space-y-2.5">
            {cameras.length === 0 ? (
              <div className="p-4 text-center text-xs text-text-dim font-mono">
                {reachable === false
                  ? 'Backend offline — camera status unknown.'
                  : 'No cameras configured. Set CAMERA_SOURCES in .env or use Camera Management.'}
              </div>
            ) : (
              cameras.map((cam) => {
                const st = describeCamera(cam, reachable);
                const dot = { green: 'bg-accent-green', yellow: 'bg-accent-yellow', red: 'bg-accent-red', muted: 'bg-text-muted' }[st.tone];
                return (
                  <button
                    type="button"
                    key={cam.id}
                    onClick={() => navigate(`/live?camera=${cam.id}`)}
                    className="w-full text-left p-3 rounded-xl bg-[#090c12] border border-white/[0.06] hover:border-white/20 transition-colors flex items-center justify-between gap-2 group"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-[#0e121c] border border-white/10 flex items-center justify-center text-accent-teal shrink-0">
                        <Video className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 space-y-0.5">
                        <span className="text-xs font-semibold text-white truncate block uppercase">{cam.name}</span>
                        <span className="text-[11px] text-text-dim truncate block">{cam.location}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-[11px] font-mono">
                      {cam.source !== 'idle' && <span className="text-accent-teal font-semibold">{cam.fps} FPS</span>}
                      <span className="text-text-dim hidden xl:inline">{st.label}</span>
                      <span className={`inline-flex rounded-full h-2 w-2 ${dot}`} aria-label={st.label} />
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </Card>
      </div>

      {/* Recent Critical Alerts */}
      <Card
        title={
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-accent-red" />
            <span className="text-sm font-bold tracking-tight">Recent Critical Alerts</span>
          </div>
        }
        subtitle="Most recent caution and critical alerts — open one for evidence and actions"
        action={
          <Button variant="secondary" size="sm" className="text-xs h-7 px-3 font-mono" rightIcon={<ArrowRight className="w-3.5 h-3.5" />} onClick={() => navigate('/alerts')}>
            All Alerts
          </Button>
        }
      >
        <div className="space-y-2">
          {recentCriticalAlerts.length === 0 ? (
            <div className="p-6 text-center text-xs text-text-dim font-mono">
              🟢 No recent critical alerts — border perimeters secure.
            </div>
          ) : (
            recentCriticalAlerts.map((alert) => (
              <div
                key={alert.id}
                onClick={() => navigate(`/alerts?incident=${alert.id}`)}
                className="p-3 bg-[#090c12] border border-white/[0.06] border-l-2 border-l-accent-red hover:border-white/20 transition-colors rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-2.5 cursor-pointer group"
              >
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <span
                    className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold tracking-wider ${
                      alert.tier === 'red' ? 'bg-accent-red/20 text-accent-red border border-accent-red/30' : 'bg-accent-yellow/20 text-accent-yellow border border-accent-yellow/30'
                    }`}
                  >
                    {alert.tier === 'red' ? 'CRITICAL' : 'CAUTION'}
                  </span>
                  <div className="flex items-center gap-1 text-[11px] text-text-dim font-mono">
                    <Clock className="w-3 h-3 text-text-muted" />
                    <span>{formatTime(alert.timestamp)}</span>
                  </div>
                  <span className="text-[11px] font-mono font-bold text-white uppercase px-2 py-0.5 rounded bg-black/40 border border-white/10">
                    {alert.cameraName}
                  </span>
                  {alert.category === 'person' && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-accent-teal bg-accent-teal/10 px-2 py-0.5 rounded border border-accent-teal/30">
                      <User className="w-3 h-3" /> Person
                    </span>
                  )}
                  {alert.category === 'vehicle' && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-accent-yellow bg-accent-yellow/10 px-2 py-0.5 rounded border border-accent-yellow/30">
                      <Car className="w-3 h-3" /> Vehicle
                    </span>
                  )}
                  {alert.category === 'unknown' && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-text-muted bg-white/[0.04] px-2 py-0.5 rounded border border-white/10">
                      <HelpCircle className="w-3 h-3" /> Unknown
                    </span>
                  )}
                  <span className="text-[11px] font-mono text-accent-teal/80">#TRK-{alert.trackId}</span>
                  {alert.whatHeIsDoing && (
                    <span className="text-[11px] text-text-dim truncate max-w-xs hidden lg:inline">{alert.whatHeIsDoing}</span>
                  )}
                </div>

                <div className="flex items-center justify-between md:justify-end gap-2 shrink-0">
                  <span className="text-[11px] font-mono text-text-muted">
                    Score: <span className={`font-bold ${alert.tier === 'red' ? 'text-accent-red' : 'text-accent-yellow'}`}>{alert.score.toFixed(1)}</span>
                  </span>
                  {(alert.status ?? 'open') === 'open' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAcknowledge(alert.id);
                      }}
                      className="px-2 py-1 rounded bg-white/[0.04] hover:bg-white/[0.08] text-text-dim hover:text-white border border-white/10 transition-colors font-mono text-[10px] font-semibold"
                    >
                      Acknowledge
                    </button>
                  )}
                  {alert.status !== 'resolved' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleResolve(alert.id);
                      }}
                      className="px-2 py-1 rounded bg-accent-green/15 hover:bg-accent-green/25 text-accent-green border border-accent-green/30 transition-colors font-mono text-[10px] font-semibold"
                    >
                      Resolve
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/alerts?incident=${alert.id}`);
                    }}
                    className="px-2.5 py-1 rounded bg-white/[0.04] hover:bg-white/[0.08] text-text-dim hover:text-white border border-white/10 transition-colors font-mono text-[10px] font-semibold flex items-center gap-1"
                  >
                    <Eye className="w-3 h-3" />
                    <span>Evidence</span>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
};
