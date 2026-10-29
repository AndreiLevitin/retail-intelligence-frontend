import { useState } from 'react'
import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar.tsx'
import { TopBar } from './TopBar.tsx'

/**
 * Conventional enterprise portal shell: sidebar left, top bar above the
 * workspace. On tablet the sidebar collapses into a drawer and the workspace
 * takes the full width.
 */
export function AppShell({ children, page, onNavigate }: { children: ReactNode; page: 'Dashboard' | 'Video demo'; onNavigate: (page: 'Dashboard' | 'Video demo') => void }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="min-h-screen bg-page">
      <div className="flex">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} page={page} onNavigate={onNavigate} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((open) => !open)} />
          <main className="min-w-0 flex-1 p-4 lg:p-6">{children}</main>
        </div>
      </div>
    </div>
  )
}
