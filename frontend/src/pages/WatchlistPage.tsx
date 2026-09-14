import React, { useState, useEffect, useMemo } from 'react';
import {
  WatchlistPerson,
  generateBiometricAvatarSvg,
} from '@/lib/mockWatchlist';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import {
  Users,
  Search,
  Plus,
  Trash2,
  AlertTriangle,
  ShieldCheck,
  Upload,
  CheckCircle2,
  X,
  AlertCircle,
} from 'lucide-react';

import { watchlistApi } from '@/lib/api';
import { DataSourceBadge } from '@/components/ui/DataSourceBadge';

const WATCHLIST_STORAGE_KEY = 'ibvap_watchlist_data';

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

export const WatchlistPage: React.FC = () => {
  const [watchlist, setWatchlist] = useState<WatchlistPerson[]>(loadStoredWatchlist);
  const [isMock, setIsMock] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
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

  // Filtered by Name Search
  const filteredWatchlist = useMemo(() => {
    if (!searchQuery.trim()) return watchlist;
    const q = searchQuery.toLowerCase().trim();
    return watchlist.filter((p) => p.name.toLowerCase().includes(q));
  }, [watchlist, searchQuery]);

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
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 bg-bg-surface border border-accent-teal/50 rounded-sm shadow-2xl font-mono text-xs text-text-primary animate-in fade-in slide-in-from-bottom-2">
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

      {/* 2. Top Filter & Action Bar */}
      <div className="card-3d flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-gradient-to-b from-bg-surface to-bg-primary border border-ink/10 rounded-2xl shadow-[0_15px_35px_rgba(0,0,0,0.8)]">
        {/* Search Input */}
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-text-muted absolute left-3 top-2.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search watchlist subjects by name..."
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

        {/* Counts & Add Person Button */}
        <div className="flex items-center gap-3">
          <Badge variant="teal" size="md">
            {watchlist.length} ENROLLED SUBJECTS
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

      {/* 3. Responsive Watchlist Cards Grid */}
      {filteredWatchlist.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredWatchlist.map((person) => {
            const hasMatches = person.matchCount > 0;

            return (
              <Card
                key={person.id}
                variant="default"
                className={`flex flex-col justify-between transition-all duration-200 hover:border-text-muted/60 ${
                  hasMatches ? 'border-t-2 border-t-accent-red' : ''
                }`}
                bodyClassName="p-4 space-y-3.5 flex-1 flex flex-col justify-between"
              >
                <div className="space-y-3">
                  {/* Top Photo & Identity Header */}
                  <div className="flex items-start gap-3">
                    {/* Rounded Photo */}
                    <div className="relative w-16 h-16 rounded-md overflow-hidden bg-bg-primary border border-border-subtle shrink-0 group">
                      <img
                        src={person.photoUrl || generateBiometricAvatarSvg(person.name, person.id, person.matchCount)}
                        alt={`Photo of ${person.name}`}
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 border border-accent-teal/20 pointer-events-none rounded-md" />
                    </div>

                    {/* Name & Match Badge */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-1">
                        <h3 className="font-semibold text-sm text-text-primary truncate">
                          {person.name}
                        </h3>
                        <button
                          onClick={() => handlePromptDelete(person)}
                          title="Remove from watchlist"
                          className="text-text-muted hover:text-accent-red p-1 rounded-sm hover:bg-bg-elevated transition-colors shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="mt-1">
                        {hasMatches ? (
                          <Badge variant="red" size="sm" dot pulse>
                            {person.matchCount}{' '}
                            {person.matchCount === 1 ? 'MATCH' : 'MATCHES'}
                          </Badge>
                        ) : (
                          <Badge variant="neutral" size="sm">
                            NO MATCHES YET
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Notes Excerpt */}
                  <div className="p-2 bg-bg-elevated/70 border border-border-subtle/60 rounded-sm">
                    <p className="text-xs text-text-dim line-clamp-2 leading-relaxed">
                      {person.notes || 'No intelligence notes recorded.'}
                    </p>
                  </div>
                </div>

                {/* Bottom Timestamps */}
                <div className="pt-3 border-t border-border-subtle/50 font-mono text-[11px] text-text-muted space-y-1">
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
              </Card>
            );
          })}
        </div>
      ) : (
        /* 4. Empty State */
        <div className="p-12 bg-bg-surface border border-dashed border-border-subtle rounded-sm text-center space-y-3">
          <div className="p-3 bg-bg-elevated border border-border-subtle rounded-full w-12 h-12 flex items-center justify-center mx-auto text-text-muted">
            <Users className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-primary">
              {searchQuery
                ? `No subjects match "${searchQuery}"`
                : 'No persons currently enrolled in watchlist'}
            </h3>
            <p className="text-xs text-text-dim max-w-sm mx-auto">
              Add facial profiles to the surveillance watchlist to trigger automatic alerts on detection.
            </p>
          </div>
          <div className="flex justify-center gap-2 pt-1">
            {searchQuery && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSearchQuery('')}
              >
                Clear Search
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

      {/* 5. ADD PERSON MODAL */}
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
            <div className="p-2.5 bg-accent-red/15 border border-accent-red/40 rounded-sm flex items-center gap-2 text-xs text-accent-red">
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
              className="w-full px-3 py-2 bg-bg-elevated border border-border-subtle rounded-sm text-sm text-text-primary focus:outline-none focus:border-accent-teal"
            />
          </div>

          {/* Photo Upload Zone & Live Preview */}
          <div>
            <label className="block text-xs font-mono uppercase text-text-dim mb-1">
              Reference Facial Photo <span className="text-accent-red">*</span>
            </label>

            {previewPhotoUrl ? (
              <div className="flex items-center gap-4 p-3 bg-bg-elevated border border-accent-teal/40 rounded-sm">
                <div className="relative w-16 h-16 rounded overflow-hidden border border-border-subtle bg-bg-primary shrink-0">
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
              <div className="p-4 border-2 border-dashed border-border-subtle hover:border-accent-teal/60 rounded-sm text-center transition-colors bg-bg-surface">
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
              className="w-full px-3 py-2 bg-bg-elevated border border-border-subtle rounded-sm text-xs text-text-primary focus:outline-none focus:border-accent-teal"
            />
          </div>
        </form>
      </Modal>

      {/* 6. REMOVAL CONFIRMATION MODAL */}
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
          <div className="p-3 bg-accent-red/10 border border-accent-red/30 rounded-sm text-xs text-text-primary">
            <span className="font-semibold block mb-1">
              Remove {personToDelete?.name}?
            </span>
            <span>
              This will purge the stored facial embeddings and stop real-time alert generation for this subject. This action cannot be undone.
            </span>
          </div>
        </div>
      </Modal>
    </div>
  );
};
