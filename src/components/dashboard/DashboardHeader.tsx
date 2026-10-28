import { Button } from '../ui/Button.tsx'
import { ConnectionIndicator } from '../ui/ConnectionIndicator.tsx'
import { formatDateTime } from '../../lib/format.ts'
import type { ConnectionState } from '../../hooks/useBoard.ts'

interface DashboardHeaderProps {
  sessionStartedAt: string | null
  connection: ConnectionState
  lastUpdated?: string
  onAddVisitor: () => void
  onResetDemo: () => void
  addVisitorPending: boolean
  resetPending: boolean
  mutationsBlocked: boolean
}

export function DashboardHeader({
  sessionStartedAt,
  connection,
  lastUpdated,
  onAddVisitor,
  onResetDemo,
  addVisitorPending,
  resetPending,
  mutationsBlocked,
}: DashboardHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-page font-semibold text-ink">Dashboard</h1>
        <p className="text-body text-muted">
          Demo session started {sessionStartedAt === null ? '—' : formatDateTime(sessionStartedAt)}
        </p>
        <ConnectionIndicator state={connection} lastUpdated={lastUpdated} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={onAddVisitor}
          disabled={mutationsBlocked}
          pending={addVisitorPending}
        >
          Add Visitor
        </Button>
        <Button variant="destructive" onClick={onResetDemo} disabled={mutationsBlocked} pending={resetPending}>
          Reset Demo
        </Button>
      </div>
    </div>
  )
}
