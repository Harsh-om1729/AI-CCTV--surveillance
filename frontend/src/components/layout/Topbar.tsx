import React, { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Menu, Clock, Volume2, VolumeX, BellOff, Sun, Moon, Smartphone } from 'lucide-react';
import { AlertBell } from './AlertBell';
import { useAlerts } from '@/components/alerts/AlertProvider';
import { useSystemHealth } from '@/components/system/SystemHealthProvider';
import { useTheme } from '@/components/theme/ThemeProvider';

interface TopbarProps {
  onOpenMobileSidebar: () => void;
  systemStatus?: 'online' | 'air-gapped' | 'standby';
}

const routeTitles: Record<string, { title: string; subtitle: string }> = {
  '/': {
    title: 'Overview',
    subtitle: 'System status, camera health, and active alerts at a glance',
  },
  '/live': {
    title: 'Live Surveillance',
    subtitle: 'Multi-camera surveillance stream grid & telemetry',
  },
  '/analysis': {
    title: 'AI Detection & Analysis',
    subtitle: 'How detection, tracking, behaviour analysis and scoring work — with live numbers',
  },
  '/alerts': {
    title: 'Alerts & Events',
    subtitle: 'Real-time Person, Vehicle, and Unknown target detections & direct camera links',
  },
  '/detections': {
    title: 'Alerts & Events',
    subtitle: 'Real-time Person, Vehicle, and Unknown target detections & direct camera links',
  },
  '/cameras': {
    title: 'Camera Management',
    subtitle: 'Add, edit, test-connect and remove cameras',
  },
  '/demo': {
    title: 'Demo Mode',
    subtitle: 'Guided walkthrough of the full pipeline for a judge demo',
  },
  '/analytics': {
    title: 'Threat Intelligence Analytics',
    subtitle: 'Kinematics breakdown, peak curfew patterns, and sector metrics',
  },
  '/watchlist': {
    title: 'Watchlist',
    subtitle: 'Enrolled faces the pipeline matches against in real time',
  },
  '/settings': {
    title: 'System Health & Settings',
    subtitle: 'Pipeline, cameras, models, storage, thresholds and integrations',
  },
};

export const Topbar: React.FC<TopbarProps> = ({ onOpenMobileSidebar }) => {
  const {
    backendStatus,
    soundEnabled,
    toggleSound,
    popupsMuted,
    toggleMutePopups,
    pushEnabled,
    pushPermission,
    requestPushPermission,
    disablePush,
  } = useAlerts();
  const { cameras, health, reachable } = useSystemHealth();
  const { theme, toggleTheme } = useTheme();
  const liveCams = cameras.filter((c) => c.health === 'online' && c.source !== 'idle').length;

  // Every state here is measured. The pill used to read "Live Stream
  // Pipeline · 4/4 Online" in green regardless of what was connected.
  const pill =
    reachable === false
      ? { tone: 'text-accent-red', dot: 'bg-accent-red', text: 'Backend offline — no live data' }
      : !health
      ? { tone: 'text-text-dim', dot: 'bg-text-muted', text: 'Checking system…' }
      : !health.pipeline.running
      ? { tone: 'text-accent-yellow', dot: 'bg-accent-yellow', text: 'AI pipeline stopped · no alerts' }
      : {
          tone: health.status === 'ok' ? 'text-accent-green' : 'text-accent-yellow',
          dot: health.status === 'ok' ? 'bg-accent-green' : 'bg-accent-yellow',
          text: `AI live · ${liveCams}/${cameras.length} cameras · alerts ${
            backendStatus === 'connected' ? 'connected' : 'reconnecting'
          }`,
        };
  const location = useLocation();
  const [currentTime, setCurrentTime] = useState<string>('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const timeStr = now.toLocaleTimeString('en-GB', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });
      const dateStr = now.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
      setCurrentTime(`${dateStr} · ${timeStr}`);
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const currentRouteInfo = routeTitles[location.pathname] || {
    title: 'Command Center',
    subtitle: 'Border surveillance intelligence console',
  };

  return (
    <header className="sticky top-0 z-30 h-16 bg-bg-primary/95 backdrop-blur-xl border-b border-border-subtle px-4 lg:px-6 flex items-center justify-between">
      {/* Left: Mobile Toggle & Page Title */}
      <div className="flex items-center gap-3">
        <button
          onClick={onOpenMobileSidebar}
          aria-label="Open navigation menu"
          className="lg:hidden p-2 rounded-xl text-text-dim hover:text-text-primary hover:bg-ink/[0.04] transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div>
          <h1 className="text-base font-bold text-text-primary tracking-tight flex items-center gap-2">
            <span>{currentRouteInfo.title}</span>
          </h1>
          <p className="hidden sm:block text-xs text-text-dim truncate max-w-md">
            {currentRouteInfo.subtitle}
          </p>
        </div>
      </div>

      {/* Center: Status Pill (Clean, no ping animation) */}
      <div
        role="status"
        aria-live="polite"
        className={`hidden md:flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-bg-surface border border-border-subtle text-xs font-semibold ${pill.tone}`}
      >
        <span className={`inline-flex rounded-full h-2 w-2 ${pill.dot}`} />
        <span>{pill.text}</span>
      </div>

      {/* Right: Quick Actions */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* 3D Clock */}
        <div className="hidden xl:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-bg-surface border border-border-subtle text-xs text-text-dim font-mono">
          <Clock className="w-3.5 h-3.5 text-accent-teal" />
          <span>{currentTime || 'Syncing...'}</span>
        </div>

        {/* Light / Dark Theme Toggle */}
        <button
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="p-2 rounded-xl transition-colors border border-transparent text-text-muted hover:text-text-primary hover:bg-ink/[0.04]"
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        {/* Audio Alert Toggle */}
        <button
          onClick={toggleSound}
          aria-label={soundEnabled ? 'Mute alert sounds' : 'Enable alert sounds'}
          className={`p-2 rounded-xl transition-colors border ${
            soundEnabled
              ? 'text-accent-teal bg-accent-teal/10 border-accent-teal/30'
              : 'text-text-muted hover:text-text-primary hover:bg-ink/[0.04] border-transparent'
          }`}
          title={soundEnabled ? 'Alert Audio: Active' : 'Alert Audio: Muted'}
        >
          {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
        </button>

        {/* Mute On-Screen Notification Popups Toggle */}
        <button
          onClick={toggleMutePopups}
          aria-label={popupsMuted ? 'Show on-screen popup notifications' : 'Mute on-screen popup notifications'}
          className={`px-2.5 py-1.5 rounded-xl transition-colors border flex items-center gap-1.5 ${
            popupsMuted
              ? 'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/30'
              : 'text-text-muted hover:text-text-primary hover:bg-ink/[0.04] border-border-subtle'
          }`}
          title={popupsMuted ? 'Screen Popups Muted (Click to show on screen)' : 'Mute screen popups (Alerts stay silent in background)'}
        >
          <BellOff className="w-4 h-4" />
          <span className="hidden md:inline text-[11px] font-mono font-medium">
            {popupsMuted ? 'Popups Muted' : 'Mute Popups'}
          </span>
        </button>

        {/* Native Mobile/OS Push Notifications: off by default, opt-in only
            (a permission prompt firing on page load with no user action is
            a bad first impression and some browsers block it outright).
            Hidden entirely when the API isn't available at all, rather than
            shown disabled — nothing the operator can do about that here. */}
        {pushPermission !== 'unsupported' && (
          <button
            onClick={() => {
              if (pushPermission === 'denied') return;
              if (pushEnabled) {
                disablePush();
              } else {
                void requestPushPermission();
              }
            }}
            aria-label={
              pushPermission === 'denied'
                ? 'Mobile alerts blocked in browser settings'
                : pushEnabled
                ? 'Disable mobile push alerts'
                : 'Enable mobile push alerts'
            }
            disabled={pushPermission === 'denied'}
            className={`px-2.5 py-1.5 rounded-xl transition-colors border flex items-center gap-1.5 ${
              pushPermission === 'denied'
                ? 'text-text-muted/50 border-transparent cursor-not-allowed'
                : pushEnabled
                ? 'text-accent-teal bg-accent-teal/10 border-accent-teal/30'
                : 'text-text-muted hover:text-text-primary hover:bg-ink/[0.04] border-border-subtle'
            }`}
            title={
              pushPermission === 'denied'
                ? 'Blocked — re-enable notifications for this site in your browser settings'
                : pushEnabled
                ? 'Mobile Alerts: on — this device gets a lock-screen/notification-shade alert when the tab is backgrounded'
                : 'Mobile Alerts: off — enable to get a lock-screen/notification-shade alert when this tab is backgrounded'
            }
          >
            <Smartphone className="w-4 h-4" />
            <span className="hidden md:inline text-[11px] font-mono font-medium">
              {pushPermission === 'denied' ? 'Blocked' : pushEnabled ? 'Mobile Alerts On' : 'Mobile Alerts'}
            </span>
          </button>
        )}


        {/* Alerts Notification Bell */}
        <AlertBell />
      </div>
    </header>
  );
};

