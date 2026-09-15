import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  WatchlistPerson,
  generateBiometricAvatarSvg,
} from '@/lib/mockWatchlist';
import { Incident } from '@/lib/mockIncidents';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { EvidenceImage } from '@/components/ui/EvidenceImage';
import { threatStatusLabel, threatStatusVariant } from '@/lib/threatStatus';
import { useBackendData } from '@/lib/useBackendData';
import { useSystemHealth } from '@/components/system/SystemHealthProvider';
import {
  Users,
  Search,
  Plus,
  Trash2,
  AlertTriangle,
  ShieldCheck,
  ShieldAlert,
  Upload,
  CheckCircle2,
  X,
  AlertCircle,
  Eye,
  Camera,
  ArrowRight,
  ArrowUpDown,
  Radar,
} from 'lucide-react';

import { apiAssetUrl, incidentsApi, watchlistApi } from '@/lib/api';
import { DataSourceBadge } from '@/components/ui/DataSourceBadge';

const WATCHLIST_STORAGE_KEY = 'ibvap_watchlist_data';

// A freshly-enrolled person's photo is briefly held as a data: URL in local
// state (see handleAddPersonSubmit) before the next GET /watchlist replaces
// it with the real "/watchlist/{id}/photo" API path — apiAssetUrl() only
// needs to run on the latter (it prefixes the API base URL + auth token).
const resolvePhotoUrl = (url: string | undefined): string | undefined =>
  url && url.startsWith('data:') ? url : apiAssetUrl(url);

type SortMode = 'recent' | 'matches' | 'added' | 'name';

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'recent', label: 'Recently Matched' },
  { value: 'matches', label: 'Most Matches' },
  { value: 'added', label: 'Recently Enrolled' },
  { value: 'name', label: 'Name (A-Z)' },
];

const loadStoredWatchlist = (): WatchlistPerson[] => {
  try {
    const saved = localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (e) {
    console.error('Failed to load watchlist from storage', e);
  }
  return [];
};

// Small KPI tile — mirrors DashboardPage's KpiCard so the watchlist reads as
// part of the same control room rather than a bolted-on CRUD screen.
const StatTile: React.FC<{
  label: string;
  value: React.ReactNode;
  sublabel: React.ReactNode;
  icon: React.ElementType;
  tone: 'teal' | 'green' | 'red' | 'yellow';
}> = ({ label, value, sublabel, icon: Icon, tone }) => {
  const toneCls = {
    teal: { border: 'border-t-accent-teal', icon: 'text-accent-teal', value: 'text-text-primary' },
    green: { border: 'border-t-accent-green', icon: 'text-accent-green', value: 'text-accent-green' },
    red: { border: 'border-t-accent-red', icon: 'text-accent-red', value: 'text-accent-red' },
    yellow: { border: 'border-t-accent-yellow', icon: 'text-accent-yellow', value: 'text-accent-yellow' },
  }[tone];
  return (
    <Card variant="default" className={`border-t-2 ${toneCls.border}`} bodyClassName="p-3.5">
      <div className="flex items-start justify-between">
        <div className="space-y-0.5 min-w-0">
          <span className="text-[11px] font-semibold text-text-dim uppercase tracking-wider block">{label}</span>
          <span className={`text-xl font-bold tracking-tight block ${toneCls.value}`}>{value}</span>
          <span className="text-[10px] text-text-muted font-medium block truncate">{sublabel}</span>
        </div>
        <div className={`w-7 h-7 rounded-lg bg-bg-elevated border border-ink/10 flex items-center justify-center shrink-0 ${toneCls.icon}`}>
          <Icon className="w-3.5 h-3.5" />
        </div>
      </div>
    </Card>
  );
};

export const WatchlistPage: React.FC = () => {
  const navigate = useNavigate();
  const [watchlist, setWatchlist] = useState<WatchlistPerson[]>(loadStoredWatchlist);
  const [isMock, setIsMock] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Add Person Modal State
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [formName, setFormName] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [previewPhotoUrl, setPreviewPhotoUrl] = useState<string>('');
  const [formError, setFormError] = useState('');

  // Delete Confirmation Modal State
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [personToDelete, setPersonToDelete] = useState<WatchlistPerson | null>(null);

  // Sightings Detail Modal State — turns the bare "N matches" badge into an
  // actual timeline instead of a dead end.
  const [sightingsPerson, setSightingsPerson] = useState<WatchlistPerson | null>(null);

  const { cameras } = useSystemHealth();
  const camMeta = useMemo(
    () => Object.fromEntries(cameras.map((c) => [c.id, c.location])) as Record<string, string>,
    [cameras]
  );

  // Incidents already carry watchlistMatch (the matched person's name, set
  // by face.watchlist.WatchlistMatcher) — joining on name turns every
  // enrolled subject's match count into a real, browsable sighting history
  // without a new backend endpoint.
  const { data: incidents } = useBackendData<Incident[]>(() => incidentsApi.getIncidents(), []);

  const sightingsByName = useMemo(() => {
    const map = new Map<string, Incident[]>();
    for (const inc of incidents) {
      if (!inc.watchlistMatch) continue;
      const key = inc.watchlistMatch.trim().toLowerCase();
      const list = map.get(key) ?? [];
      list.push(inc);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => b.timestamp - a.timestamp);
    return map;
  }, [incidents]);

  const sightingsFor = (person: WatchlistPerson) => sightingsByName.get(person.name.trim().toLowerCase()) ?? [];

  // watchlist.db is the real store — it holds the face embeddings the
  // pipeline matches against. localStorage is only the offline seed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await watchlistApi.getWatchlist();
      if (cancelled) return;
      setIsMock(res.isFallback);
      setLoadError(res.error);
      if (!res.isFallback && res.data) setWatchlist(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Sync to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlist));
    } catch (e) {
      console.error('Failed to persist watchlist', e);
    }
  }, [watchlist]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Filtered by name/notes, flagged toggle, then sorted.
  const filteredWatchlist = useMemo(() => {
    let list = watchlist;
    if (flaggedOnly) list = list.filter((p) => p.matchCount > 0);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (p) => p.name.toLowerCase().includes(q) || (p.notes ?? '').toLowerCase().includes(q)
      );
    }
    const sorted = [...list];
    switch (sortMode) {
      case 'matches':
        sorted.sort((a, b) => b.matchCount - a.matchCount);
        break;
      case 'added':
        sorted.sort((a, b) => b.addedAt - a.addedAt);
        break;
      case 'name':
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'recent':
      default:
        sorted.sort((a, b) => (b.lastMatchedAt ?? 0) - (a.lastMatchedAt ?? 0));
        break;
    }
    return sorted;
  }, [watchlist, searchQuery, sortMode, flaggedOnly]);

  // Relative Time Formatter
  const formatRelativeTime = (timestampSeconds: number | null): string => {
    if (!timestampSeconds) return 'Never';
    const diff = Math.floor(Date.now() / 1000 - timestampSeconds);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    const days = Math.floor(diff / 86400);
    return `${days}d ago`;
  };

  const formatDateTime = (ts: number) =>
    new Date(ts * 1000).toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

  // Handle Photo File Upload
  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        // readAsDataURL, not createObjectURL: a blob: URL is a handle that
        // only resolves inside this tab, so the photo could never reach the
        // backend and no embedding could be computed from it.
        const reader = new FileReader();
        reader.onload = () => {
          setPreviewPhotoUrl(String(reader.result));
          setFormError('');
        };
        reader.onerror = () => setFormError('Could not read that image file.');
        reader.readAsDataURL(file);
      } catch (err) {
        console.error('Failed to create object URL', err);
      }
    }
  };


  const handleOpenAddModal = () => {
    setFormName('');
    setFormNotes('');
    setPreviewPhotoUrl('');
    setFormError('');
    setIsAddModalOpen(true);
  };

  // Submit Add Person
  const handleAddPersonSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      setFormError('Full name is required for biometric indexing');
      return;
    }
    if (!previewPhotoUrl) {
      setFormError('A reference photo or facial scan is required to generate embeddings');
      return;
    }

    const draft: WatchlistPerson = {
      id: Date.now(),
      name: formName.trim(),
      notes: formNotes.trim() || 'No intelligence notes logged.',
      photoUrl: previewPhotoUrl,
      addedAt: Math.floor(Date.now() / 1000),
      lastMatchedAt: null,
      matchCount: 0,
    };

    // The backend runs InsightFace over the photo and stores the embedding;
    // the id it returns is the watchlist.db row id. Adding to local state
    // without this (as before) produced a subject that looked enrolled but
    // had no embedding, so the pipeline could never match them.
    const res = await watchlistApi.enrollPerson({ ...draft, photoData: previewPhotoUrl } as WatchlistPerson);
    if (res.isFallback) {
      setFormError(
        res.error?.includes('422')
          ? 'No face detected in that photo — try a clearer, more frontal image.'
          : `Enrolment failed: ${res.error ?? 'backend unreachable'}`
      );
      return;
    }

    setWatchlist((prev) => [{ ...draft, ...(res.data ?? {}), photoUrl: previewPhotoUrl }, ...prev]);
    setIsAddModalOpen(false);
    showToast(`Subject "${draft.name}" enrolled — embedding stored in watchlist.db`);
  };

  // Open Delete Confirmation Modal
  const handlePromptDelete = (person: WatchlistPerson) => {
    setPersonToDelete(person);
    setIsDeleteModalOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (personToDelete) {
      const res = await watchlistApi.deletePerson(personToDelete.id);
      if (res.isFallback) {
        showToast(`Could not remove "${personToDelete.name}" — backend unreachable`);
        setIsDeleteModalOpen(false);
        setPersonToDelete(null);
        return;
      }
      setWatchlist((prev) => prev.filter((p) => p.id !== personToDelete.id));
      showToast(`Subject "${personToDelete.name}" removed from watchlist.db`);
    }
    setIsDeleteModalOpen(false);
    setPersonToDelete(null);
  };

  const totalMatches = watchlist.reduce((acc, p) => acc + p.matchCount, 0);
  const flaggedCount = watchlist.filter((p) => p.matchCount > 0).length;
  const mostRecentMatch = watchlist.reduce<number | null>(
    (latest, p) => (p.lastMatchedAt && (!latest || p.lastMatchedAt > latest) ? p.lastMatchedAt : latest),
    null
  );
  const matches24h = watchlist.reduce(
    (acc, p) => acc + sightingsFor(p).filter((s) => Date.now() / 1000 - s.timestamp < 86400).length,
    0
  );

  const sightingsList = sightingsPerson ? sightingsFor(sightingsPerson) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono uppercase tracking-wider text-text-dim">
          {watchlist.length} enrolled subject{watchlist.length === 1 ? '' : 's'}
        </span>
        <DataSourceBadge isMock={isMock} error={loadError} />
      </div>

      {/* Dynamic Toast Feedback */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 bg-bg-surface border border-accent-teal/50 rounded-xl shadow-2xl font-mono text-xs text-text-primary animate-in fade-in slide-in-from-bottom-2">
          <CheckCircle2 className="w-4 h-4 text-accent-teal" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* 1. DPDP Act Statutory Compliance Warning Banner */}
      <div className="card-3d p-4 bg-gradient-to-r from-accent-yellow/10 via-bg-surface to-bg-primary border-l-4 border-l-accent-yellow border border-ink/10 rounded-2xl shadow-[0_10px_30px_rgba(0,0,0,0.7)] space-y-1">
        <div className="flex items-center gap-2 text-accent-yellow font-bold text-xs font-mono uppercase tracking-wide">
          <AlertTriangle className="w-4 h-4 shrink-0 text-accent-yellow" />
          <span>Statutory Compliance Notice: Biometric Face-Recognition Data</span>
        </div>
        <p className="text-xs text-text-dim leading-relaxed">
          Watchlist entries contain biometric face-recognition data (InsightFace 512-D vectors). Ensure all additions and data-retention schedules comply with your organization's authorized border surveillance and DPDP Act handling procedures.
        </p>
      </div>

      {/* 2. KPI Stat Row — same control-room language as the main Dashboard,
          so operators land on a page that already reads as "live", not a
          plain CRUD list. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile
          label="Enrolled Subjects"
          icon={Users}
          tone="teal"
          value={watchlist.length}
          sublabel="In biometric watchlist"
        />
        <StatTile
          label="Flagged"
          icon={ShieldAlert}
          tone="red"
          value={flaggedCount}
          sublabel={flaggedCount > 0 ? 'Matched at least once' : 'None matched yet'}
        />
        <StatTile
          label="Detections (24h)"
          icon={Radar}
          tone="yellow"
          value={matches24h}
          sublabel={`${totalMatches} all-time`}
        />
        <StatTile
          label="Last Activity"
          icon={ShieldCheck}
          tone={mostRecentMatch ? 'green' : 'teal'}
          value={mostRecentMatch ? formatRelativeTime(mostRecentMatch) : '—'}
          sublabel={mostRecentMatch ? 'Most recent match' : 'No matches recorded'}
        />
      </div>

      {/* 3. Top Filter & Action Bar */}
      <div className="card-3d flex flex-col lg:flex-row lg:items-center justify-between gap-3 p-4 bg-gradient-to-b from-bg-surface to-bg-primary border border-ink/10 rounded-2xl shadow-[0_15px_35px_rgba(0,0,0,0.8)]">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 flex-1 min-w-0">
          {/* Search Input */}
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-text-muted absolute left-3 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name or notes..."
              className="w-full pl-9 pr-8 py-2 bg-bg-surface border border-ink/10 rounded-xl text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-teal focus:ring-1 focus:ring-accent-teal font-mono transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-2.5 text-text-muted hover:text-text-primary"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Sort Select */}
          <div className="relative">
            <ArrowUpDown className="w-3.5 h-3.5 text-text-muted absolute left-2.5 top-2.5 pointer-events-none" />
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="pl-8 pr-3 py-2 bg-bg-surface border border-ink/10 rounded-xl text-xs text-text-primary focus:outline-none focus:border-accent-teal focus:ring-1 focus:ring-accent-teal font-mono appearance-none cursor-pointer"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Flagged-only toggle */}
          <button
            type="button"
            onClick={() => setFlaggedOnly((v) => !v)}
            className={`px-3 py-2 rounded-xl border text-xs font-mono font-semibold transition-colors shrink-0 ${
              flaggedOnly
                ? 'bg-accent-red/15 border-accent-red/40 text-accent-red'
                : 'bg-bg-surface border-ink/10 text-text-dim hover:text-text-primary hover:border-ink/25'
            }`}
          >
            Flagged only
          </button>
        </div>

        {/* Counts & Add Person Button */}
        <div className="flex items-center gap-3 shrink-0">
          <Badge variant="teal" size="md">
            {filteredWatchlist.length} SHOWN
          </Badge>

          {totalMatches > 0 && (
            <Badge variant="red" dot pulse size="md">
              {totalMatches} DETECTIONS LOGGED
            </Badge>
          )}

          <Button
            variant="primary"
            size="sm"
            leftIcon={<Plus className="w-4 h-4" />}
            onClick={handleOpenAddModal}
          >
            Add Person
          </Button>
        </div>
      </div>

      {/* 4. Responsive Watchlist Cards Grid */}
      {filteredWatchlist.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredWatchlist.map((person) => {
            const hasMatches = person.matchCount > 0;
            const matchedRecently = Boolean(person.lastMatchedAt && Date.now() / 1000 - person.lastMatchedAt < 86400);
            const latestSighting = sightingsFor(person)[0];

            return (
              <Card
                key={person.id}
                variant="default"
                className={`flex flex-col justify-between transition-all duration-200 hover:border-text-muted/60 cursor-pointer ${
                  hasMatches ? 'border-t-2 border-t-accent-red' : ''
                }`}
                bodyClassName="p-4 space-y-3.5 flex-1 flex flex-col justify-between"
                onClick={() => setSightingsPerson(person)}
              >
                <div className="space-y-3">
                  {/* Top Photo & Identity Header */}
                  <div className="flex items-start gap-3">
                    {/* Rounded Photo */}
                    <div
                      className={`relative w-20 h-20 rounded-xl overflow-hidden bg-bg-primary shrink-0 group ${
                        matchedRecently ? 'ring-2 ring-accent-red/70' : hasMatches ? 'ring-1 ring-accent-red/30' : 'ring-1 ring-border-subtle'
                      }`}
                    >
                      <img
                        src={resolvePhotoUrl(person.photoUrl) || generateBiometricAvatarSvg(person.name, person.id, person.matchCount)}
                        alt={`Photo of ${person.name}`}
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 border border-accent-teal/20 pointer-events-none rounded-xl" />
                    </div>

                    {/* Name & Match Badge */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-1">
                        <h3 className="font-semibold text-sm text-text-primary truncate">
                          {person.name}
                        </h3>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePromptDelete(person);
                          }}
                          title="Remove from watchlist"
                          className="text-text-muted hover:text-accent-red p-1 rounded-lg hover:bg-bg-elevated transition-colors shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="mt-1">
                        {hasMatches ? (
                          <Badge variant="red" size="sm" dot pulse={matchedRecently}>
                            {person.matchCount}{' '}
                            {person.matchCount === 1 ? 'MATCH' : 'MATCHES'}
                          </Badge>
                        ) : (
                          <Badge variant="neutral" size="sm">
                            NO MATCHES YET
                          </Badge>
                        )}
                      </div>

                      {latestSighting && (
                        <div className="mt-1.5 flex items-center gap-1 text-[10px] text-text-dim font-mono truncate">
                          <Camera className="w-3 h-3 shrink-0 text-accent-teal" />
                          <span className="truncate">
                            {camMeta[latestSighting.cameraName] || latestSighting.cameraName}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Notes Excerpt */}
                  <div className="p-2 bg-bg-elevated/70 border border-border-subtle/60 rounded-lg">
                    <p className="text-xs text-text-dim line-clamp-2 leading-relaxed">
                      {person.notes || 'No intelligence notes recorded.'}
                    </p>
                  </div>
                </div>

                {/* Bottom Timestamps + Sightings CTA */}
                <div className="pt-3 border-t border-border-subtle/50 space-y-2">
                  <div className="font-mono text-[11px] text-text-muted space-y-1">
                    <div className="flex items-center justify-between">
                      <span>Enrolled:</span>
                      <span className="text-text-dim">
                        {formatRelativeTime(person.addedAt)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Last Matched:</span>
                      <span
                        className={
                          hasMatches
                            ? 'text-accent-red font-semibold'
                            : 'text-text-muted'
                        }
                      >
                        {formatRelativeTime(person.lastMatchedAt)}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSightingsPerson(person);
                    }}
                    className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-ink/10 text-[11px] font-mono font-semibold text-text-dim hover:text-accent-teal hover:border-accent-teal/40 transition-colors"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    View Sightings
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        /* 5. Empty State */
        <div className="p-12 bg-bg-surface border border-dashed border-border-subtle rounded-2xl text-center space-y-3">
          <div className="p-3 bg-bg-elevated border border-border-subtle rounded-full w-12 h-12 flex items-center justify-center mx-auto text-text-muted">
            <Users className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-primary">
              {searchQuery || flaggedOnly
                ? 'No subjects match the current filters'
                : 'No persons currently enrolled in watchlist'}
            </h3>
            <p className="text-xs text-text-dim max-w-sm mx-auto">
              Add facial profiles to the surveillance watchlist to trigger automatic alerts on detection.
            </p>
          </div>
          <div className="flex justify-center gap-2 pt-1">
            {(searchQuery || flaggedOnly) && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSearchQuery('');
                  setFlaggedOnly(false);
                }}
              >
                Clear Filters
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Plus className="w-3.5 h-3.5" />}
              onClick={handleOpenAddModal}
            >
              Add Person
            </Button>
          </div>
        </div>
      )}

      {/* 6. ADD PERSON MODAL */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        title="Enroll Person in Biometric Watchlist"
        description="Register a reference photograph to generate 512-D face embeddings for automated CCTV alerts."
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsAddModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Plus className="w-3.5 h-3.5" />}
              onClick={handleAddPersonSubmit}
            >
              Enroll Subject
            </Button>
          </>
        }
      >
        <form onSubmit={handleAddPersonSubmit} className="space-y-4">
          {formError && (
            <div className="p-2.5 bg-accent-red/15 border border-accent-red/40 rounded-lg flex items-center gap-2 text-xs text-accent-red">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          {/* Full Name */}
          <div>
            <label className="block text-xs font-mono uppercase text-text-dim mb-1">
              Full Name / Known Alias <span className="text-accent-red">*</span>
            </label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Tariq Ahmed, Vikram Singh"
              className="w-full px-3 py-2 bg-bg-elevated border border-border-subtle rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent-teal"
            />
          </div>

          {/* Photo Upload Zone & Live Preview */}
          <div>
            <label className="block text-xs font-mono uppercase text-text-dim mb-1">
              Reference Facial Photo <span className="text-accent-red">*</span>
            </label>

            {previewPhotoUrl ? (
              <div className="flex items-center gap-4 p-3 bg-bg-elevated border border-accent-teal/40 rounded-xl">
                <div className="relative w-16 h-16 rounded-lg overflow-hidden border border-border-subtle bg-bg-primary shrink-0">
                  <img
                    src={previewPhotoUrl}
                    alt="Preview"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-accent-teal font-semibold font-mono">
                    <ShieldCheck className="w-4 h-4" />
                    <span>PHOTO PREVIEW READY</span>
                  </div>
                  <span className="text-[11px] text-text-dim block">
                    Embedding vector will be generated upon confirmation.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setPreviewPhotoUrl('')}
                  className="text-text-muted hover:text-accent-red p-1"
                  title="Remove photo"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="p-4 border-2 border-dashed border-border-subtle hover:border-accent-teal/60 rounded-xl text-center transition-colors bg-bg-surface">
                <Upload className="w-6 h-6 text-text-muted mx-auto mb-2" />
                <div className="space-y-1">
                  <label className="text-xs font-medium text-accent-teal hover:underline cursor-pointer">
                    <span>Click to browse file</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handlePhotoUpload}
                      className="sr-only"
                    />
                  </label>
                </div>
                <p className="text-[10px] text-text-dim mt-1">
                  PNG, JPG, or WEBP portrait (clear frontal view recommended)
                </p>
              </div>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-mono uppercase text-text-dim mb-1">
              Intelligence Notes & Sector History
            </label>
            <textarea
              rows={3}
              value={formNotes}
              onChange={(e) => setFormNotes(e.target.value)}
              placeholder="e.g. Flagged for unauthorized border crossing attempts along North Sector fence..."
              className="w-full px-3 py-2 bg-bg-elevated border border-border-subtle rounded-lg text-xs text-text-primary focus:outline-none focus:border-accent-teal"
            />
          </div>
        </form>
      </Modal>

      {/* 7. REMOVAL CONFIRMATION MODAL */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false);
          setPersonToDelete(null);
        }}
        title="Remove Subject from Biometric Watchlist"
        description="Statutory confirmation required before purging biometric data."
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsDeleteModalOpen(false);
                setPersonToDelete(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              leftIcon={<Trash2 className="w-3.5 h-3.5" />}
              onClick={handleConfirmDelete}
            >
              Confirm Removal
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="p-3 bg-accent-red/10 border border-accent-red/30 rounded-xl text-xs text-text-primary">
            <span className="font-semibold block mb-1">
              Remove {personToDelete?.name}?
            </span>
            <span>
              This will purge the stored facial embeddings and stop real-time alert generation for this subject. This action cannot be undone.
            </span>
          </div>
        </div>
      </Modal>

      {/* 8. SIGHTINGS DETAIL MODAL — the payoff for the "N matches" badge:
          every incident the pipeline tagged with this person's name, newest
          first, with a jump straight into Alerts & Events for full evidence. */}
      <Modal
        isOpen={Boolean(sightingsPerson)}
        onClose={() => setSightingsPerson(null)}
        title={sightingsPerson ? `Sighting History — ${sightingsPerson.name}` : undefined}
        description={
          sightingsPerson
            ? `${sightingsList.length} recorded sighting${sightingsList.length === 1 ? '' : 's'} matched to this subject`
            : undefined
        }
        size="xl"
      >
        {sightingsPerson && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 p-3 bg-bg-elevated/70 border border-border-subtle/60 rounded-xl">
              <div className="w-14 h-14 rounded-lg overflow-hidden shrink-0 border border-border-subtle">
                <img
                  src={
                    resolvePhotoUrl(sightingsPerson.photoUrl) ||
                    generateBiometricAvatarSvg(sightingsPerson.name, sightingsPerson.id, sightingsPerson.matchCount)
                  }
                  alt={`Photo of ${sightingsPerson.name}`}
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-xs text-text-dim leading-relaxed">
                  {sightingsPerson.notes || 'No intelligence notes recorded.'}
                </p>
                <div className="flex items-center gap-3 text-[11px] font-mono text-text-muted">
                  <span>Enrolled {formatRelativeTime(sightingsPerson.addedAt)}</span>
                  <span>·</span>
                  <span>{sightingsPerson.matchCount} total match{sightingsPerson.matchCount === 1 ? '' : 'es'}</span>
                </div>
              </div>
            </div>

            {sightingsList.length === 0 ? (
              <div className="p-8 text-center text-xs text-text-dim font-mono border border-dashed border-border-subtle rounded-xl">
                No sightings recorded yet — this subject has not been matched by the pipeline.
              </div>
            ) : (
              <div className="space-y-2 max-h-[45vh] overflow-y-auto pr-1">
                {sightingsList.map((inc) => (
                  <button
                    key={inc.id}
                    onClick={() => navigate(`/alerts?incident=${inc.id}`)}
                    className="w-full flex items-center gap-3 p-2.5 bg-bg-surface hover:bg-bg-elevated border border-border-subtle/60 hover:border-accent-teal/40 rounded-xl transition-colors text-left"
                  >
                    <div className="w-16 h-12 rounded-lg overflow-hidden shrink-0 border border-border-subtle bg-black">
                      <EvidenceImage
                        src={apiAssetUrl(inc.cropUrl ?? inc.snapshotUrl)}
                        alt={`Evidence for sighting #${inc.id}`}
                        compact
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                        <span>{formatDateTime(inc.timestamp)}</span>
                        <Badge variant={threatStatusVariant(inc.tier)} size="sm">
                          {threatStatusLabel(inc.tier)}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-text-dim font-mono truncate">
                        <Camera className="w-3 h-3 shrink-0 text-accent-teal" />
                        <span className="truncate">
                          {camMeta[inc.cameraName] || inc.cameraName} · Score {inc.score.toFixed(0)}
                        </span>
                      </div>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-text-muted shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};
