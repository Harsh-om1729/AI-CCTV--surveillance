import React, { useState, useEffect, useMemo } from 'react';
import type { Boundary, Zone, ZoneRole } from '@/lib/mockZones';
import { ZONE_ROLES } from '@/lib/mockZones';
import { useSystemHealth } from '@/components/system/SystemHealthProvider';
import { boundariesApi, cameraStreamUrl, zonePolicyApi, zonesApi } from '@/lib/api';
import { DataSourceBadge } from '@/components/ui/DataSourceBadge';
import { ZONE_PRESETS, ZonePreset } from '@/lib/zonePresets';
import { ZoneCanvas } from '@/components/zones';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Card } from '@/components/ui/Card';
import {
  Shield,
  ShieldAlert,
  Compass,
  Trash2,
  Pencil,
  Save,
  CheckCircle2,
  AlertTriangle,
  Layers,
  ArrowDownRight,
  ArrowUpRight,
  RotateCcw,
  Copy,
  Sparkles,
  ChevronDown,
  Milestone,
  Settings2,
  Power,
} from 'lucide-react';

const ZONES_STORAGE_KEY = 'ibvap_zones_data';

const loadStoredZones = (): Zone[] => {
  try {
    const saved = localStorage.getItem(ZONES_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (e) {
    console.error('Failed to load zones from storage', e);
  }
  return [];
};

export const ZonesPage: React.FC = () => {
  const [allZones, setAllZones] = useState<Zone[]>(loadStoredZones);
  const [isMock, setIsMock] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectedCamera, setSelectedCamera] = useState<string>('cam0');
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  // Automatically persist zones across routes and browser sessions
  useEffect(() => {
    try {
      localStorage.setItem(ZONES_STORAGE_KEY, JSON.stringify(allZones));
    } catch (e) {
      console.error('Failed to persist zones to storage', e);
    }
  }, [allZones]);

  // Pull the zones the backend actually has. config/zones_<cam>.json is what
  // ZoneEngine reads at pipeline startup, so it — not localStorage — is the
  // real store. localStorage stays only as the offline seed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await zonesApi.getZones({});
      if (cancelled) return;
      setIsMock(res.isFallback);
      if (res.isFallback || !res.data) return;
      const flat = Object.values(res.data).flat() as Zone[];
      setAllZones(flat);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Form Modal State (for Creating or Editing Zone Metadata)
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingZone, setEditingZone] = useState<Zone | null>(null);
  const [inProgressPoints, setInProgressPoints] = useState<{ x: number; y: number }[]>([]);

  // Form Fields
  const [formTier, setFormTier] = useState<'green' | 'yellow' | 'red'>('red');
  const [formRole, setFormRole] = useState<ZoneRole | null>('restricted');
  const [formLabel, setFormLabel] = useState('');
  const [formDirection, setFormDirection] = useState<'inward' | 'outward'>('inward');
  const [formEnabled, setFormEnabled] = useState(true);
  const [formError, setFormError] = useState('');

  // The configurable role -> severity mapping (zones/zone_policy.py). Picking
  // a role in the form resolves its tier from here, so scoring always agrees
  // with what the operator sees — ZoneEngine/ThreatScorer never see the role
  // name itself, only the tier this resolves to.
  const [zonePolicy, setZonePolicy] = useState<Record<string, string>>({
    restricted: 'red',
    buffer: 'yellow',
    transit: 'yellow',
    authorized: 'green',
  });
  const [isPolicyModalOpen, setIsPolicyModalOpen] = useState(false);
  const [policyDraft, setPolicyDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await zonePolicyApi.getPolicy();
      if (!cancelled && !res.isFallback && res.data) setZonePolicy(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectRole = (role: ZoneRole) => {
    setFormRole(role);
    const resolved = zonePolicy[role];
    if (resolved === 'red' || resolved === 'yellow' || resolved === 'green') {
      setFormTier(resolved);
    }
  };

  // --- Virtual boundaries (tripwires) — a separate entity from zones. See
  // zones/boundary_engine.py: detected independently of zone entry, shown to
  // the operator, not fed into scoring in this pass. ---
  const [allBoundaries, setAllBoundaries] = useState<Boundary[]>([]);
  const [isBoundaryDrawing, setIsBoundaryDrawing] = useState(false);
  const [selectedBoundaryId, setSelectedBoundaryId] = useState<string | null>(null);
  const [isBoundaryFormOpen, setIsBoundaryFormOpen] = useState(false);
  const [editingBoundary, setEditingBoundary] = useState<Boundary | null>(null);
  const [boundaryInProgressPoints, setBoundaryInProgressPoints] = useState<{ x: number; y: number }[]>([]);
  const [boundaryFormLabel, setBoundaryFormLabel] = useState('');
  const [boundaryFormEnabled, setBoundaryFormEnabled] = useState(true);
  const [boundarySaveError, setBoundarySaveError] = useState<string | null>(null);
  const [isBoundaryMock, setIsBoundaryMock] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await boundariesApi.getBoundaries();
      if (cancelled) return;
      setIsBoundaryMock(res.isFallback);
      if (!res.isFallback && res.data) setAllBoundaries(Object.values(res.data).flat());
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const cameraBoundaries = allBoundaries.filter((b) => b.cameraName === selectedCamera);

  // Confirmation & Toast Feedback
  const [isClearModalOpen, setIsClearModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [zoneToDeleteId, setZoneToDeleteId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Quick Presets & Clone State
  const [isPresetMenuOpen, setIsPresetMenuOpen] = useState(false);
  const [isCloneModalOpen, setIsCloneModalOpen] = useState(false);
  const [selectedCloneTargets, setSelectedCloneTargets] = useState<string[]>([]);
  const [cloneOverwrite, setCloneOverwrite] = useState(true);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Zones belonging to current camera
  const cameraZones = allZones.filter((z) => z.cameraName === selectedCamera);

  // Finished polygon drawing callback -> opens metadata modal
  const handleFinishDrawing = (points: { x: number; y: number }[]) => {
    setIsDrawing(false);
    setInProgressPoints(points);
    setEditingZone(null);
    handleSelectRole('restricted');
    setFormLabel(`Priority Zone ${cameraZones.length + 1}`);
    setFormDirection('inward');
    setFormEnabled(true);
    setFormError('');
    setIsFormOpen(true);
  };

  // Open Edit Metadata Modal
  const handleOpenEditZone = (zone: Zone) => {
    setEditingZone(zone);
    setFormTier(zone.tier);
    // A zone saved before roles existed (or drawn with a raw tier) has no
    // role — best-guess one from its tier so the picker still starts
    // somewhere sensible; saving attaches a real role going forward.
    setFormRole(zone.role ?? (zone.tier === 'red' ? 'restricted' : zone.tier === 'yellow' ? 'buffer' : 'authorized'));
    setFormLabel(zone.label);
    setFormDirection(zone.direction || 'inward');
    setFormEnabled(zone.enabled ?? true);
    setFormError('');
    setIsFormOpen(true);
  };

  // Save Zone Form (Add or Edit)
  const handleSaveZoneForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formLabel.trim()) {
      setFormError('Zone label is required');
      return;
    }

    if (editingZone) {
      // Update existing zone metadata
      const updated = allZones.map((z) => {
        if (z.id === editingZone.id) {
          return {
            ...z,
            tier: formTier,
            role: formRole,
            label: formLabel.trim(),
            direction: formTier === 'yellow' ? formDirection : undefined,
            enabled: formEnabled,
          };
        }
        return z;
      });
      setAllZones(updated);
      showToast(`Zone "${formLabel}" updated successfully`);
    } else {
      // Create new zone from inProgressPoints
      const newZone: Zone = {
        id: `zone-${selectedCamera}-${Date.now()}`,
        cameraName: selectedCamera,
        tier: formTier,
        role: formRole,
        label: formLabel.trim(),
        points: inProgressPoints,
        direction: formTier === 'yellow' ? formDirection : undefined,
        enabled: formEnabled,
      };
      setAllZones((prev) => [...prev, newZone]);
      setSelectedZoneId(newZone.id);
      showToast(`New ${formRole ? ZONE_ROLES.find((r) => r.value === formRole)?.label : formTier.toUpperCase()} zone registered on ${selectedCamera.toUpperCase()}`);
    }

    setIsFormOpen(false);
    setInProgressPoints([]);
    setEditingZone(null);
  };

  // Delete single zone confirmation
  const handlePromptDeleteZone = (id: string) => {
    setZoneToDeleteId(id);
    setIsDeleteModalOpen(true);
  };

  const handleConfirmDelete = () => {
    if (zoneToDeleteId) {
      setAllZones((prev) => prev.filter((z) => z.id !== zoneToDeleteId));
      if (selectedZoneId === zoneToDeleteId) setSelectedZoneId(null);
      showToast('Zone removed from camera profile');
    }
    setIsDeleteModalOpen(false);
    setZoneToDeleteId(null);
  };

  // Clear all zones for current camera
  const handleConfirmClearAll = () => {
    setAllZones((prev) => prev.filter((z) => z.cameraName !== selectedCamera));
    setSelectedZoneId(null);
    setIsClearModalOpen(false);
    showToast(`All zones cleared for ${selectedCamera.toUpperCase()}`);
  };

  const handleSaveZonesProfile = async () => {
    try {
      localStorage.setItem(ZONES_STORAGE_KEY, JSON.stringify(allZones));
    } catch (e) {
      console.error(e);
    }

    // The API groups zones per camera and writes config/zones_<cam>.json in
    // ZoneEngine's own format. Saving only to localStorage (as this did) left
    // the pipeline with no zones at all, so no sector/direction/loiter risk
    // was ever scored and a RED tier could not be reached.
    const grouped: Record<string, Zone[]> = {};
    for (const cam of availableCameras) grouped[cam] = [];
    for (const z of allZones) {
      (grouped[z.cameraName] ||= []).push(z);
    }

    const res = await zonesApi.saveZones(grouped);
    if (res.isFallback) {
      setSaveError(res.error);
      showToast('Saved locally only — backend unreachable, pipeline will NOT see these zones');
      return;
    }
    setSaveError(null);
    setIsMock(false);
    showToast('Zones written to the backend — restart the pipeline to apply them');
  };

  // "Reload saved zones": discard unsaved edits and re-read what the pipeline
  // actually uses. This used to load a demo layout for four invented cameras,
  // one "Save Zones" click away from being written into the real config.
  const handleResetDefaults = async () => {
    const res = await zonesApi.getZones({});
    setSelectedZoneId(null);
    setIsClearModalOpen(false);
    if (res.isFallback || !res.data) {
      showToast(`Could not reload zones: ${res.error ?? 'backend unreachable'}`);
      return;
    }
    setAllZones(Object.values(res.data).flat() as Zone[]);
    setIsMock(false);
    showToast('Reloaded the zones saved on the backend — unsaved edits discarded');
  };

  // Cameras the backend actually has (CAMERA_SOURCES + dashboard-added), plus
  // any camera that already has zones. This was a fixed cam0-cam3 list merged
  // with a stale localStorage key, so zones could be drawn for cameras that
  // do not exist and would never be read by the pipeline.
  const { cameras: apiCameras } = useSystemHealth();
  const availableCameras = useMemo(() => {
    const ids = [...apiCameras.map((c) => c.id), ...allZones.map((z) => z.cameraName)];
    return Array.from(new Set(ids)).sort();
  }, [apiCameras, allZones]);

  // Keep the selection on a camera that exists once the list arrives.
  useEffect(() => {
    if (availableCameras.length > 0 && !availableCameras.includes(selectedCamera)) {
      setSelectedCamera(availableCameras[0]);
    }
  }, [availableCameras, selectedCamera]);

  // Other cameras that currently have at least 1 zone configured
  const otherCamerasWithZones = useMemo(() => {
    return availableCameras.filter(
      (cam) => cam !== selectedCamera && allZones.some((z) => z.cameraName === cam)
    );
  }, [availableCameras, selectedCamera, allZones]);

  // 1-Click Zone Preset Application
  const handleApplyPreset = (preset: ZonePreset, overwrite: boolean = true) => {
    const newZones = preset.createZones(selectedCamera);
    setAllZones((prev) => {
      const filtered = overwrite ? prev.filter((z) => z.cameraName !== selectedCamera) : prev;
      return [...filtered, ...newZones];
    });
    setSelectedZoneId(newZones[0]?.id || null);
    setIsPresetMenuOpen(false);
    showToast(`Applied "${preset.name}" preset to ${selectedCamera.toUpperCase()} (${newZones.length} zones active)`);
  };

  // Open Clone Modal
  const handleOpenCloneModal = () => {
    const others = availableCameras.filter((c) => c !== selectedCamera);
    setSelectedCloneTargets(others);
    setIsCloneModalOpen(true);
  };

  // Execute Bulk Camera Cloning
  const handleConfirmClone = () => {
    if (cameraZones.length === 0) {
      showToast('No zones on active camera to clone');
      return;
    }
    if (selectedCloneTargets.length === 0) {
      showToast('Select at least one destination camera');
      return;
    }

    const clonedZones: Zone[] = [];
    selectedCloneTargets.forEach((targetCam) => {
      cameraZones.forEach((sourceZone, idx) => {
        clonedZones.push({
          ...sourceZone,
          id: `zone-${targetCam}-${Date.now()}-${idx}`,
          cameraName: targetCam,
          points: sourceZone.points.map((p) => ({ ...p })),
        });
      });
    });

    setAllZones((prev) => {
      let filtered = prev;
      if (cloneOverwrite) {
        filtered = prev.filter((z) => !selectedCloneTargets.includes(z.cameraName));
      }
      return [...filtered, ...clonedZones];
    });

    setIsCloneModalOpen(false);
    showToast(`Cloned ${cameraZones.length} zones to ${selectedCloneTargets.length} camera(s) (${selectedCloneTargets.map((c) => c.toUpperCase()).join(', ')})`);
  };

  // Copy zones from a specific reference camera into active camera
  const handleCopyFromCamera = (sourceCamera: string) => {
    const sourceZones = allZones.filter((z) => z.cameraName === sourceCamera);
    if (sourceZones.length === 0) {
      showToast(`No zones found on ${sourceCamera.toUpperCase()}`);
      return;
    }
    const cloned = sourceZones.map((z, idx) => ({
      ...z,
      id: `zone-${selectedCamera}-${Date.now()}-${idx}`,
      cameraName: selectedCamera,
      points: z.points.map((p) => ({ ...p })),
    }));
    setAllZones((prev) => {
      const filtered = prev.filter((z) => z.cameraName !== selectedCamera);
      return [...filtered, ...cloned];
    });
    setSelectedZoneId(cloned[0]?.id || null);
    showToast(`Copied ${cloned.length} zones from ${sourceCamera.toUpperCase()} to ${selectedCamera.toUpperCase()}`);
  };

  // --- Boundary (tripwire) handlers — mirror the zone handlers above, kept
  // as their own flow rather than reusing the zone form, since a boundary
  // has no tier/direction/points-count in common with a zone. ---
  const handleFinishBoundaryDrawing = (points: { x: number; y: number }[]) => {
    setIsBoundaryDrawing(false);
    setBoundaryInProgressPoints(points);
    setEditingBoundary(null);
    setBoundaryFormLabel(`Boundary ${cameraBoundaries.length + 1}`);
    setBoundaryFormEnabled(true);
    setIsBoundaryFormOpen(true);
  };

  const handleOpenEditBoundary = (boundary: Boundary) => {
    setEditingBoundary(boundary);
    setBoundaryFormLabel(boundary.label);
    setBoundaryFormEnabled(boundary.enabled);
    setIsBoundaryFormOpen(true);
  };

  const handleSaveBoundaryForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingBoundary) {
      setAllBoundaries((prev) =>
        prev.map((b) =>
          b.id === editingBoundary.id ? { ...b, label: boundaryFormLabel.trim(), enabled: boundaryFormEnabled } : b
        )
      );
      showToast(`Boundary "${boundaryFormLabel}" updated`);
    } else {
      const [p1, p2] = boundaryInProgressPoints;
      const newBoundary: Boundary = {
        id: `boundary-${selectedCamera}-${Date.now()}`,
        cameraName: selectedCamera,
        label: boundaryFormLabel.trim() || 'Untitled boundary',
        p1,
        p2,
        enabled: boundaryFormEnabled,
      };
      setAllBoundaries((prev) => [...prev, newBoundary]);
      setSelectedBoundaryId(newBoundary.id);
      showToast(`New boundary registered on ${selectedCamera.toUpperCase()}`);
    }
    setIsBoundaryFormOpen(false);
    setBoundaryInProgressPoints([]);
    setEditingBoundary(null);
  };

  const handleDeleteBoundary = (id: string) => {
    setAllBoundaries((prev) => prev.filter((b) => b.id !== id));
    if (selectedBoundaryId === id) setSelectedBoundaryId(null);
    showToast('Boundary removed');
  };

  const handleToggleBoundaryEnabled = (id: string) => {
    setAllBoundaries((prev) => prev.map((b) => (b.id === id ? { ...b, enabled: !b.enabled } : b)));
  };

  const handleSaveBoundariesProfile = async () => {
    // PUT /boundaries replaces the whole per-camera map, so allBoundaries
    // must actually reflect the backend's current state before we send it —
    // otherwise this silently wipes every other camera's saved boundaries.
    if (isBoundaryMock) {
      setBoundarySaveError('Boundaries have not loaded from the backend yet — refusing to save and risk overwriting other cameras.');
      showToast('Cannot save: boundaries not loaded from backend');
      return;
    }

    const grouped: Record<string, Boundary[]> = {};
    for (const cam of availableCameras) grouped[cam] = [];
    for (const b of allBoundaries) (grouped[b.cameraName] ||= []).push(b);

    const res = await boundariesApi.saveBoundaries(grouped);
    if (res.isFallback) {
      setBoundarySaveError(res.error);
      showToast('Saved locally only — backend unreachable');
      return;
    }
    setBoundarySaveError(null);
    setIsBoundaryMock(false);
    showToast('Boundaries written to the backend');
  };

  const handleSavePolicy = async () => {
    const res = await zonePolicyApi.savePolicy(policyDraft);
    if (res.isFallback || !res.data) {
      showToast(`Could not save policy: ${res.error ?? 'backend unreachable'}`);
      return;
    }
    setZonePolicy(res.data);
    setIsPolicyModalOpen(false);
    showToast('Zone severity policy updated');
  };

  return (
    <div className="space-y-5">
      {/* Toast Feedback */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 bg-bg-surface border border-accent-teal/50 rounded-sm shadow-2xl font-mono text-xs text-text-primary animate-in fade-in slide-in-from-bottom-2">
          <CheckCircle2 className="w-4 h-4 text-accent-teal" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Top Toolbar: Camera Selector & Global Zone Actions */}
      <div className="card-3d flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-gradient-to-b from-bg-surface to-bg-primary border border-ink/10 rounded-2xl shadow-[0_15px_35px_rgba(0,0,0,0.8)]">
        {/* Camera Selector Tabs */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0">
          <span className="font-mono text-xs font-semibold text-text-dim uppercase tracking-wider shrink-0 mr-1">
            Active Camera:
          </span>
          {availableCameras.map((cam) => {
            const count = allZones.filter((z) => z.cameraName === cam).length;
            const isSelected = selectedCamera === cam;
            return (
              <button
                key={cam}
                onClick={() => {
                  setSelectedCamera(cam);
                  setSelectedZoneId(null);
                  setIsDrawing(false);
                }}
                className={`px-3.5 py-1.5 text-xs font-mono rounded-xl transition-all flex items-center gap-2 border shrink-0 ${
                  isSelected
                    ? 'bg-accent-teal/20 text-accent-teal border-accent-teal/50 font-bold shadow-[0_0_12px_rgba(0,240,255,0.25)]'
                    : 'bg-bg-elevated text-text-dim border-ink/10 hover:text-text-primary hover:border-ink/20'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-accent-green shadow-[0_0_6px_#00ff88]" />
                <span>{cam.toUpperCase()}</span>
                <span className="text-[10px] text-text-muted">({count})</span>
              </button>
            );
          })}
        </div>

        {/* Global Action Buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Quick Presets Dropdown */}
          <div className="relative">
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Sparkles className="w-3.5 h-3.5 text-accent-teal" />}
              rightIcon={<ChevronDown className="w-3 h-3 text-text-muted" />}
              onClick={() => setIsPresetMenuOpen((prev) => !prev)}
            >
              Presets
            </Button>

            {isPresetMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setIsPresetMenuOpen(false)}
                />
                <div className="absolute right-0 mt-1.5 w-72 bg-bg-primary border border-ink/15 rounded-xl shadow-2xl p-2 z-50 space-y-1 font-mono text-xs backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150">
                  <div className="px-2.5 py-1.5 text-[10px] text-text-muted uppercase font-bold border-b border-ink/10 flex items-center justify-between">
                    <span>1-Click Zone Presets</span>
                    <span className="text-accent-teal">AUTO-TIER</span>
                  </div>
                  {ZONE_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => handleApplyPreset(preset, true)}
                      className="w-full p-2.5 rounded-lg hover:bg-ink/[0.06] text-left transition-colors flex flex-col gap-0.5 group"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-text-primary font-bold group-hover:text-accent-teal transition-colors">
                          {preset.name}
                        </span>
                        <span className="text-[9px] px-1.5 py-0.2 rounded bg-accent-teal/15 text-accent-teal font-semibold">
                          {preset.badge}
                        </span>
                      </div>
                      <span className="text-[11px] font-sans text-text-dim leading-snug">
                        {preset.description}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Clone to Cameras */}
          <Button
            variant="secondary"
            size="sm"
            disabled={cameraZones.length === 0}
            leftIcon={<Copy className="w-3.5 h-3.5 text-accent-yellow" />}
            onClick={handleOpenCloneModal}
            title={cameraZones.length === 0 ? 'Configure at least one zone to clone' : 'Clone zones to other cameras'}
          >
            Clone to Cameras...
          </Button>

          {/* Clear Zones */}
          <Button
            variant="secondary"
            size="sm"
            disabled={cameraZones.length === 0}
            leftIcon={<Trash2 className="w-3.5 h-3.5 text-accent-red" />}
            onClick={() => setIsClearModalOpen(true)}
          >
            Clear Zones
          </Button>

          {/* Save Zones */}
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Save className="w-3.5 h-3.5" />}
            onClick={handleSaveZonesProfile}
          >
            Save Zones
          </Button>

          <DataSourceBadge isMock={isMock} error={saveError} />
        </div>
      </div>

      {/* Zones live in config/zones_<cam>.json, which the pipeline reads once
          at startup — there is no live reload channel, so say so rather than
          letting a saved zone look immediately active. */}
      {!isMock && (
        <p className="text-[11px] font-mono text-text-dim">
          Saved zones apply on the next pipeline start (./run.sh).
        </p>
      )}

      {/* Main 2-Column Command Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Interactive Polygon Canvas Editor & Aligned Tier Rules (8 Cols) */}
        <div className="lg:col-span-8 space-y-5">
          <ZoneCanvas
            cameraName={selectedCamera}
            zones={cameraZones}
            streamUrl={cameraStreamUrl(selectedCamera)}
            selectedZoneId={selectedZoneId}
            onSelectZone={setSelectedZoneId}
            onEditZone={handleOpenEditZone}
            onDeleteZone={handlePromptDeleteZone}
            isDrawing={isDrawing}
            onStartDrawing={() => setIsDrawing(true)}
            onCancelDrawing={() => setIsDrawing(false)}
            onFinishDrawing={handleFinishDrawing}
          />

          {/* Operational Tier Rule Legend - Perfectly aligned with the Map Canvas */}
          <Card
            title="Border Tier Rules & Logic"
            subtitle="Autonomous perimeter threat scoring behavior & boundary classifications"
            variant="default"
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 font-mono text-xs">
              <div className="p-3.5 bg-accent-red/10 border border-accent-red/30 rounded-xl space-y-2 flex flex-col justify-between">
                <div className="flex items-center gap-1.5 text-accent-red font-bold">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  <span className="tracking-wide">RED ZONE (CRITICAL)</span>
                </div>
                <p className="text-[11px] font-sans text-text-dim leading-relaxed">
                  Zero-tolerance perimeter line. Any movement immediately escalates threat alarms, captures high-rate snapshots, and dispatches rapid response.
                </p>
                <div className="pt-2 border-t border-accent-red/20 flex items-center justify-between text-[10px] text-accent-red uppercase tracking-wider font-semibold">
                  <span>TIER 1</span>
                  <span>ZERO TOLERANCE</span>
                </div>
              </div>

              <div className="p-3.5 bg-accent-yellow/10 border border-accent-yellow/30 rounded-xl space-y-2 flex flex-col justify-between">
                <div className="flex items-center gap-1.5 text-accent-yellow font-bold">
                  <Compass className="w-4 h-4 shrink-0" />
                  <span className="tracking-wide">YELLOW ZONE (CAUTION)</span>
                </div>
                <p className="text-[11px] font-sans text-text-dim leading-relaxed">
                  Direction-sensitive perimeter buffer. Trajectory vectors toward border trigger caution alerts, while verified outward movement remains logged.
                </p>
                <div className="pt-2 border-t border-accent-yellow/20 flex items-center justify-between text-[10px] text-accent-yellow uppercase tracking-wider font-semibold">
                  <span>TIER 2</span>
                  <span>VECTOR AWARE</span>
                </div>
              </div>

              <div className="p-3.5 bg-accent-green/10 border border-accent-green/30 rounded-xl space-y-2 flex flex-col justify-between">
                <div className="flex items-center gap-1.5 text-accent-green font-bold">
                  <Shield className="w-4 h-4 shrink-0" />
                  <span className="tracking-wide">GREEN ZONE (NORMAL)</span>
                </div>
                <p className="text-[11px] font-sans text-text-dim leading-relaxed">
                  Authorized access and patrol corridors. Logs background activity during standard hours; automatically escalates to <strong>Yellow</strong> during curfew (21:00–05:00).
                </p>
                <div className="pt-2 border-t border-accent-green/20 flex items-center justify-between text-[10px] text-accent-green uppercase tracking-wider font-semibold">
                  <span>TIER 3</span>
                  <span>CURFEW AWARE</span>
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Right Column: Zone List Panel (4 Cols) */}
        <div className="lg:col-span-4 space-y-5">
          {/* Active Camera Zones List Panel */}
          <Card
            title={
              <div className="flex items-center justify-between w-full">
                <span className="font-semibold text-sm">Configured Zones</span>
                <Badge variant="teal" size="sm">
                  {cameraZones.length} ACTIVE
                </Badge>
              </div>
            }
            subtitle={`Defined perimeter boundaries for ${selectedCamera.toUpperCase()}`}
            variant="default"
          >
            <div className="space-y-2.5 max-h-[580px] overflow-y-auto pr-1">
              {cameraZones.length > 0 ? (
                cameraZones.map((zone) => {
                  const isSelected = selectedZoneId === zone.id;
                  const borderTierColor =
                    zone.tier === 'red'
                      ? 'border-l-accent-red'
                      : zone.tier === 'yellow'
                      ? 'border-l-accent-yellow'
                      : 'border-l-accent-green';

                  return (
                    <div
                      key={zone.id}
                      onClick={() =>
                        setSelectedZoneId(isSelected ? null : zone.id)
                      }
                      className={`p-3.5 rounded-xl border bg-bg-elevated hover:bg-ink/[0.04] transition-all cursor-pointer border-l-4 ${borderTierColor} shadow-md ${
                        isSelected
                          ? 'border-accent-teal/70 ring-2 ring-accent-teal/40 bg-accent-teal/10 shadow-[0_0_15px_rgba(0,240,255,0.15)]'
                          : 'border-ink/10'
                      } ${zone.enabled === false ? 'opacity-50' : ''}`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-1.5">
                          <Badge variant={zone.tier} size="sm">
                            {zone.role ? ZONE_ROLES.find((r) => r.value === zone.role)?.label ?? zone.tier : `${zone.tier} TIER`}
                          </Badge>
                          {zone.enabled === false && (
                            <span className="text-[9px] font-mono text-text-muted uppercase">disabled</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setAllZones((prev) =>
                                prev.map((z) => (z.id === zone.id ? { ...z, enabled: !(z.enabled ?? true) } : z))
                              );
                            }}
                            title={zone.enabled === false ? 'Enable zone' : 'Disable zone'}
                            className={`p-1 rounded-sm transition-colors ${
                              zone.enabled === false ? 'text-text-muted hover:text-accent-green' : 'text-accent-green hover:text-accent-yellow'
                            }`}
                          >
                            <Power className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenEditZone(zone);
                            }}
                            title="Edit metadata"
                            className="p-1 rounded-sm text-text-muted hover:text-accent-teal hover:bg-bg-surface transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePromptDeleteZone(zone.id);
                            }}
                            title="Delete zone"
                            className="p-1 rounded-sm text-text-muted hover:text-accent-red hover:bg-bg-surface transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="font-semibold text-xs text-text-primary tracking-wide">
                        {zone.label}
                      </div>

                      <div className="flex items-center justify-between font-mono text-[11px] text-text-dim mt-2 pt-1.5 border-t border-border-subtle/50">
                        <span>{zone.points.length} vertices</span>
                        {zone.direction && (
                          <span className="text-accent-yellow font-semibold flex items-center gap-1">
                            <Compass className="w-3 h-3" />
                            {zone.direction.toUpperCase()} VECTOR
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="p-4 rounded-xl border border-accent-yellow/30 bg-accent-yellow/5 space-y-3.5">
                  <div className="flex items-start gap-2.5">
                    <div className="p-2 rounded-lg bg-accent-yellow/15 text-accent-yellow border border-accent-yellow/30 shrink-0 mt-0.5">
                      <Shield className="w-5 h-5" />
                    </div>
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-accent-yellow uppercase tracking-wide">
                          Autonomous Fallback Active
                        </span>
                        <span className="w-2 h-2 rounded-full bg-accent-yellow animate-pulse" />
                      </div>
                      <p className="text-[11px] text-text-dim leading-relaxed font-sans">
                        Manual zones are <strong>optional</strong>. With 0 configured zones, the autonomous AI matrix monitors this camera automatically:
                      </p>
                    </div>
                  </div>

                  <div className="p-3 bg-bg-elevated rounded-xl border border-ink/10 space-y-2 font-mono text-[11px]">
                    <div className="flex items-center justify-between text-text-dim">
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent-yellow" />
                        Daylight (05:00 - 21:00)
                      </span>
                      <span className="text-accent-yellow font-bold">Caution (Tier 2)</span>
                    </div>
                    <div className="flex items-center justify-between text-text-dim">
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent-red" />
                        Curfew (21:00 - 05:00)
                      </span>
                      <span className="text-accent-red font-bold">Critical (Tier 1)</span>
                    </div>
                    <div className="flex items-center justify-between text-text-dim">
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent-red" />
                        Rapid Approach / Sprint
                      </span>
                      <span className="text-accent-red font-bold">Instant Escalation</span>
                    </div>
                  </div>

                  {/* 1-Click Zone Setup Options */}
                  <div className="space-y-2 pt-1 border-t border-ink/10">
                    <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider block font-bold">
                      1-Click Zone Setup (Optional):
                    </span>
                    <div className="grid grid-cols-1 gap-2">
                      <button
                        onClick={() => handleApplyPreset(ZONE_PRESETS[0], true)}
                        className="w-full px-3 py-2 rounded-lg bg-accent-teal/15 hover:bg-accent-teal/25 text-accent-teal border border-accent-teal/30 text-xs font-mono font-semibold flex items-center justify-between transition-all group"
                      >
                        <span className="flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 group-hover:rotate-12 transition-transform" />
                          Apply 3-Tier Horizon
                        </span>
                        <span className="text-[10px] bg-accent-teal/20 px-1.5 py-0.5 rounded">3 Zones</span>
                      </button>

                      <button
                        onClick={() => handleApplyPreset(ZONE_PRESETS[1], true)}
                        className="w-full px-3 py-2 rounded-lg bg-ink/[0.05] hover:bg-ink/[0.1] text-text-dim hover:text-text-primary border border-ink/10 text-xs font-mono font-semibold flex items-center justify-between transition-all"
                      >
                        <span className="flex items-center gap-1.5">
                          <Layers className="w-3.5 h-3.5" />
                          Apply Gate Funnel
                        </span>
                        <span className="text-[10px] bg-ink/10 px-1.5 py-0.5 rounded">4 Zones</span>
                      </button>

                      {otherCamerasWithZones.length > 0 && (
                        <button
                          onClick={() => handleCopyFromCamera(otherCamerasWithZones[0])}
                          className="w-full px-3 py-2 rounded-lg bg-ink/[0.05] hover:bg-ink/[0.1] text-text-dim hover:text-text-primary border border-ink/10 text-xs font-mono font-semibold flex items-center justify-between transition-all"
                        >
                          <span className="flex items-center gap-1.5">
                            <Copy className="w-3.5 h-3.5" />
                            Copy Zones from {otherCamerasWithZones[0].toUpperCase()}
                          </span>
                          <span className="text-[10px] bg-ink/10 px-1.5 py-0.5 rounded">Mirror</span>
                        </button>
                      )}

                      <button
                        onClick={() => setIsDrawing(true)}
                        className="w-full px-3 py-2 rounded-lg bg-ink/[0.03] hover:bg-ink/[0.08] text-text-muted hover:text-text-primary border border-ink/10 text-xs font-mono flex items-center justify-center gap-1.5 transition-all"
                      >
                        <Pencil className="w-3 h-3" />
                        <span>Draw Custom Polygon</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Bottom Quick Clone Action if camera has zones */}
            {cameraZones.length > 0 && (
              <div className="pt-3 border-t border-ink/10">
                <button
                  onClick={handleOpenCloneModal}
                  className="w-full py-2 px-3 rounded-lg bg-ink/[0.04] hover:bg-accent-teal/15 text-text-dim hover:text-accent-teal border border-ink/10 hover:border-accent-teal/30 transition-all font-mono text-xs flex items-center justify-center gap-1.5 font-semibold"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Clone {cameraZones.length} Zones to Other Cameras</span>
                </button>
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Virtual Boundaries — a separate entity from zones (see
          zones/boundary_engine.py): a boundary answers "did this track just
          cross a line", not "which region is this in". Detected and shown
          here; not yet fed into incidents. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <Milestone className="w-4 h-4 text-accent-teal" />
              Virtual Boundaries — {selectedCamera.toUpperCase()}
            </h2>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Save className="w-3.5 h-3.5" />}
                onClick={handleSaveBoundariesProfile}
              >
                Save Boundaries
              </Button>
              <DataSourceBadge isMock={isBoundaryMock} error={boundarySaveError} />
            </div>
          </div>
          <ZoneCanvas
            mode="line"
            cameraName={selectedCamera}
            zones={[]}
            streamUrl={cameraStreamUrl(selectedCamera)}
            boundaries={cameraBoundaries}
            selectedZoneId={null}
            onSelectZone={() => {}}
            onEditZone={() => {}}
            onDeleteZone={() => {}}
            selectedBoundaryId={selectedBoundaryId}
            onSelectBoundary={setSelectedBoundaryId}
            onEditBoundary={handleOpenEditBoundary}
            onDeleteBoundary={handleDeleteBoundary}
            isDrawing={isBoundaryDrawing}
            onStartDrawing={() => setIsBoundaryDrawing(true)}
            onCancelDrawing={() => setIsBoundaryDrawing(false)}
            onFinishDrawing={handleFinishBoundaryDrawing}
          />
        </div>

        <div className="lg:col-span-4 space-y-5">
          <Card
            title={
              <div className="flex items-center justify-between w-full">
                <span className="font-semibold text-sm">Configured Boundaries</span>
                <Badge variant="teal" size="sm">{cameraBoundaries.length} ACTIVE</Badge>
              </div>
            }
            subtitle={`Directional tripwires for ${selectedCamera.toUpperCase()} — detected and shown, not yet part of scoring`}
            variant="default"
          >
            <div className="space-y-2.5 max-h-[320px] overflow-y-auto pr-1">
              {cameraBoundaries.length > 0 ? (
                cameraBoundaries.map((boundary) => {
                  const isSelected = selectedBoundaryId === boundary.id;
                  return (
                    <div
                      key={boundary.id}
                      onClick={() => setSelectedBoundaryId(isSelected ? null : boundary.id)}
                      className={`p-3 rounded-xl border bg-bg-elevated hover:bg-ink/[0.04] transition-all cursor-pointer ${
                        isSelected ? 'border-accent-teal/70 ring-2 ring-accent-teal/40 bg-accent-teal/10' : 'border-ink/10'
                      } ${!boundary.enabled ? 'opacity-50' : ''}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-xs text-text-primary">{boundary.label || 'Untitled boundary'}</span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleBoundaryEnabled(boundary.id);
                            }}
                            title={boundary.enabled ? 'Disable boundary' : 'Enable boundary'}
                            className={`p-1 rounded-sm transition-colors ${boundary.enabled ? 'text-accent-green hover:text-accent-yellow' : 'text-text-muted hover:text-accent-green'}`}
                          >
                            <Power className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenEditBoundary(boundary);
                            }}
                            title="Edit boundary"
                            className="p-1 rounded-sm text-text-muted hover:text-accent-teal hover:bg-bg-surface transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteBoundary(boundary.id);
                            }}
                            title="Delete boundary"
                            className="p-1 rounded-sm text-text-muted hover:text-accent-red hover:bg-bg-surface transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <span className="font-mono text-[10px] text-text-dim">
                        {boundary.enabled ? 'Enabled' : 'Disabled — kept, not evaluated'}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="p-4 text-center text-xs text-text-dim font-mono">
                  No boundaries yet — draw a line to add one.
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* ZONE CONFIGURATION MODAL (FOR NEW OR EDIT) */}
      <Modal
        isOpen={isFormOpen}
        onClose={() => {
          setIsFormOpen(false);
          setInProgressPoints([]);
          setEditingZone(null);
        }}
        title={editingZone ? 'Edit Zone Configuration' : 'Configure New Priority Zone'}
        description={`Set detection tier, label, and directional sensitivity for ${selectedCamera.toUpperCase()}`}
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsFormOpen(false);
                setInProgressPoints([]);
                setEditingZone(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleSaveZoneForm}>
              {editingZone ? 'Save Changes' : 'Confirm & Create Zone'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleSaveZoneForm} className="space-y-4">
          {formError && (
            <div className="p-2 bg-accent-red/15 border border-accent-red/40 text-accent-red rounded-sm text-xs font-mono">
              {formError}
            </div>
          )}

          {/* Zone Role Selection — the real-world role an operator thinks in
              terms of. Severity (formTier, used for coloring and saved
              alongside) is resolved from this via the zone policy below. */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-mono uppercase text-text-dim">
                Zone Role:
              </label>
              <button
                type="button"
                onClick={() => {
                  setPolicyDraft(zonePolicy);
                  setIsPolicyModalOpen(true);
                }}
                className="flex items-center gap-1 text-[10px] font-mono text-text-muted hover:text-accent-teal transition-colors"
              >
                <Settings2 className="w-3 h-3" />
                Edit severity policy
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {ZONE_ROLES.map((role) => {
                const resolvedTier = (zonePolicy[role.value] as 'red' | 'yellow' | 'green') ?? 'green';
                // Static per-tier class strings — Tailwind's JIT scanner
                // can't see classes built by string interpolation, so this
                // can't be `bg-${tierColor}/15` etc.
                const tierStyles = {
                  red: { selected: 'bg-accent-red/15 border-accent-red ring-1 ring-accent-red', dot: 'bg-accent-red', text: 'text-accent-red' },
                  yellow: { selected: 'bg-accent-yellow/15 border-accent-yellow ring-1 ring-accent-yellow', dot: 'bg-accent-yellow', text: 'text-accent-yellow' },
                  green: { selected: 'bg-accent-green/15 border-accent-green ring-1 ring-accent-green', dot: 'bg-accent-green', text: 'text-accent-green' },
                }[resolvedTier];
                const isSelected = formRole === role.value;
                return (
                  <label
                    key={role.value}
                    className={`flex flex-col p-3 rounded-sm border cursor-pointer transition-all ${
                      isSelected ? tierStyles.selected : 'bg-bg-elevated border-border-subtle hover:border-accent-teal/40'
                    }`}
                  >
                    <input
                      type="radio"
                      name="role"
                      value={role.value}
                      checked={isSelected}
                      onChange={() => handleSelectRole(role.value)}
                      className="sr-only"
                    />
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`w-2.5 h-2.5 rounded-full ${tierStyles.dot}`} />
                      <span className="font-mono text-xs font-bold text-text-primary">{role.label}</span>
                    </div>
                    <span className="text-[10px] text-text-dim leading-snug">{role.description}</span>
                    <span className={`text-[9px] font-mono font-semibold ${tierStyles.text} mt-1.5 uppercase`}>
                      → {resolvedTier} severity
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Zone Label Input */}
          <div>
            <label className="block text-xs font-mono uppercase text-text-dim mb-1">
              Zone Identifier / Description Label <span className="text-accent-red">*</span>
            </label>
            <input
              type="text"
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
              placeholder="e.g. North Barrier Line, Outpost Vehicle Bay"
              className="w-full px-3 py-2 bg-bg-elevated border border-border-subtle rounded-sm text-sm text-text-primary focus:outline-none focus:border-accent-teal"
            />
          </div>

          {/* Enable/Disable — kept and saved either way, just not used for
              classification while disabled (mirrors the boundary toggle). */}
          <label className="flex items-center justify-between p-2.5 bg-bg-elevated border border-border-subtle rounded-sm cursor-pointer">
            <span className="flex items-center gap-2 text-xs font-mono text-text-dim">
              <Power className="w-3.5 h-3.5" />
              Zone enabled
            </span>
            <input
              type="checkbox"
              checked={formEnabled}
              onChange={(e) => setFormEnabled(e.target.checked)}
              className="w-4 h-4 accent-accent-teal"
            />
          </label>

          {/* Direction Toggle (Active only for Yellow zones) */}
          {formTier === 'yellow' && (
            <div className="p-3 bg-bg-elevated border border-accent-yellow/30 rounded-sm space-y-2">
              <div className="flex items-center gap-2 text-xs font-mono text-accent-yellow font-semibold">
                <Compass className="w-4 h-4" />
                <span>DIRECTION KINEMATICS SENSITIVITY</span>
              </div>
              <p className="text-[11px] text-text-dim">
                Yellow zones trigger alerts depending on breach vector trajectory:
              </p>
              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setFormDirection('inward')}
                  className={`px-3 py-2 rounded-sm border text-xs font-mono flex items-center justify-center gap-1.5 ${
                    formDirection === 'inward'
                      ? 'bg-accent-yellow/20 text-accent-yellow border-accent-yellow font-bold'
                      : 'bg-bg-surface text-text-dim border-border-subtle hover:text-text-primary'
                  }`}
                >
                  <ArrowDownRight className="w-3.5 h-3.5" />
                  <span>INWARD VECTOR</span>
                </button>
                <button
                  type="button"
                  onClick={() => setFormDirection('outward')}
                  className={`px-3 py-2 rounded-sm border text-xs font-mono flex items-center justify-center gap-1.5 ${
                    formDirection === 'outward'
                      ? 'bg-accent-yellow/20 text-accent-yellow border-accent-yellow font-bold'
                      : 'bg-bg-surface text-text-dim border-border-subtle hover:text-text-primary'
                  }`}
                >
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  <span>OUTWARD VECTOR</span>
                </button>
              </div>
            </div>
          )}
        </form>
      </Modal>

      {/* DELETE SINGLE ZONE CONFIRMATION MODAL */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        title="Delete Virtual Zone"
        description="Are you sure you want to delete this zone from the camera profile?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setIsDeleteModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={handleConfirmDelete}>
              Confirm Delete
            </Button>
          </>
        }
      >
        <p className="text-xs text-text-dim">
          This will remove the polygon detection rules for this sector. The AI pipeline will no longer evaluate threat scores for this specific zone.
        </p>
      </Modal>

      {/* CLEAR ALL ZONES CONFIRMATION MODAL */}
      <Modal
        isOpen={isClearModalOpen}
        onClose={() => setIsClearModalOpen(false)}
        title={`Clear All Zones on ${selectedCamera.toUpperCase()}`}
        description="Are you sure you want to remove all configured polygon zones for this camera?"
        size="sm"
        footer={
          <div className="flex items-center justify-between w-full">
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<RotateCcw className="w-3.5 h-3.5 text-accent-teal" />}
              onClick={handleResetDefaults}
            >
              Reload Saved Zones
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setIsClearModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={handleConfirmClearAll}>
                Clear All Zones
              </Button>
            </div>
          </div>
        }
      >
        <div className="p-3 bg-accent-red/10 border border-accent-red/30 rounded-sm text-xs text-text-primary flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-accent-red shrink-0 mt-0.5" />
          <span>
            This action will delete all {cameraZones.length} zones defined on {selectedCamera.toUpperCase()}. You will need to redraw or reload them.
          </span>
        </div>
      </Modal>

      {/* CLONE TO OTHER CAMERAS MODAL */}
      <Modal
        isOpen={isCloneModalOpen}
        onClose={() => setIsCloneModalOpen(false)}
        title={
          <div className="flex items-center gap-2">
            <Copy className="w-4 h-4 text-accent-yellow" />
            <span>Clone Zones Across Cameras</span>
          </div>
        }
        description={`Duplicate ${cameraZones.length} configured zone(s) from ${selectedCamera.toUpperCase()} to other sector cameras.`}
        size="md"
        footer={
          <div className="flex items-center justify-between w-full">
            <span className="text-xs font-mono text-text-dim">
              {selectedCloneTargets.length} camera(s) selected
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setIsCloneModalOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={selectedCloneTargets.length === 0}
                leftIcon={<Copy className="w-3.5 h-3.5" />}
                onClick={handleConfirmClone}
              >
                Clone to {selectedCloneTargets.length} Camera(s)
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4 font-mono text-xs">
          <div className="p-3 bg-ink/[0.03] border border-ink/10 rounded-xl space-y-1">
            <span className="text-text-muted text-[10px] block uppercase">Source Camera</span>
            <div className="flex items-center justify-between">
              <span className="text-text-primary font-bold">{selectedCamera.toUpperCase()}</span>
              <Badge variant="teal" size="sm">
                {cameraZones.length} ZONES
              </Badge>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-text-dim uppercase text-[11px] font-bold">
                Select Destination Cameras:
              </span>
              <button
                type="button"
                onClick={() => {
                  const others = availableCameras.filter((c) => c !== selectedCamera);
                  if (selectedCloneTargets.length === others.length) {
                    setSelectedCloneTargets([]);
                  } else {
                    setSelectedCloneTargets(others);
                  }
                }}
                className="text-accent-teal hover:underline text-[11px]"
              >
                {selectedCloneTargets.length === availableCameras.filter((c) => c !== selectedCamera).length
                  ? 'Deselect All'
                  : 'Select All'}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {availableCameras
                .filter((c) => c !== selectedCamera)
                .map((cam) => {
                  const isChecked = selectedCloneTargets.includes(cam);
                  const existingCount = allZones.filter((z) => z.cameraName === cam).length;
                  return (
                    <label
                      key={cam}
                      className={`flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all ${
                        isChecked
                          ? 'bg-accent-teal/15 border-accent-teal text-text-primary'
                          : 'bg-bg-elevated border-ink/10 text-text-dim hover:border-ink/20'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedCloneTargets((prev) => [...prev, cam]);
                            } else {
                              setSelectedCloneTargets((prev) => prev.filter((c) => c !== cam));
                            }
                          }}
                          className="w-4 h-4 rounded accent-accent-teal"
                        />
                        <span className="font-bold">{cam.toUpperCase()}</span>
                      </div>
                      <span className="text-[10px] text-text-muted">
                        ({existingCount} existing)
                      </span>
                    </label>
                  );
                })}
            </div>
          </div>

          <div className="pt-2 border-t border-ink/10">
            <label className="flex items-center gap-2 cursor-pointer text-[11px] text-text-dim">
              <input
                type="checkbox"
                checked={cloneOverwrite}
                onChange={(e) => setCloneOverwrite(e.target.checked)}
                className="w-3.5 h-3.5 accent-accent-teal rounded"
              />
              <span>Overwrite existing zones on destination cameras</span>
            </label>
            <p className="text-[10px] text-text-muted pl-5 mt-0.5 font-sans">
              If checked, replaces target cameras' zones with source zones. If unchecked, appends to them.
            </p>
          </div>
        </div>
      </Modal>

      {/* BOUNDARY CONFIGURATION MODAL (FOR NEW OR EDIT) */}
      <Modal
        isOpen={isBoundaryFormOpen}
        onClose={() => {
          setIsBoundaryFormOpen(false);
          setBoundaryInProgressPoints([]);
          setEditingBoundary(null);
        }}
        title={editingBoundary ? 'Edit Boundary' : 'Configure New Boundary'}
        description={`Label and enable this tripwire on ${selectedCamera.toUpperCase()}`}
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsBoundaryFormOpen(false);
                setBoundaryInProgressPoints([]);
                setEditingBoundary(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleSaveBoundaryForm}>
              {editingBoundary ? 'Save Changes' : 'Confirm & Create Boundary'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleSaveBoundaryForm} className="space-y-4">
          <div>
            <label className="block text-xs font-mono uppercase text-text-dim mb-1">
              Boundary Label <span className="text-accent-red">*</span>
            </label>
            <input
              type="text"
              value={boundaryFormLabel}
              onChange={(e) => setBoundaryFormLabel(e.target.value)}
              placeholder="e.g. North Fence Line"
              className="w-full px-3 py-2 bg-bg-elevated border border-border-subtle rounded-sm text-sm text-text-primary focus:outline-none focus:border-accent-teal"
            />
          </div>
          <label className="flex items-center justify-between p-2.5 bg-bg-elevated border border-border-subtle rounded-sm cursor-pointer">
            <span className="flex items-center gap-2 text-xs font-mono text-text-dim">
              <Power className="w-3.5 h-3.5" />
              Boundary enabled
            </span>
            <input
              type="checkbox"
              checked={boundaryFormEnabled}
              onChange={(e) => setBoundaryFormEnabled(e.target.checked)}
              className="w-4 h-4 accent-accent-teal"
            />
          </label>
        </form>
      </Modal>

      {/* ZONE SEVERITY POLICY MODAL — the configurable role -> tier mapping.
          Editing this changes how NEWLY SAVED zones resolve their severity;
          it never touches zone_engine.py/threat_score.py directly. */}
      <Modal
        isOpen={isPolicyModalOpen}
        onClose={() => setIsPolicyModalOpen(false)}
        title="Zone Severity Policy"
        description="Which severity tier each zone role resolves to when scored"
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setIsPolicyModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleSavePolicy}>
              Save Policy
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {ZONE_ROLES.map((role) => (
            <div key={role.value} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-mono font-bold text-text-primary">{role.label}</div>
                <div className="text-[10px] text-text-dim">{role.description}</div>
              </div>
              <select
                value={policyDraft[role.value] ?? zonePolicy[role.value] ?? 'green'}
                onChange={(e) => setPolicyDraft((prev) => ({ ...prev, [role.value]: e.target.value }))}
                className="px-2.5 py-1.5 bg-bg-elevated border border-border-subtle rounded-sm text-xs font-mono text-text-primary focus:outline-none focus:border-accent-teal shrink-0"
              >
                <option value="red">Red</option>
                <option value="yellow">Yellow</option>
                <option value="green">Green</option>
              </select>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
};
