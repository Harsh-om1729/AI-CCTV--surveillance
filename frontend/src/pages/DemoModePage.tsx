import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { demoApi, DemoStatus } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Camera,
  ScanEye,
  GitBranch,
  Footprints,
  ShieldAlert,
  Database,
  Play,
  SkipForward,
  RotateCcw,
  ArrowRight,
  CheckCircle2,
} from 'lucide-react';

// Maps the backend's 15 deterministic steps (demo/demo_engine.py) onto the
// 6 stages a viewer actually needs to follow: Camera Input -> Detection ->
// Tracking -> Behaviour Analysis -> Alert -> Evidence/Event Log. The mapping
// mirrors exactly what demo_engine.py does at each step number — nothing
// here is invented, it just groups real backend steps for display.
const STAGES = [
  { key: 'input', label: 'Camera Input', icon: Camera, steps: [1] },
  { key: 'detect', label: 'AI Detection', icon: ScanEye, steps: [1] },
  { key: 'track', label: 'Tracking', icon: GitBranch, steps: [2] },
  { key: 'behave', label: 'Behaviour Analysis', icon: Footprints, steps: [3, 4, 5, 6, 7, 8, 9] },
  { key: 'alert', label: 'Alert', icon: ShieldAlert, steps: [10, 11] },
  { key: 'evidence', label: 'Evidence / Event Log', icon: Database, steps: [12, 13, 14, 15] },
] as const;

function stageStatus(stepKeys: readonly number[], currentStep: number): 'done' | 'active' | 'pending' {
  const max = Math.max(...stepKeys);
  const min = Math.min(...stepKeys);
  if (currentStep >= max) return 'done';
  if (currentStep >= min) return 'active';
  return 'pending';
}

export const DemoModePage: React.FC = () => {
  const navigate = useNavigate();
  const [status, setStatus] = useState<DemoStatus>({ step: 0, totalSteps: 15, isRunning: false, logs: [] });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    demoApi.getStatus().then((res) => {
      if (res.data) setStatus(res.data);
    });
  }, []);

  const run = async (fn: () => Promise<{ data: DemoStatus | null }>) => {
    setBusy(true);
    try {
      const res = await fn();
      if (res.data) setStatus(res.data);
    } finally {
      setBusy(false);
    }
  };

  const latestLog = status.logs[status.logs.length - 1];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-white flex items-center gap-2">
          <Play className="w-5 h-5 text-accent-teal" />
          Demo Mode
        </h2>
        <p className="text-xs text-text-dim mt-0.5">
          A guided, deterministic walkthrough for judges — a simulated person walks Green → Yellow → Red while
          every other stage (tracking, zone classification, scoring, alerting, encryption, database) runs
          through the real production code, not a mock. No camera required.
        </p>
      </div>

      {/* 6-stage pipeline visualization */}
      <Card>
        <div className="flex items-center overflow-x-auto pb-1">
          {STAGES.map((stage, i) => {
            const st = stageStatus(stage.steps, status.step);
            const Icon = stage.icon;
            return (
              <React.Fragment key={stage.key}>
                <div className="flex flex-col items-center gap-1.5 shrink-0 px-1 min-w-[92px]">
                  <div
                    className={`w-11 h-11 rounded-full border-2 flex items-center justify-center transition-colors ${
                      st === 'done'
                        ? 'bg-accent-green/15 border-accent-green text-accent-green'
                        : st === 'active'
                        ? 'bg-accent-teal/15 border-accent-teal text-accent-teal animate-pulse'
                        : 'bg-white/5 border-white/15 text-text-muted'
                    }`}
                  >
                    {st === 'done' ? <CheckCircle2 className="w-5 h-5" /> : <Icon className="w-5 h-5" />}
                  </div>
                  <span
                    className={`text-[10px] font-semibold text-center leading-tight ${
                      st === 'pending' ? 'text-text-muted' : 'text-white'
                    }`}
                  >
                    {stage.label}
                  </span>
                </div>
                {i < STAGES.length - 1 && (
                  <div className={`h-0.5 flex-1 min-w-[16px] ${st === 'done' ? 'bg-accent-green/50' : 'bg-white/10'}`} />
                )}
              </React.Fragment>
            );
          })}
        </div>
      </Card>

      {/* Controls */}
      <Card
        title={
          <div className="flex items-center gap-2">
            <span>15-Step Deterministic Walkthrough</span>
            <Badge variant="teal" size="sm">Step {status.step} / {status.totalSteps}</Badge>
          </div>
        }
        subtitle="Run it all at once, or step through it one action at a time while narrating."
      >
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Play className="w-4 h-4" />}
            disabled={busy}
            onClick={() => run(demoApi.runFullDemo)}
          >
            {busy ? 'Running…' : 'Run Full Demo'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<SkipForward className="w-3.5 h-3.5" />}
            disabled={busy || status.step >= status.totalSteps}
            onClick={() => run(demoApi.stepDemo)}
          >
            Next Step
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<RotateCcw className="w-3.5 h-3.5" />}
            disabled={busy}
            onClick={() => run(demoApi.resetDemo)}
          >
            Reset
          </Button>
        </div>

        <div className="w-full bg-[#121624] h-2 rounded-full overflow-hidden border border-white/5 mb-3">
          <div
            className="bg-gradient-to-r from-accent-green via-accent-yellow to-accent-red h-full transition-all duration-300"
            style={{ width: `${(status.step / status.totalSteps) * 100}%` }}
          />
        </div>

        {latestLog && (
          <div className="p-3 rounded-xl bg-black/40 border border-white/10 space-y-1">
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-accent-teal font-bold">STEP {latestLog.step}:</span>
              <span className="text-white">{latestLog.message}</span>
            </div>
            {status.latestScore != null && (
              <div className="flex items-center gap-2 text-xs font-mono">
                <span className="text-text-dim">Threat score:</span>
                <span className="text-accent-red font-bold">
                  {status.latestScore.toFixed(0)}/100 [{status.latestLevel}]
                </span>
              </div>
            )}
          </div>
        )}

        {/* Full step log — what happened, in the real backend's own words. */}
        {status.logs.length > 0 && (
          <div className="mt-3 space-y-1 max-h-56 overflow-y-auto pr-1">
            {[...status.logs].reverse().map((log, i) => (
              <div key={`${log.step}-${i}`} className="flex items-start gap-2 text-[11px] font-mono text-text-dim border-l-2 border-white/10 pl-2 py-0.5">
                <span className="text-text-muted shrink-0">{log.time}</span>
                <span className="text-accent-teal shrink-0">#{log.step}</span>
                <span>{log.message}</span>
              </div>
            ))}
          </div>
        )}

        {status.currentIncidentId != null && (
          <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between">
            <span className="text-xs text-text-dim">
              Incident #{status.currentIncidentId} was written to the real database with encrypted evidence.
            </span>
            <Button
              variant="secondary"
              size="sm"
              rightIcon={<ArrowRight className="w-3.5 h-3.5" />}
              onClick={() => navigate(`/alerts?incident=${status.currentIncidentId}`)}
            >
              Open in Alerts &amp; Events
            </Button>
          </div>
        )}
      </Card>

      <Card title="What this proves" subtitle="Read this to judges while stepping through, or let it run full-speed first.">
        <ol className="text-xs text-text-dim space-y-1.5 list-decimal list-inside">
          <li>A person is detected and assigned track #17 (real detection + tracking data structures).</li>
          <li>They walk from GREEN territory through the YELLOW approach strip into the RED restricted zone — classified by the real geometric zone engine, not hardcoded.</li>
          <li>Their inward direction and speed are measured and fed into the real threat-scoring formula.</li>
          <li>The score crosses into RED, and the real alert manager fires — with cooldown/backoff logic exactly as it runs live.</li>
          <li>Evidence frames are encrypted (Fernet) and the incident is persisted to the same incidents.db a live camera would use.</li>
        </ol>
      </Card>
    </div>
  );
};
