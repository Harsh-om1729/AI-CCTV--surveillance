import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Incident } from '@/lib/mockIncidents';
import { incidentsApi } from '@/lib/api';
import { useBackendData } from '@/lib/useBackendData';
import { threatStatusLabel } from '@/lib/threatStatus';
import { useSystemHealth } from '@/components/system/SystemHealthProvider';
import { DataSourceBadge } from '@/components/ui/DataSourceBadge';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  ScanEye,
  GitBranch,
  Footprints,
  Gauge,
  ArrowRight,
  User,
  Car,
  Eye,
} from 'lucide-react';

const TIER_BADGE: Record<string, 'red' | 'yellow' | 'green'> = { red: 'red', yellow: 'yellow', green: 'green' };

export const AiAnalysisPage: React.FC = () => {
  const navigate = useNavigate();
  const { health, cameras, reachable } = useSystemHealth();
  const { data: incidents } = useBackendData<Incident[]>(() => incidentsApi.getIncidents(), []);

  // Real, currently-observed counts — not invented. Falls back to 0 rather
  // than hiding the card when the pipeline has not reported anything yet.
  const totals = useMemo(() => {
    const cams = Object.values(health?.pipeline.cameras ?? {});
    return {
      persons: cams.reduce((n, c) => n + (c.persons ?? 0), 0),
      vehicles: cams.reduce((n, c) => n + (c.vehicles ?? 0), 0),
      detections: cams.reduce((n, c) => n + (c.detections ?? 0), 0),
      camerasWithZones: Object.values(health?.zones ?? {}).filter((n) => n > 0).length,
      totalZoned: Object.keys(health?.zones ?? {}).length,
      watchlistEnrolled: health?.watchlist.enrolled ?? null,
    };
  }, [health]);

  const latestExplained = useMemo(
    () => incidents.filter((i) => i.breakdown.recorded !== false).sort((a, b) => b.timestamp - a.timestamp)[0],
    [incidents]
  );

  const pipelineRunning = Boolean(health?.pipeline.running);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-text-primary flex items-center gap-2">
            <ScanEye className="w-5 h-5 text-accent-teal" />
            AI Detection &amp; Analysis
          </h2>
          <p className="text-xs text-text-dim mt-0.5">
            How the pipeline turns a video frame into a threat decision — with live numbers from what it is
            seeing right now.
          </p>
        </div>
        <DataSourceBadge isMock={!reachable} error={reachable === false ? 'Backend unreachable' : null} />
      </div>

      {!pipelineRunning && (
        <div role="status" className="p-3 rounded-xl border border-accent-yellow/40 bg-accent-yellow/10 text-xs font-mono text-accent-yellow">
          The AI pipeline is not running, so the counts below are at zero. Start it with ./run.sh, or open{' '}
          <button className="underline" onClick={() => navigate('/demo')}>
            Demo Mode
          </button>{' '}
          for a guided walkthrough that does not need a camera.
        </div>
      )}

      {/* The 4-stage explainer, each paired with a real live number. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card
          title={
            <div className="flex items-center gap-2">
              <ScanEye className="w-4 h-4 text-accent-teal" />
              <span>1. Detection — YOLOv8</span>
            </div>
          }
          subtitle="Every frame is scanned for people, vehicles and animals using a YOLOv8 model (ONNX Runtime), filtered to the classes relevant to border surveillance."
        >
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-2xl font-bold text-text-primary">{totals.detections}</div>
              <div className="text-[10px] text-text-dim uppercase">Live targets</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-accent-teal flex items-center justify-center gap-1">
                <User className="w-4 h-4" /> {totals.persons}
              </div>
              <div className="text-[10px] text-text-dim uppercase">Persons</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-accent-yellow flex items-center justify-center gap-1">
                <Car className="w-4 h-4" /> {totals.vehicles}
              </div>
              <div className="text-[10px] text-text-dim uppercase">Vehicles</div>
            </div>
          </div>
        </Card>

        <Card
          title={
            <div className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-accent-teal" />
              <span>2. Tracking — ByteTrack + Re-ID</span>
            </div>
          }
          subtitle="ByteTrack links detections into a track across frames; an appearance-matching gallery (OSNet) re-identifies the same person after a brief disappearance, so identity survives occlusion."
        >
          <div className="text-xs text-text-dim space-y-1.5">
            <p>
              A raw track ID changes if someone leaves frame — that is a known limit of motion-only tracking.
              The Re-ID gallery assigns a stable <span className="text-text-primary font-semibold">person #</span> on
              top of that, matched by appearance, not position.
            </p>
            <p className="text-text-muted">
              Watchlist enrolled: <span className="text-text-primary font-semibold">{totals.watchlistEnrolled ?? '—'}</span>{' '}
              — a match escalates to RED regardless of zone.
            </p>
          </div>
        </Card>

        <Card
          title={
            <div className="flex items-center gap-2">
              <Footprints className="w-4 h-4 text-accent-teal" />
              <span>3. Behaviour Analysis</span>
            </div>
          }
          subtitle="Ground position is classified into a Red/Yellow/Green zone; direction (inward/outward), speed and dwell time (loitering) are all measured, not guessed."
        >
          <ul className="text-xs text-text-dim space-y-1 list-disc list-inside">
            <li>Zone tier from a drawn polygon or a fixed camera-tier fallback</li>
            <li>Direction: inward (infiltration) vs outward (exfiltration) vs parallel</li>
            <li>Speed: a U-curve — both standing still and running score higher than an ordinary walk</li>
            <li>Loitering: sustained dwell time inside a zone</li>
            <li>
              Zoned cameras: <span className="text-text-primary font-semibold">{totals.camerasWithZones}/{totals.totalZoned || cameras.length}</span>
            </li>
          </ul>
        </Card>

        <Card
          title={
            <div className="flex items-center gap-2">
              <Gauge className="w-4 h-4 text-accent-teal" />
              <span>4. Threat Scoring</span>
            </div>
          }
          subtitle="A transparent 0–100 score: sector + time + movement + class-confidence + direction + loiter + group. 0–30 Green, 31–69 Yellow, 70–100 Red."
        >
          <div className="flex items-center gap-2 text-xs">
            <Badge variant="green" size="sm">0–30 Green</Badge>
            <Badge variant="yellow" size="sm">31–69 Yellow</Badge>
            <Badge variant="red" size="sm">70–100 Red</Badge>
          </div>
          <p className="text-[11px] text-text-muted mt-2">
            A watchlist match or a confirmed border crossing can override straight to Red — always logged with
            its reason, never a silent decision.
          </p>
        </Card>
      </div>

      {/* Real "why did this alert fire" example, pulled from the latest
          scored incident rather than invented. */}
      <Card
        title="Why This Alert Fired — Most Recent Example"
        subtitle={latestExplained ? undefined : 'No scored incident recorded yet — this fills in as soon as one is.'}
        action={
          latestExplained && (
            <Button variant="secondary" size="sm" rightIcon={<ArrowRight className="w-3.5 h-3.5" />} onClick={() => navigate('/alerts')}>
              All Alerts
            </Button>
          )
        }
      >
        {!latestExplained ? (
          <div className="text-center py-6 text-xs text-text-dim">
            Run <button className="underline" onClick={() => navigate('/demo')}>Demo Mode</button> to generate one
            end-to-end, or wait for a live detection.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={TIER_BADGE[latestExplained.tier] ?? 'neutral'} dot pulse size="sm">
                {threatStatusLabel(latestExplained.tier)} · {latestExplained.score.toFixed(0)}/100
              </Badge>
              <span className="text-xs font-mono text-text-primary uppercase">{latestExplained.cameraName}</span>
              <span className="text-xs text-text-dim">Track #{latestExplained.trackId}</span>
              <button
                onClick={() => navigate(`/alerts?incident=${latestExplained.id}`)}
                className="ml-auto text-[11px] text-accent-teal hover:underline flex items-center gap-1"
              >
                <Eye className="w-3 h-3" /> View evidence
              </button>
            </div>
            {latestExplained.whatHeIsDoing && (
              <p className="text-sm text-text-primary bg-bg-elevated border border-ink/10 rounded-lg p-2.5">
                {latestExplained.whatHeIsDoing}
              </p>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                ['Sector / zone', latestExplained.breakdown.sectorRisk],
                ['Time / curfew', latestExplained.breakdown.timeRisk],
                ['Movement', latestExplained.breakdown.kinematicsRisk],
                ['Class confidence', latestExplained.breakdown.classConfidence],
                ['Direction', latestExplained.breakdown.directionRisk],
                ['Loitering', latestExplained.breakdown.loiterRisk],
                ['Group', latestExplained.breakdown.groupRisk],
              ]
                .filter(([, v]) => (v as number | null) != null)
                .map(([label, value]) => (
                  <div key={label as string} className="p-2 rounded-lg bg-ink/[0.03] border border-ink/5 text-xs">
                    <span className="text-text-dim block">{label as string}</span>
                    <span className="text-text-primary font-semibold">{Number(value).toFixed(1)}</span>
                  </div>
                ))}
            </div>
            {latestExplained.breakdown.overrideReason && (
              <p className="text-xs text-accent-red">Override: {latestExplained.breakdown.overrideReason}</p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
};
