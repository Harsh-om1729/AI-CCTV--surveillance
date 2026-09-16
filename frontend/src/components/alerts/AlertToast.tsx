import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAlerts } from './AlertProvider';
import { threatStatusLabel } from '@/lib/threatStatus';
import {
  AlertTriangle,
  ShieldAlert,
  X,
  Eye,
  CheckCircle2,
  User,
  Car,
  HelpCircle,
  BellOff,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

export const AlertToastContainer: React.FC = () => {
  const {
    activeToasts,
    dismissToast,
    acknowledgeAlert,
    unreadCount,
    popupsMuted,
    toggleMutePopups,
  } = useAlerts();
  const navigate = useNavigate();

  // If popups are muted or no active toasts, render nothing on screen
  if (popupsMuted || activeToasts.length === 0) {
    return null;
  }

  const overflowCount = Math.max(0, unreadCount - activeToasts.length);

  const getCategoryLabel = (category: string) => {
    switch (category) {
      case 'person':
        return 'Person Detection';
      case 'vehicle':
        return 'Vehicle Detection';
      default:
        return 'Unknown Detection';
    }
  };

  return (
    <div
      aria-live="assertive"
      // Mobile: a full-width banner pinned near the top of the screen (the
      // iOS-notification look) so it reads as a heads-up alert rather than a
      // small corner toast that's easy to miss on a phone. Desktop keeps the
      // original top-right corner stack.
      className="fixed top-2 inset-x-2 sm:top-20 sm:inset-x-auto sm:right-6 z-50 flex flex-col gap-2.5 w-auto sm:max-w-sm sm:w-full pointer-events-none transition-all"
    >
      {activeToasts.map((toast) => {
        const isRed = toast.tier === 'red';

        return (
          <div
            key={toast.id}
            className={`pointer-events-auto rounded-xl transition-colors duration-150 ${
              isRed
                ? 'bg-bg-surface border border-accent-red/50 shadow-2xl'
                : 'bg-bg-surface border border-accent-yellow/50 shadow-2xl'
            } p-3.5 relative overflow-hidden`}
          >
            {/* Countdown bar for yellow alerts (6s) */}
            {!isRed && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-ink/10 overflow-hidden">
                <div
                  className="h-full bg-accent-yellow transition-all linear"
                  style={{
                    animation: 'shrinkBar 6s linear forwards',
                  }}
                />
              </div>
            )}

            {/* Header: Tier + Camera + Mute Popups + Close Button */}
            <div className="flex items-center justify-between gap-2 mb-2 pb-1.5 border-b border-ink/[0.08]">
              <div className="flex items-center gap-2">
                {isRed ? (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-accent-red/15 text-accent-red font-mono text-[10px] font-bold tracking-wider border border-accent-red/30">
                    <ShieldAlert className="w-3 h-3" />
                    {threatStatusLabel('red').toUpperCase()}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-accent-yellow/15 text-accent-yellow font-mono text-[10px] font-medium tracking-wider border border-accent-yellow/30">
                    <AlertTriangle className="w-3 h-3" />
                    {threatStatusLabel('yellow').toUpperCase()}
                  </span>
                )}

                <span className="font-mono text-xs font-bold text-text-primary uppercase tracking-wider">
                  {toast.cameraName}
                </span>
              </div>


              <div className="flex items-center gap-1">
                {/* Mute Popups Option */}
                <button
                  onClick={toggleMutePopups}
                  title="Mute popup notifications (won't show on screen)"
                  className="px-2 py-1.5 sm:px-1.5 sm:py-0.5 rounded text-text-dim hover:text-accent-yellow hover:bg-ink/[0.08] transition-colors flex items-center gap-1 text-[10px] font-mono border border-ink/10"
                >
                  <BellOff className="w-3 h-3" />
                  <span>Mute</span>
                </button>

                <button
                  onClick={() => dismissToast(toast.id)}
                  aria-label="Dismiss alert"
                  className="p-2 sm:p-1 rounded text-text-dim hover:text-text-primary hover:bg-ink/[0.08] transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Main content body */}
            <div className="flex items-start gap-2.5 my-1.5">
              {/* Category Icon */}
              <div
                className={`p-2 rounded-lg shrink-0 border ${
                  isRed
                    ? 'bg-accent-red/15 text-accent-red border-accent-red/30'
                    : 'bg-accent-yellow/15 text-accent-yellow border-accent-yellow/30'
                }`}
              >
                {toast.category === 'person' && <User className="w-4 h-4" />}
                {toast.category === 'vehicle' && <Car className="w-4 h-4" />}
                {toast.category === 'unknown' && <HelpCircle className="w-4 h-4" />}
              </div>

              <div className="flex-1 min-w-0">
                <span className="text-text-primary font-semibold text-[11px] tracking-tight">
                  {getCategoryLabel(toast.category)}
                </span>

                {/* Why this fired, in plain language — an operator (or a
                    judge watching over their shoulder) should be able to
                    tell what's wrong without reading a score breakdown. */}
                <p className="text-[11px] text-text-primary/90 mt-1 leading-snug line-clamp-2">
                  {toast.whatHeIsDoing ||
                    `${getCategoryLabel(toast.category)} in the ${
                      toast.zoneTier && toast.zoneTier !== 'none' ? toast.zoneTier.toUpperCase() : toast.tier.toUpperCase()
                    } zone.`}
                </p>

                <div className="text-[10px] text-text-dim mt-1 flex items-center justify-between font-mono">
                  <span>Sector Zone: {toast.zoneTier || toast.tier}</span>
                  <span className="text-accent-teal">#{toast.reidGalleryId}</span>
                </div>
              </div>
            </div>

            {/* Action Buttons Footer */}
            <div className="mt-2.5 pt-2 border-t border-ink/[0.08] flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => acknowledgeAlert(toast.id)}
                className="text-[11px] h-9 sm:h-7 px-2.5 text-text-dim hover:text-text-primary"
              >
                <CheckCircle2 className="w-3 h-3 mr-1" />
                Acknowledge
              </Button>
              <Button
                variant={isRed ? 'danger' : 'secondary'}
                size="sm"
                onClick={() => {
                  acknowledgeAlert(toast.id);
                  navigate(`/detections?incident=${toast.id}`);
                }}
                className="text-[11px] h-9 sm:h-7 px-2.5 font-semibold shadow-sm"
              >
                <Eye className="w-3 h-3 mr-1" />
                View Evidence
              </Button>
            </div>
          </div>
        );
      })}

      {/* Overflow indicator */}
      {overflowCount > 0 && (
        <div className="pointer-events-auto self-end">
          <Badge
            variant="neutral"
            size="sm"
            onClick={() => navigate('/detections')}
            className="cursor-pointer hover:bg-ink/[0.08] transition-colors border border-ink/15 font-mono text-[10px]"
          >
            +{overflowCount} more unread alerts →
          </Badge>
        </div>
      )}

      {/* Embedded CSS animation for countdown bar */}
      <style>{`
        @keyframes shrinkBar {
          from { width: 100%; }
          to { width: 0%; }
        }
      `}</style>
    </div>
  );
};
