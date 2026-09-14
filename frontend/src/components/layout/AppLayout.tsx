import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { AlertToastContainer } from '@/components/alerts/AlertToast';

export const AppLayout: React.FC = () => {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex relative">
      {/* Global Real-time Alert Toasts */}
      <AlertToastContainer />

      {/* Sidebar */}
      <Sidebar
        isOpen={mobileSidebarOpen}
        onClose={() => setMobileSidebarOpen(false)}
      />

      {/* Main Content Viewport */}
      <div className="flex-1 flex flex-col min-w-0 lg:pl-64 relative">
        {/* Topbar */}
        <Topbar
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          systemStatus="online"
        />

        {/* Scrollable Page Content Area */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto bg-tactical-grid relative">
          <div className="max-w-7xl mx-auto w-full">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
};

