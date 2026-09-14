import React, { useRef, useState } from 'react';
import { videosApi, ApiVideo } from '@/lib/api';
import { useBackendData } from '@/lib/useBackendData';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { FileVideo, Upload, Play, Square, Trash2, Terminal, Copy, Check } from 'lucide-react';

const RESTART_COMMAND = './run.sh all';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Uploaded clips are analysed by the SAME full pipeline live cameras get,
// not a preview: a camera added purely on the dashboard (config/cameras.json)
// never gets real detection/tracking/scoring, because the running pipeline
// only reads CAMERA_SOURCES from .env at startup (config/settings.py). So
// "Activate" here writes the clip into .env's CAMERA_SOURCES and this panel
// tells the operator to restart — there's no way around that without a
// pipeline hot-reload, which is out of scope for this feature.
export const OfflineVideoPanel: React.FC = () => {
  const { data: videos, isMock, loading, reload } = useBackendData<ApiVideo[]>(
    () => videosApi.getVideos(),
    []
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const needsRestart = videos.some((v) => v.needsRestart);

  const handlePickFile = () => fileInputRef.current?.click();

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setUploadPct(0);
    setUploadError(null);
    const res = await videosApi.uploadVideo(file, setUploadPct);
    setUploading(false);
    if (res.error) {
      setUploadError(res.error);
    } else {
      await reload();
    }
  };

  const handleActivate = async (video: ApiVideo) => {
    setBusyId(video.id);
    await videosApi.activateVideo(video.id);
    await reload();
    setBusyId(null);
  };

  const handleDeactivate = async (video: ApiVideo) => {
    setBusyId(video.id);
    await videosApi.deactivateVideo(video.id);
    await reload();
    setBusyId(null);
  };

  const handleDelete = async (video: ApiVideo) => {
    if (!window.confirm(`Delete "${video.filename}"? This cannot be undone.`)) return;
    setBusyId(video.id);
    await videosApi.deleteVideo(video.id);
    await reload();
    setBusyId(null);
  };

  const handleCopyCommand = async () => {
    try {
      await navigator.clipboard.writeText(RESTART_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable — the command is still shown on screen.
    }
  };

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <FileVideo className="w-4 h-4 text-accent-teal" />
          <span>Offline Video Analysis</span>
        </div>
      }
      subtitle="Upload a recorded clip for the same detection, tracking and zone analysis live cameras get"
      action={
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Upload className="w-3.5 h-3.5" />}
          onClick={handlePickFile}
          isLoading={uploading}
        >
          Upload Video
        </Button>
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="video/mp4,video/x-msvideo,video/quicktime,video/x-matroska,video/webm,.mp4,.avi,.mov,.mkv,.webm"
        className="hidden"
        onChange={handleFileChosen}
      />

      {uploading && (
        <div className="mb-4 p-3 rounded-xl border border-accent-teal/30 bg-accent-teal/10">
          <div className="flex items-center justify-between text-xs font-mono text-accent-teal mb-1.5">
            <span>Uploading…</span>
            <span>{uploadPct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-ink/10 overflow-hidden">
            <div className="h-full rounded-full bg-accent-teal transition-all" style={{ width: `${uploadPct}%` }} />
          </div>
        </div>
      )}

      {uploadError && (
        <div className="mb-4 p-3 rounded-xl border border-accent-red/40 bg-accent-red/10 text-xs font-mono text-accent-red">
          Upload failed: {uploadError}
        </div>
      )}

      {needsRestart && (
        <div className="mb-4 p-3 rounded-xl border border-accent-yellow/40 bg-accent-yellow/10">
          <div className="flex items-center gap-2 text-xs font-mono font-semibold text-accent-yellow mb-1.5">
            <Terminal className="w-3.5 h-3.5" />
            Restart the pipeline to start analysing the activated video
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-bg-primary/60 border border-ink/10 rounded-lg px-2.5 py-1.5 text-text-primary">
              {RESTART_COMMAND}
            </code>
            <Button variant="ghost" size="sm" onClick={handleCopyCommand} leftIcon={copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      )}

      {isMock && !loading && (
        <div className="mb-4 text-xs font-mono text-text-dim">Backend unreachable — video list unavailable.</div>
      )}

      {videos.length === 0 ? (
        <div className="p-6 text-center text-xs text-text-dim font-mono border border-dashed border-ink/10 rounded-xl">
          No videos uploaded yet. Upload a clip and activate it to have the AI pipeline analyse it just like a live camera.
        </div>
      ) : (
        <div className="space-y-2">
          {videos.map((video) => (
            <div
              key={video.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-xl bg-bg-surface border border-ink/[0.06]"
            >
              <div className="min-w-0 flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-bg-elevated border border-ink/10 flex items-center justify-center text-accent-teal shrink-0">
                  <FileVideo className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-text-primary truncate" title={video.filename}>
                    {video.filename}
                  </div>
                  <div className="text-[10px] text-text-dim font-mono">
                    {formatBytes(video.sizeBytes)} · camera id {video.cameraId}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <Badge variant={video.isActive ? 'green' : 'neutral'} size="sm">
                  {video.isActive ? 'Active' : 'Inactive'}
                </Badge>
                {video.isActive ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<Square className="w-3.5 h-3.5" />}
                    onClick={() => handleDeactivate(video)}
                    isLoading={busyId === video.id}
                  >
                    Deactivate
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<Play className="w-3.5 h-3.5" />}
                    onClick={() => handleActivate(video)}
                    isLoading={busyId === video.id}
                  >
                    Activate
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-accent-red hover:bg-accent-red/10"
                  onClick={() => handleDelete(video)}
                  isLoading={busyId === video.id}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};
