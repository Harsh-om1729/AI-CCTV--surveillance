import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAlerts } from '@/components/alerts/AlertProvider';
import { threatStatusLabel } from '@/lib/threatStatus';
import {
  Bell,
  BellOff,
  CheckCheck,
  Radio,
  ExternalLink,
  User,
  Car,
  HelpCircle,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

export const AlertBell: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const {
    alerts,
    unreadCount,
    markAllAsRead,
    acknowledgeAlert,
    popupsMuted,
    toggleMutePopups,
  } = useAlerts();
  const dropdownRef = useRef<HTMLDivElement>(null);
  // The mobile panel is rendered via a portal (see the return below — it has
  // to escape Topbar's backdrop-blur, which creates a CSS containing block
  // that would otherwise clip a `fixed inset-0` child to the 64px header
  // instead of the viewport). A portaled node is not a DOM descendant of
  // dropdownRef, so the click-outside check below needs its own ref to
  // avoid treating every click inside the mobile drawer as "outside".
  const mobilePanelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideDesktop = dropdownRef.current?.contains(target);
      const insideMobile = mobilePanelRef.current?.contains(target);
      if (!insideDesktop && !insideMobile) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Relative timestamp formatting
  const formatTimeAgo = (timestampSec: number) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const diff = Math.max(0, nowSec - timestampSec);

    if (diff < 15) return 'Just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return new Date(timestampSec * 1000).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const recentAlerts = alerts.slice(0, 10);

  // Shared between the desktop dropdown and the mobile drawer so the two
  // surfaces can't drift out of sync with each other.
  const renderHeader = () => (
    <div className="p-3.5 bg-bg-primary border-b border-ink/[0.08] flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-bold tracking-wider text-text-primary flex items-center gap-1.5">
          <Radio className="w-3.5 h-3.5 text-accent-teal" />
          TACTICAL ALERTS
        </span>
        {unreadCount > 0 && (
          <Badge variant="red" size="sm">
            {unreadCount} NEW
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* Mute Popups Quick Option in Notification Center */}
        <button
          onClick={toggleMutePopups}
          className={`flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
            popupsMuted
              ? 'bg-accent-yellow/20 text-accent-yellow border-accent-yellow/40'
              : 'text-text-dim border-ink/10 hover:text-text-primary hover:bg-ink/[0.05]'
          }`}
          title="Mute on-screen popups"
        >
          <BellOff className="w-3 h-3" />
          <span>{popupsMuted ? 'Muted' : 'Mute'}</span>
        </button>

        {unreadCount > 0 && (
          <button
            onClick={markAllAsRead}
            className="flex items-center gap-1 text-[11px] font-mono text-text-dim hover:text-accent-teal transition-colors"
            title="Mark all alerts as read"
          >
            <CheckCheck className="w-3.5 h-3.5" />
            Clear
          </button>
        )}
      </div>
    </div>
  );

  const renderAlertList = (containerClassName: string) => (
    <div className={containerClassName}>
      {recentAlerts.length === 0 ? (
        <div className="p-6 text-center text-text-dim text-xs font-mono">
          No telemetry alerts recorded yet.
        </div>
      ) : (
        recentAlerts.map((alert) => {
          const isRed = alert.tier === 'red';
          const isYellow = alert.tier === 'yellow';

          return (
            <div
              key={alert.id}
              onClick={() => {
                acknowledgeAlert(alert.id);
                setIsOpen(false);
                navigate(`/live?camera=${alert.cameraName}`);
              }}
              className={`p-3 hover:bg-ink/[0.06] transition-colors cursor-pointer flex items-start gap-2.5 ${
                isRed ? 'bg-accent-red/5' : ''
              }`}
            >
              {/* Category / Alert Icon */}
              <div
                className={`p-1.5 rounded-lg mt-0.5 shrink-0 border ${
                  isRed
                    ? 'bg-accent-red/20 text-accent-red border-accent-red/30'
                    : isYellow
                    ? 'bg-accent-yellow/20 text-accent-yellow border-accent-yellow/30'
                    : 'bg-accent-green/20 text-accent-green border-accent-green/30'
                }`}
              >
                {alert.category === 'person' && <User className="w-3.5 h-3.5" />}
                {alert.category === 'vehicle' && <Car className="w-3.5 h-3.5" />}
                {alert.category === 'unknown' && <HelpCircle className="w-3.5 h-3.5" />}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs font-bold text-text-primary uppercase">
                      {alert.cameraName}
                    </span>
                    <span
                      className={`px-1.5 py-0.2 rounded font-mono text-[9px] font-bold ${
                        isRed
                          ? 'bg-accent-red/20 text-accent-red border border-accent-red/30'
                          : isYellow
                          ? 'bg-accent-yellow/20 text-accent-yellow border border-accent-yellow/30'
                          : 'bg-accent-green/20 text-accent-green border border-accent-green/30'
                      }`}
                    >
                      {threatStatusLabel(alert.tier)}
                    </span>
                  </div>
                  <span className="font-mono text-[10px] text-text-dim shrink-0">
                    {formatTimeAgo(alert.timestamp)}
                  </span>
                </div>

                <div className="text-[11px] text-text-dim mt-1 flex items-center justify-between">
                  <span className="font-semibold text-text-primary">
                    {alert.category === 'person'
                      ? 'Person Detection'
                      : alert.category === 'vehicle'
                      ? 'Vehicle Detection'
                      : 'Unknown Detection'}
                  </span>
                  <span
                    className={`font-mono font-bold text-[10px] ${
                      isRed
                        ? 'text-accent-red'
                        : isYellow
                        ? 'text-accent-yellow'
                        : 'text-text-dim'
                    }`}
                  >
                    SCORE: {alert.score.toFixed(1)}
                  </span>
                </div>

                {/* Threat formula breakdown — full, not just S/T/K/C (see
                    AlertToast.tsx for why: D/L/G alone can separate two
                    same-zone, same-S/T/K/C alerts into different tiers). */}
                {alert.breakdown && (
                  <div className="text-[10px] font-mono text-text-muted mt-0.5 flex items-center justify-between">
                    <span>
                      S:{alert.breakdown.sectorRisk} T:{alert.breakdown.timeRisk} K:{alert.breakdown.kinematicsRisk} C:{alert.breakdown.classConfidence}
                      {!!alert.breakdown.directionRisk && ` D:${alert.breakdown.directionRisk}`}
                      {!!alert.breakdown.loiterRisk && ` L:${alert.breakdown.loiterRisk}`}
                      {!!alert.breakdown.groupRisk && ` G:${alert.breakdown.groupRisk}`}
                    </span>
                    <span className="text-accent-teal font-semibold">#{alert.reidGalleryId}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );

  const renderFooter = () => (
    <div className="p-2.5 bg-ink/[0.02] border-t border-ink/[0.08] flex items-center justify-center">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setIsOpen(false);
          navigate('/detections');
        }}
        className="w-full text-xs text-text-dim hover:text-accent-teal justify-center font-mono"
      >
        <span>View All in Detections Feed</span>
        <ExternalLink className="w-3 h-3 ml-1.5" />
      </Button>
    </div>
  );

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell Trigger Button */}
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label="Open notifications center"
        className={`relative p-2 rounded-xl text-text-dim hover:text-text-primary hover:bg-ink/[0.08] transition-colors border ${
          isOpen
            ? 'bg-ink/[0.08] text-text-primary border-ink/20'
            : 'border-transparent'
        }`}
      >
        <Bell className="w-4 h-4" />

        {/* Indicator & Badge when unread > 0 */}
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-4 px-1 items-center justify-center rounded-full bg-accent-red text-white text-[10px] font-mono font-bold shadow-md">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown Panel — desktop only. The mobile drawer below is a
          separate, portaled render of the same data (see comment there). */}
      {isOpen && (
        <div className="hidden sm:block absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl bg-bg-surface border border-ink/10 shadow-2xl z-50 overflow-hidden backdrop-blur-2xl">
          {renderHeader()}
          {renderAlertList('max-h-72 overflow-y-auto divide-y divide-ink/[0.06]')}
          {renderFooter()}
        </div>
      )}

      {/* Mobile drawer: full-screen, portaled to document.body. Portaled
          because AlertBell renders inside Topbar's <header>, which has
          backdrop-blur-xl — backdrop-filter establishes a CSS containing
          block for fixed-position descendants, so a `fixed inset-0` child
          left in place here would be clipped to the 64px header instead of
          covering the viewport. Portaling to body sidesteps that. Needs its
          own explicit close button: with no on-screen area outside the
          drawer to click, the existing click-outside handler has nothing to
          catch (mobilePanelRef exempts clicks inside it from closing). */}
      {isOpen &&
        createPortal(
          <div
            ref={mobilePanelRef}
            className="sm:hidden fixed inset-0 z-50 bg-bg-surface flex flex-col"
          >
            <div className="relative">
              {renderHeader()}
              <button
                onClick={() => setIsOpen(false)}
                aria-label="Close notifications"
                className="absolute top-3 right-3.5 p-2 rounded-lg text-text-dim hover:text-text-primary hover:bg-ink/[0.08] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {renderAlertList('flex-1 overflow-y-auto divide-y divide-ink/[0.06]')}
            {renderFooter()}
          </div>,
          document.body
        )}
    </div>
  );
};
