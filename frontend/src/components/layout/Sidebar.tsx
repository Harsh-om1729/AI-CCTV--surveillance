import React from 'react';
import { useSystemHealth } from '@/components/system/SystemHealthProvider';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Video,
  AlertTriangle,
  BarChart3,
  Shield,
  X,
  User,
  Server,
  ScanEye,
  Camera,
  Play,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

interface NavItem {
  label: string;
  to: string;
  icon: React.ElementType;
  badge?: string;
}

// The 6 sections the system is organized around, in the order data actually
// flows through the pipeline (see the Overview page's stage strip).
const primaryNavItems: NavItem[] = [
  { label: 'Overview', to: '/', icon: LayoutDashboard },
  // Badge is filled in from live camera status at render time.
  { label: 'Live Surveillance', to: '/live', icon: Video },
  { label: 'AI Detection & Analysis', to: '/analysis', icon: ScanEye },
  { label: 'Alerts & Events', to: '/alerts', icon: AlertTriangle },
  { label: 'Camera Management', to: '/cameras', icon: Camera },
  { label: 'Demo Mode', to: '/demo', icon: Play },
];

// Supporting tools — real, working features that aren't part of the 6
// primary sections a first-time viewer needs, kept one tap away.
const secondaryNavItems: NavItem[] = [
  { label: 'Watchlist', to: '/watchlist', icon: User },
  { label: 'Analytics', to: '/analytics', icon: BarChart3 },
  { label: 'System Health', to: '/settings', icon: Server },
];

function renderNavItem(item: NavItem, camBadge: string | undefined, onClose: () => void) {
  const Icon = item.icon;
  return (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.to === '/'}
      onClick={onClose}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors select-none',
          isActive
            ? 'bg-bg-elevated text-text-primary font-semibold border-l-2 border-accent-teal'
            : 'text-text-dim hover:text-text-primary hover:bg-ink/[0.04]'
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cn(
              'w-4 h-4 shrink-0 transition-colors',
              isActive ? 'text-accent-teal' : 'text-text-muted group-hover:text-text-primary'
            )}
          />
          <span className="flex-1 truncate">{item.label}</span>

          {(item.to === '/live' ? camBadge : item.badge) && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-bg-elevated text-text-dim border border-ink/10">
              {item.to === '/live' ? camBadge : item.badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, onClose }) => {
  const { cameras, health, reachable } = useSystemHealth();
  const liveCams = cameras.filter((c) => c.health === 'online' && c.source !== 'idle').length;
  const camBadge = cameras.length ? `${liveCams}/${cameras.length} CAM` : undefined;

  const footer =
    reachable === false
      ? { dot: 'bg-accent-red', text: 'Backend offline' }
      : !health
      ? { dot: 'bg-text-muted', text: 'Checking…' }
      : health.status === 'ok'
      ? { dot: 'bg-accent-green', text: 'All systems OK' }
      : health.status === 'degraded'
      ? { dot: 'bg-accent-yellow', text: 'Camera degraded' }
      : { dot: 'bg-accent-yellow', text: 'AI pipeline stopped' };

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={cn(
          'fixed top-0 bottom-0 left-0 z-40 w-64 bg-bg-primary border-r border-border-subtle flex flex-col transition-transform duration-200 ease-in-out lg:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Brand / Header */}
        <div className="h-16 px-5 flex items-center justify-between border-b border-border-subtle bg-bg-primary">
          <NavLink to="/" className="flex items-center gap-3 group" onClick={onClose}>
            <div className="w-9 h-9 rounded-xl bg-bg-elevated border border-ink/10 flex items-center justify-center text-accent-teal">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 font-bold tracking-tight text-base text-text-primary">
                <span>IBVAP</span>
                <span className="text-[10px] font-bold px-2 py-0.5 bg-accent-teal/15 text-accent-teal rounded-full border border-accent-teal/30">
                  AI
                </span>
              </div>
              <div className="text-[11px] text-text-dim leading-none mt-0.5">
                Tactical Command
              </div>
            </div>
          </NavLink>

          {/* Close button on mobile */}
          <button
            onClick={onClose}
            aria-label="Close sidebar navigation"
            className="lg:hidden p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-ink/[0.04] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation List */}
        <nav className="flex-1 px-3 py-5 space-y-1.5 overflow-y-auto">
          <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-widest text-text-muted">
            Command Center
          </div>
          {primaryNavItems.map((item) => renderNavItem(item, camBadge, onClose))}

          <div className="px-3 pt-4 pb-2 text-[10px] font-bold uppercase tracking-widest text-text-muted">
            More Tools
          </div>
          {secondaryNavItems.map((item) => renderNavItem(item, camBadge, onClose))}
        </nav>

        {/* Simple System Status Footer */}
        <div className="p-3.5 border-t border-border-subtle bg-bg-primary flex items-center justify-between text-xs font-mono">
          <NavLink
            to="/settings"
            onClick={onClose}
            className="flex items-center gap-1.5 text-text-muted hover:text-text-primary"
            title="Open system health"
          >
            <span className={`w-1.5 h-1.5 rounded-full inline-block ${footer.dot}`} />
            {footer.text}
          </NavLink>
          <span className="text-[10px] text-text-dim">IBVAP Core</span>
        </div>
      </aside>

    </>
  );
};
