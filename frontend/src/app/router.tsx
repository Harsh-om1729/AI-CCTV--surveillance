import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { AuthProvider } from '@/components/auth/AuthProvider';
import { AlertProvider } from '@/components/alerts/AlertProvider';
import { SystemHealthProvider } from '@/components/system/SystemHealthProvider';
import { AppLayout } from '@/components/layout/AppLayout';
import { DashboardPage } from '@/pages/DashboardPage';
import { LiveFeedsPage } from '@/pages/LiveFeedsPage';
import { AiAnalysisPage } from '@/pages/AiAnalysisPage';
import { IncidentsPage } from '@/pages/IncidentsPage';
import { CameraManagementPage } from '@/pages/CameraManagementPage';
import { DemoModePage } from '@/pages/DemoModePage';
import { ZonesPage } from '@/pages/ZonesPage';
import { AnalyticsPage } from '@/pages/AnalyticsPage';
import { WatchlistPage } from '@/pages/WatchlistPage';
import { SettingsPage } from '@/pages/SettingsPage';

export const AppRouter = () => {
  return (
    <ThemeProvider>
      <AuthProvider>
        <SystemHealthProvider>
          <AlertProvider>
            <BrowserRouter>
              <Routes>
                {/* Command Center Operations — the 6 primary sections
                    (Overview, Live Surveillance, AI Detection & Analysis,
                    Alerts & Events, Camera Management, Demo Mode), plus the
                    secondary tools (Watchlist, Analytics, Settings). */}
                <Route element={<AppLayout />}>
                  <Route path="/" element={<DashboardPage />} />
                  <Route path="/live" element={<LiveFeedsPage />} />
                  <Route path="/analysis" element={<AiAnalysisPage />} />
                  <Route path="/alerts" element={<IncidentsPage />} />
                  {/* Kept mounted (not a redirect) so existing deep links with
                      a ?incident= query param keep working unchanged. */}
                  <Route path="/detections" element={<IncidentsPage />} />
                  <Route path="/cameras" element={<CameraManagementPage />} />
                  <Route path="/demo" element={<DemoModePage />} />
                  <Route path="/zones" element={<ZonesPage />} />
                  <Route path="/analytics" element={<AnalyticsPage />} />
                  <Route path="/watchlist" element={<WatchlistPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                </Route>

                {/* Login is a role selector, not authentication (see AuthProvider):
                    every visitor is already signed in, so the page has no job. */}
                <Route path="/login" element={<Navigate to="/" replace />} />
                <Route path="/incidents" element={<Navigate to="/alerts" replace />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </BrowserRouter>
          </AlertProvider>
        </SystemHealthProvider>
      </AuthProvider>
    </ThemeProvider>
  );
};
