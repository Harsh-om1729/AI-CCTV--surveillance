import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiCamera, camerasApi } from '@/lib/api/endpoints';
import { useSystemHealth } from '@/components/system/SystemHealthProvider';
import { AddCameraModal, maskRtspUrl } from '@/components/cameras';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import {
  Plus,
  Video,
  Trash2,
  Square,
  PlugZap,
  Pencil,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Eye,
  Lock,
} from 'lucide-react';

const TIER_STYLES: Record<string, string> = {
  red: 'bg-accent-red text-white border-accent-red',
  yellow: 'bg-accent-yellow text-black border-accent-yellow',
  green: 'bg-accent-green text-black border-accent-green',
};

/** Edit an existing camera's label/location/tier, and optionally its source
 * (with Test Connection before saving) — separate from AddCameraModal
 * because the id is fixed and a .env camera cannot change its source here. */
const EditCameraModal: React.FC<{
  camera: ApiCamera | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ camera, onClose, onSaved }) => {
  const [name, setName] = useState(camera?.name ?? '');
  const [location, setLocation] = useState(camera?.location ?? '');
  const [sector, setSector] = useState(camera?.sector ?? '');
  const [zoneTier, setZoneTier] = useState<'red' | 'yellow' | 'green'>(camera?.zoneTier ?? 'yellow');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Re-initialize whenever a different camera is opened for editing.
  React.useEffect(() => {
    setName(camera?.name ?? '');
    setLocation(camera?.location ?? '');
    setSector(camera?.sector ?? '');
    setZoneTier(camera?.zoneTier ?? 'yellow');
    setError('');
  }, [camera]);

  if (!camera) return null;

  const handleSave = async () => {
    setSaving(true);
    setError('');
    const res = await camerasApi.updateCamera(camera.id, {
      name: name.trim() || camera.id.toUpperCase(),
      location: location.trim(),
      sector: sector.trim(),
      zoneTier,
    });
    setSaving(false);
    if (res.isFallback) {
      setError(`Could not save — ${res.error ?? 'backend unreachable'}`);
      return;
    }
    onSaved();
  };

  return (
    <Modal
      isOpen={Boolean(camera)}
      onClose={onClose}
      title={`Edit ${camera.id.toUpperCase()}`}
      description="Label, location and zone priority. The video source is fixed here — remove and re-add the camera to change it."
      size="md"
      footer={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="p-2.5 bg-accent-red/15 border border-accent-red/40 rounded-lg flex items-center gap-2 text-xs text-accent-red">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <div>
          <label className="block text-xs font-mono uppercase text-text-dim mb-1">Display Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 bg-bg-elevated border border-border-subtle rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent-teal"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-mono uppercase text-text-dim mb-1">Location</label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="w-full px-3 py-2 bg-bg-elevated border border-border-subtle rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent-teal"
            />
          </div>
          <div>
            <label className="block text-xs font-mono uppercase text-text-dim mb-1">Sector</label>
            <input
              type="text"
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="w-full px-3 py-2 bg-bg-elevated border border-border-subtle rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent-teal"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-mono uppercase text-text-dim mb-1.5">Zone Priority</label>
          <div className="grid grid-cols-3 gap-2">
            {(['red', 'yellow', 'green'] as const).map((tier) => (
              <button
                key={tier}
                type="button"
                onClick={() => setZoneTier(tier)}
                className={`py-2 rounded-lg font-bold text-xs border transition-colors ${
                  zoneTier === tier ? TIER_STYLES[tier] : 'bg-bg-elevated border-border-subtle text-text-dim'
                }`}
              >
                {tier.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
};

export const CameraManagementPage: React.FC = () => {
  const navigate = useNavigate();
  const { cameras, reachable, refresh } = useSystemHealth();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editing, setEditing] = useState<ApiCamera | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const handleTest = async (cam: ApiCamera) => {
    setBusyId(cam.id);
    const res = await camerasApi.testCamera(cam.source ?? cam.id);
    setBusyId(null);
    if (res.isFallback || !res.data) {
      setTestResults((prev) => ({ ...prev, [cam.id]: { ok: false, detail: res.error ?? 'Backend unreachable' } }));
      return;
    }
    setTestResults((prev) => ({ ...prev, [cam.id]: { ok: res.data!.ok, detail: res.data!.detail } }));
  };

  const handleStop = async (cam: ApiCamera) => {
    setBusyId(cam.id);
    const res = await camerasApi.stopCamera(cam.id);
    setBusyId(null);
    if (res.isFallback) {
      showToast(`Could not stop ${cam.id.toUpperCase()}: ${res.error ?? 'backend unreachable'}`);
      return;
    }
    await refresh();
    showToast(`Stopped ${cam.id.toUpperCase()}`);
  };

  const handleDelete = async (cam: ApiCamera) => {
    if (!window.confirm(`Remove camera ${cam.id.toUpperCase()}? This cannot be undone.`)) return;
    setBusyId(cam.id);
    const res = await camerasApi.deleteCamera(cam.id);
    setBusyId(null);
    if (res.isFallback) {
      showToast(
        res.status === 409
          ? `${cam.id.toUpperCase()} is defined in .env (CAMERA_SOURCES) and can't be deleted here — edit .env and restart instead.`
          : `Could not remove ${cam.id.toUpperCase()}: ${res.error ?? 'backend unreachable'}`
      );
      return;
    }
    await refresh();
    showToast(`Removed ${cam.id.toUpperCase()}`);
  };

  const isRtsp = (source: unknown) => typeof source === 'string' && /^rtsp:\/\//i.test(source);

  return (
    <div className="space-y-5">
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 bg-bg-surface border border-accent-teal/50 rounded-xl shadow-xl font-mono text-xs text-text-primary">
          <CheckCircle2 className="w-4 h-4 text-accent-teal" />
          <span>{toast}</span>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Video className="w-5 h-5 text-accent-teal" />
            Camera Management
          </h2>
          <p className="text-xs text-text-dim mt-0.5">
            Add, edit, test and remove cameras. RTSP credentials are never shown back once saved.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" leftIcon={<Eye className="w-3.5 h-3.5" />} onClick={() => navigate('/live')}>
            View Live Feeds
          </Button>
          <Button variant="primary" size="sm" leftIcon={<Plus className="w-4 h-4" />} onClick={() => setIsAddOpen(true)}>
            Add Camera
          </Button>
        </div>
      </div>

      {reachable === false && (
        <div role="alert" className="p-3 rounded-xl border border-accent-red/40 bg-accent-red/10 text-xs font-mono text-accent-red">
          Backend unreachable — camera list may be stale. Start it with ./run.sh up.
        </div>
      )}

      {cameras.length === 0 ? (
        <Card className="p-10 text-center">
          <Video className="w-6 h-6 text-text-muted mx-auto mb-2" />
          <h3 className="text-sm font-semibold text-white">No cameras configured</h3>
          <p className="text-xs text-text-dim mt-1">
            Set CAMERA_SOURCES in .env, or add one here (webcam, RTSP, or simulated for a demo).
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {cameras.map((cam) => {
            const testResult = testResults[cam.id];
            const rtsp = isRtsp(cam.source);
            const busy = busyId === cam.id;
            return (
              <Card key={cam.id} className="p-4">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div
                      className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${
                        cam.health === 'online'
                          ? 'bg-accent-green/10 border-accent-green/30 text-accent-green'
                          : 'bg-white/5 border-white/10 text-text-muted'
                      }`}
                    >
                      <Video className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-white">{cam.name || cam.id.toUpperCase()}</span>
                        <Badge variant={cam.health === 'online' ? 'green' : 'neutral'} dot size="sm">
                          {cam.health || 'unknown'}
                        </Badge>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded border ${TIER_STYLES[cam.zoneTier || 'yellow']}`}
                        >
                          {(cam.zoneTier || 'yellow').toUpperCase()}
                        </span>
                      </div>
                      <p className="text-[11px] text-text-dim mt-0.5 truncate">
                        {cam.location} · {cam.sector}
                      </p>
                      <p className="text-[11px] font-mono text-text-muted mt-0.5 flex items-center gap-1 truncate">
                        {rtsp && <Lock className="w-3 h-3 shrink-0" title="Credentials hidden" />}
                        {rtsp ? maskRtspUrl(cam.source as string) : `source: ${cam.source ?? '—'}`}
                      </p>
                      {testResult && (
                        <p
                          className={`text-[11px] mt-1 flex items-center gap-1 ${
                            testResult.ok ? 'text-accent-green' : 'text-accent-red'
                          }`}
                        >
                          {testResult.ok ? (
                            <CheckCircle2 className="w-3 h-3 shrink-0" />
                          ) : (
                            <AlertCircle className="w-3 h-3 shrink-0" />
                          )}
                          {testResult.detail}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 self-end lg:self-center">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      leftIcon={busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
                      onClick={() => handleTest(cam)}
                    >
                      Test
                    </Button>
                    <Button variant="secondary" size="sm" leftIcon={<Pencil className="w-3.5 h-3.5" />} onClick={() => setEditing(cam)}>
                      Edit
                    </Button>
                    {cam.source !== 'idle' && (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => handleStop(cam)} title="Stop this camera">
                        <Square className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => handleDelete(cam)}
                      title="Remove this camera"
                      className="text-text-muted hover:text-accent-red"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <AddCameraModal
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onAdded={async () => {
          await refresh();
          showToast('Camera added');
        }}
        existingIds={cameras.map((c) => c.id)}
      />

      <EditCameraModal
        camera={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          await refresh();
          setEditing(null);
          showToast('Camera updated');
        }}
      />
    </div>
  );
};
