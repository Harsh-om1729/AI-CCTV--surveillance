import React, { useState } from 'react';
import { camerasApi, ApiCamera } from '@/lib/api/endpoints';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { maskRtspUrl } from './maskRtspUrl';
import { AlertCircle, CheckCircle2, Loader2, PlugZap } from 'lucide-react';

export interface AddCameraModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdded: (camera: ApiCamera) => void;
  existingIds: string[];
}

type SourceType = 'simulated' | 'webcam' | 'rtsp';

/** The one place a camera gets added, used from both Live Surveillance
 * (quick add) and Camera Management (full add) so the RTSP-handling logic —
 * normalization, test-before-save, credential masking — exists once. */
export const AddCameraModal: React.FC<AddCameraModalProps> = ({
  isOpen,
  onClose,
  onAdded,
  existingIds,
}) => {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [sector, setSector] = useState('Border Sector');
  const [sourceType, setSourceType] = useState<SourceType>('rtsp');
  const [deviceIndex, setDeviceIndex] = useState('0');
  const [rtspUrl, setRtspUrl] = useState('');
  const [zoneTier, setZoneTier] = useState<'red' | 'yellow' | 'green'>('yellow');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testDetail, setTestDetail] = useState('');

  const reset = () => {
    setId('');
    setName('');
    setLocation('');
    setSector('Border Sector');
    setSourceType('rtsp');
    setDeviceIndex('0');
    setRtspUrl('');
    setZoneTier('yellow');
    setFormError('');
    setTestState('idle');
    setTestDetail('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const resolvedSource = (): string | number =>
    sourceType === 'simulated' ? 'simulated' : sourceType === 'webcam' ? Number(deviceIndex) || 0 : rtspUrl.trim();

  const handleTestConnection = async () => {
    if (sourceType === 'rtsp' && !rtspUrl.trim()) {
      setFormError('Enter an RTSP/HTTP URL before testing the connection.');
      return;
    }
    setFormError('');
    setTestState('testing');
    setTestDetail('');
    const res = await camerasApi.testCamera(resolvedSource());
    if (res.isFallback || !res.data) {
      setTestState('fail');
      setTestDetail(res.error ?? 'Could not reach the backend to run the test.');
      return;
    }
    setTestState(res.data.ok ? 'ok' : 'fail');
    setTestDetail(res.data.detail);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = id.trim().toLowerCase().replace(/\s+/g, '_');
    if (cleanId && existingIds.includes(cleanId)) {
      setFormError(`Camera ID "${cleanId}" already exists — use a unique ID.`);
      return;
    }
    if (sourceType === 'rtsp' && !rtspUrl.trim()) {
      setFormError('Enter an RTSP/HTTP URL, or switch to Webcam / Simulated.');
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      const res = await camerasApi.addCamera({
        id: cleanId || undefined,
        name: name.trim() || undefined,
        location: location.trim() || 'Border Perimeter',
        sector,
        source: resolvedSource(),
        zoneTier,
      } as Partial<ApiCamera>);
      if (res.isFallback || !res.data) {
        setFormError(`Could not add the camera — ${res.error ?? 'backend unreachable'}`);
        return;
      }
      onAdded(res.data);
      handleClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Add Surveillance Camera"
      description="Webcam, RTSP/IP camera, or a simulated feed for demos when no real camera is available."
      size="lg"
      footer={
        <div className="flex items-center justify-between w-full gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleTestConnection}
            disabled={testState === 'testing' || sourceType === 'simulated'}
            leftIcon={testState === 'testing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
          >
            {sourceType === 'simulated' ? 'No test needed' : 'Test Connection'}
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" form="add-camera-form" variant="primary" size="sm" disabled={submitting}>
              {submitting ? 'Adding…' : 'Add Camera'}
            </Button>
          </div>
        </div>
      }
    >
      <form id="add-camera-form" onSubmit={handleSubmit} className="space-y-4">
        {formError && (
          <div className="p-2.5 bg-accent-red/15 border border-accent-red/40 rounded-lg flex items-center gap-2 text-xs text-accent-red">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{formError}</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-mono uppercase text-text-dim mb-1">Camera ID</label>
            <input
              type="text"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="auto-generated if blank"
              className="w-full px-3 py-2 bg-bg-elevated border border-border-subtle rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent-teal font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-mono uppercase text-text-dim mb-1">Display Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. North Gate Camera"
              className="w-full px-3 py-2 bg-bg-elevated border border-border-subtle rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent-teal"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-mono uppercase text-text-dim mb-1">Location / Post</label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Outpost Delta, Gate 3"
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
          <label className="block text-xs font-mono uppercase text-text-dim mb-1.5">Video Source</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
            {(
              [
                ['rtsp', 'RTSP / IP Camera'],
                ['webcam', 'USB / Built-in Webcam'],
                ['simulated', 'Simulated (for demos)'],
              ] as [SourceType, string][]
            ).map(([val, label]) => (
              <button
                type="button"
                key={val}
                onClick={() => {
                  setSourceType(val);
                  setTestState('idle');
                }}
                className={`px-3 py-2 rounded-lg border text-xs font-semibold transition-colors ${
                  sourceType === val
                    ? 'bg-accent-teal/15 border-accent-teal text-accent-teal'
                    : 'bg-bg-elevated border-border-subtle text-text-dim hover:text-text-primary hover:border-ink/25'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {sourceType === 'rtsp' && (
            <input
              type="text"
              value={rtspUrl}
              onChange={(e) => {
                setRtspUrl(e.target.value);
                setTestState('idle');
              }}
              placeholder="rtsp://user:pass@192.168.1.10:554/stream1"
              className="w-full px-3 py-2 bg-bg-elevated border border-border-subtle rounded-lg text-sm text-text-primary font-mono focus:outline-none focus:border-accent-teal"
            />
          )}
          {sourceType === 'rtsp' && rtspUrl.includes('@') && (
            <p className="text-[10px] text-text-muted mt-1 font-mono">
              Saved as entered; shown elsewhere as {maskRtspUrl(rtspUrl)}
            </p>
          )}
          {sourceType === 'webcam' && (
            <select
              value={deviceIndex}
              onChange={(e) => {
                setDeviceIndex(e.target.value);
                setTestState('idle');
              }}
              className="w-full px-3 py-2 bg-bg-elevated border border-border-subtle rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent-teal font-mono"
            >
              <option value="0">Device 0 (default)</option>
              <option value="1">Device 1</option>
              <option value="2">Device 2</option>
            </select>
          )}
          {sourceType === 'simulated' && (
            <p className="text-xs text-text-dim">
              Always works reliably — use this for a judge demo when no real camera is on hand. It will not
              raise real alerts; use Demo Mode for a guided walkthrough instead.
            </p>
          )}

          {testState !== 'idle' && sourceType !== 'simulated' && (
            <div
              className={`mt-2 flex items-start gap-2 p-2.5 rounded-lg border text-xs ${
                testState === 'testing'
                  ? 'bg-ink/5 border-ink/10 text-text-dim'
                  : testState === 'ok'
                  ? 'bg-accent-green/10 border-accent-green/30 text-accent-green'
                  : 'bg-accent-red/10 border-accent-red/30 text-accent-red'
              }`}
            >
              {testState === 'testing' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 mt-0.5" />
              ) : testState === 'ok' ? (
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              )}
              <span>{testState === 'testing' ? 'Connecting…' : testDetail}</span>
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs font-mono uppercase text-text-dim mb-1.5">Zone Priority</label>
          <div className="grid grid-cols-3 gap-2">
            {(['red', 'yellow', 'green'] as const).map((tier) => (
              <button
                type="button"
                key={tier}
                onClick={() => setZoneTier(tier)}
                className={`py-2 rounded-lg font-bold text-xs border transition-colors ${
                  zoneTier === tier
                    ? tier === 'red'
                      ? 'bg-accent-red text-white border-accent-red'
                      : tier === 'yellow'
                      ? 'bg-accent-yellow text-black border-accent-yellow'
                      : 'bg-accent-green text-black border-accent-green'
                    : 'bg-bg-elevated border-border-subtle text-text-dim'
                }`}
              >
                {tier.toUpperCase()}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-text-muted mt-1">
            RED = restricted border line, YELLOW = approach strip, GREEN = own territory. Only matters if this
            camera has no drawn zones — see the Zones page.
          </p>
        </div>
      </form>
    </Modal>
  );
};
