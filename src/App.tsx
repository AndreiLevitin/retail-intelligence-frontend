import { useState } from 'react'
import { ConnectPrompt } from './components/dashboard/ConnectPrompt.tsx'
import { DashboardPage } from './components/dashboard/DashboardPage.tsx'
import { AppShell } from './components/shell/AppShell.tsx'
import { httpClient } from './services/index.ts'

export default function App() {
  // In HTTP mode the operator token is asked for once, before polling starts.
  const [connected, setConnected] = useState(httpClient === null)

  return (
    <AppShell>
      {connected ? (
        <DashboardPage />
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
