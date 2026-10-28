import { useState } from 'react'
import { formatTimeWithSeconds } from '../../lib/format.ts'
import { activityKindLabels } from '../../lib/labels.ts'
import type { ActivityEntryDto } from '../../lib/types.ts'

interface ActivityLogProps {
  entries: readonly ActivityEntryDto[]
}

/**
 * Compact collapsible section below both tables, newest first. It is
 * secondary to the operational tables and holds no actions.
 */
export function ActivityLog({ entries }: ActivityLogProps) {
  const [open, setOpen] = useState(false)

  return (
    <section aria-labelledby="activity-heading" className="panel">
      <h2 id="activity-heading" className="sr-only">
        Activity
      </h2>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="activity-list"
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-touch w-full items-center justify-between gap-3 px-4 py-3 text-left lg:min-h-10"
      >
        <span className="text-body font-semibold text-ink">
          Activity <span className="font-normal text-muted">({entries.length})</span>
        </span>
        <span className="text-label text-primary">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open ? (
        <ul id="activity-list" className="border-t border-line">
          {entries.length === 0 ? (
            <li className="px-4 py-6 text-center text-body text-muted">No activity in this demo session yet.</li>
          ) : (
            entries.map((entry) => (
              <li
                key={entry.entryId}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-2 last:border-b-0"
              >
                <span className="w-20 shrink-0 font-mono text-label text-muted">
                  {formatTimeWithSeconds(entry.occurredAt)}
                </span>
                <span className="text-label font-medium text-muted">{activityKindLabels[entry.kind]}</span>
                <span className="text-body text-ink">{entry.message}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </section>
  )
}
