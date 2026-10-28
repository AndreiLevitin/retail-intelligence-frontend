import { cn } from '../../lib/cn.ts'
import type { ConnectionState } from '../../hooks/useBoard.ts'

interface ConnectionIndicatorProps {
  state: ConnectionState
  /** Time of the last successful read, already formatted. */
  lastUpdated?: string
}

const labels: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  updating: 'Updating',
  offline: 'Offline — showing last known board',
}

const dotClasses: Record<ConnectionState, string> = {
  connecting: 'bg-muted',
  connected: 'bg-success',
  updating: 'bg-info',
  offline: 'bg-danger',
}

/**
 * Text-first connection state. The last known board stays visible while
 * offline, so this is the only thing that changes on a failed poll.
 */
export function ConnectionIndicator({ state, lastUpdated }: ConnectionIndicatorProps) {
  return (
    <p className="flex items-center gap-2 text-label text-muted" role="status" aria-live="polite">
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', dotClasses[state])} />
      <span>{labels[state]}</span>
      {lastUpdated !== undefined && state !== 'connecting' ? <span>· updated {lastUpdated}</span> : null}
    </p>
  )
}
