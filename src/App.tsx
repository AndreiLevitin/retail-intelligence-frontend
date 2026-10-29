import { useState } from 'react'
import { ConnectPrompt } from './components/dashboard/ConnectPrompt.tsx'
import { DashboardPage } from './components/dashboard/DashboardPage.tsx'
import { AppShell } from './components/shell/AppShell.tsx'
import { httpClient } from './services/index.ts'
import { VideoDemoPage } from './components/video/VideoDemoPage.tsx'

export default function App() {
  // In HTTP mode the operator token is asked for once, before polling starts.
  const [connected, setConnected] = useState(httpClient === null)
  const [page, setPage] = useState<'Dashboard' | 'Video demo'>('Dashboard')

  return (
    <AppShell page={page} onNavigate={setPage}>
      {connected ? (
        <>
          <div hidden={page !== 'Dashboard'}><DashboardPage /></div>
          <div hidden={page !== 'Video demo'}><VideoDemoPage active={page === 'Video demo'} onBoard={() => setPage('Dashboard')} /></div>
        </>
      ) : (
        <ConnectPrompt
          open
          onConnect={(token) => {
            httpClient?.setToken(token)
            setConnected(true)
          }}
        />
      )}
    </AppShell>
  )
}
