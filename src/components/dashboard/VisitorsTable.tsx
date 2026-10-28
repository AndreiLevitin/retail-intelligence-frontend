import { useMemo, useState } from 'react'
import { Button } from '../ui/Button.tsx'
import { DataTable } from '../ui/DataTable.tsx'
import type { Column, TableState } from '../ui/DataTable.tsx'
import { Select } from '../ui/Select.tsx'
import { StatusBadge } from '../ui/StatusBadge.tsx'
import { formatTime } from '../../lib/format.ts'
import {
  ageGroupLabels,
  describeAppearance,
  genderLabels,
  outcomeLabel,
  outcomeTone,
  presenceLabels,
  presenceTones,
  visitStatusLabels,
  visitStatusTones,
} from '../../lib/labels.ts'
import { canAcceptUp, canMarkExit, canRecordOutcome, canRejectUp, presenceOf } from '../../lib/types.ts'
import type { VisitRow } from '../../lib/selectors.ts'
import type { Outcome, VisitStatus } from '../../lib/types.ts'
import { actionKeys } from '../../hooks/useBoard.ts'

type ServiceFilter = 'All' | VisitStatus
type PresenceFilter = 'All' | 'Inside' | 'Left'

const SERVICE_FILTER_OPTIONS: ReadonlyArray<{ value: ServiceFilter; label: string }> = [
  { value: 'All', label: 'All service statuses' },
  { value: 'Waiting', label: 'Waiting' },
  { value: 'Assigned', label: 'Assigned' },
  { value: 'Accepted', label: 'Accepted' },
  { value: 'Completed', label: 'Completed' },
]

const PRESENCE_FILTER_OPTIONS: ReadonlyArray<{ value: PresenceFilter; label: string }> = [
  { value: 'All', label: 'Inside and Left' },
  { value: 'Inside', label: 'Inside' },
  { value: 'Left', label: 'Left' },
]

interface VisitorsTableProps {
  rows: readonly VisitRow[]
  state: TableState
  errorMessage?: string
  /** True while a reset is in flight: every row action is blocked. */
  mutationsBlocked: boolean
  isPending: (key: string) => boolean
  /** Why a Waiting visit has no assignment right now. */
  waitingExplanation: string | null
  onAccept: (row: VisitRow) => void
  onReject: (row: VisitRow) => void
  onRecordOutcome: (row: VisitRow, outcome: Outcome) => void
  onMarkExit: (row: VisitRow) => void
  onEditAttributes: (row: VisitRow) => void
}

/**
 * The primary operational table. Service status, physical presence and
 * purchase result are three separate columns, because Completed + Inside is a
 * valid combination and a purchase is never inferred from either of the others.
 *
 * Filters change presentation only - they never touch metrics or the data.
 */
export function VisitorsTable({
  rows,
  state,
  errorMessage,
  mutationsBlocked,
  isPending,
  waitingExplanation,
  onAccept,
  onReject,
  onRecordOutcome,
  onMarkExit,
  onEditAttributes,
}: VisitorsTableProps) {
  const [serviceFilter, setServiceFilter] = useState<ServiceFilter>('All')
  const [presenceFilter, setPresenceFilter] = useState<PresenceFilter>('All')

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        if (serviceFilter !== 'All' && row.visit.status !== serviceFilter) return false
        if (presenceFilter !== 'All' && presenceOf(row.visit) !== presenceFilter) return false
        return true
      }),
    [presenceFilter, rows, serviceFilter],
  )

  const columns = useMemo<Column<VisitRow>[]>(
    () => [
      {
        key: 'appearance',
        header: 'Appearance',
        width: 'w-72',
        cell: ({ visit }) => (
          <div className="flex flex-col gap-1">
            <span className="text-ink">{describeAppearance(visit.attributes)}</span>
            <details className="text-label text-muted">
              <summary className="cursor-pointer">Details</summary>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2">
                <dt>Source</dt>
                <dd>{visit.source}</dd>
                <dt>Attributes source</dt>
                <dd>{visit.attributesSource}</dd>
                <dt>Enrichment</dt>
                <dd>{visit.enrichmentStatus}</dd>
                <dt>Result recorded</dt>
                <dd>{formatTime(visit.outcomeRecordedAt)}</dd>
              </dl>
            </details>
          </div>
        ),
      },
      {
        key: 'demographics',
        header: 'Age / Gender',
        width: 'w-32',
        cell: ({ visit }) => (
          <span className="text-ink">
            {ageGroupLabels[visit.attributes.ageGroup]} · {genderLabels[visit.attributes.gender]}
          </span>
        ),
      },
      {
        key: 'times',
        header: 'Entry / Exit',
        width: 'w-32',
        cell: ({ visit }) => (
          <span className="text-ink">
            {formatTime(visit.arrivedAt)} / {visit.departedAt === null ? '—' : formatTime(visit.departedAt)}
          </span>
        ),
      },
      {
        key: 'associate',
        header: 'Associate',
        width: 'w-44',
        cell: ({ visit, associateName }) => {
          if (associateName !== null) {
            return <span className="text-ink">{associateName}</span>
          }
          return (
            <div className="flex flex-col gap-0.5">
              <span className="text-muted">None</span>
              {visit.status === 'Waiting' && waitingExplanation !== null ? (
                <span className="text-label text-muted">
                  {waitingExplanation}
                  {visit.waitingPosition !== null ? ` (position ${visit.waitingPosition})` : ''}
                </span>
              ) : null}
            </div>
          )
        },
      },
      {
        key: 'service',
        header: 'Service',
        width: 'w-28',
        cell: ({ visit }) => <StatusBadge tone={visitStatusTones[visit.status]}>{visitStatusLabels[visit.status]}</StatusBadge>,
      },
      {
        key: 'presence',
        header: 'Presence',
        width: 'w-24',
        cell: ({ visit }) => {
          const presence = presenceOf(visit)
          return <StatusBadge tone={presenceTones[presence]}>{presenceLabels[presence]}</StatusBadge>
        },
      },
      {
        key: 'purchase',
        header: 'Purchase',
        width: 'w-32',
        cell: ({ visit }) => <StatusBadge tone={outcomeTone(visit.outcome)}>{outcomeLabel(visit.outcome)}</StatusBadge>,
      },
      {
        key: 'actions',
        header: 'Actions',
        headerHidden: true,
        width: 'w-72',
        cell: (row) => (
          <div className="flex flex-wrap items-center gap-2">
            {canAcceptUp(row.visit) ? (
              <Button
                size="sm"
                variant="primary"
                disabled={mutationsBlocked}
                pending={isPending(actionKeys.accept(row.visit.visitId))}
                onClick={() => onAccept(row)}
              >
                Accept UP
              </Button>
            ) : null}

            {canRejectUp(row.visit) ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={mutationsBlocked}
                pending={isPending(actionKeys.reject(row.visit.visitId))}
                onClick={() => onReject(row)}
              >
                Reject
              </Button>
            ) : null}

            {canRecordOutcome(row.visit) ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={mutationsBlocked}
                  pending={isPending(actionKeys.outcome(row.visit.visitId))}
                  onClick={() => onRecordOutcome(row, 'Sale')}
                >
                  Sale
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={mutationsBlocked}
                  pending={isPending(actionKeys.outcome(row.visit.visitId))}
                  onClick={() => onRecordOutcome(row, 'NoSale')}
                >
                  No-Sale
                </Button>
              </>
            ) : null}

            {canMarkExit(row.visit) ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={mutationsBlocked}
                pending={isPending(actionKeys.departure(row.visit.visitId))}
                onClick={() => onMarkExit(row)}
              >
                Mark Exit
              </Button>
            ) : null}

            <Button
              size="sm"
              variant="text"
              disabled={mutationsBlocked}
              pending={isPending(actionKeys.editAttributes(row.visit.visitId))}
              onClick={() => onEditAttributes(row)}
            >
              Edit
            </Button>
          </div>
        ),
      },
    ],
    [isPending, mutationsBlocked, onAccept, onEditAttributes, onMarkExit, onReject, onRecordOutcome, waitingExplanation],
  )

  const filtered = filteredRows.length !== rows.length

  return (
    <section aria-labelledby="visitors-heading" className="panel flex flex-col">
      <div className="flex flex-wrap items-end justify-between gap-3 p-4">
        <div className="flex flex-col gap-1">
          <h2 id="visitors-heading" className="text-section font-semibold text-ink">
            Visitors
          </h2>
          <p className="text-label text-muted">
            Server registration order. Filters affect this list only, not the shift summary.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-52">
            <label htmlFor="visitors-service-filter" className="sr-only">
              Filter by service status
            </label>
            <Select<ServiceFilter>
              id="visitors-service-filter"
              value={serviceFilter}
              options={SERVICE_FILTER_OPTIONS}
              onValueChange={setServiceFilter}
            />
          </div>
          <div className="w-44">
            <label htmlFor="visitors-presence-filter" className="sr-only">
              Filter by presence
            </label>
            <Select<PresenceFilter>
              id="visitors-presence-filter"
              value={presenceFilter}
              options={PRESENCE_FILTER_OPTIONS}
              onValueChange={setPresenceFilter}
            />
          </div>
        </div>
      </div>

      <DataTable
        caption="Visitors in the current demo session"
        columns={columns}
        rows={filteredRows}
        rowKey={(row) => row.visit.visitId}
        state={state}
        errorMessage={errorMessage}
        emptyMessage={
          filtered || rows.length > 0
            ? 'No visitors match the current filters.'
            : 'No visitors registered yet. Use Add Visitor to register the first arrival.'
        }
        rowClassName={(row) => (row.visit.departedAt === null ? undefined : 'bg-page')}
      />
    </section>
  )
}
