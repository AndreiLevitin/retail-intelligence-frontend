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
  presenceLabels,
  presenceTones,
  purchaseResultLabel,
  purchaseResultTone,
  serviceStatusLabels,
  serviceStatusTones,
} from '../../lib/labels.ts'
import {
  canAcceptUp,
  canMarkExit,
  canRecordOutcome,
  presenceOf,
} from '../../lib/types.ts'
import type { PurchaseResult, ServiceStatus, VisitDto } from '../../lib/types.ts'
import { actionKeys } from '../../hooks/useBoard.ts'

type ServiceFilter = 'All' | ServiceStatus
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
  visits: readonly VisitDto[]
  state: TableState
  errorMessage?: string
  /** True while a reset is in flight: every row action is blocked. */
  mutationsBlocked: boolean
  isPending: (key: string) => boolean
  /** Why a Waiting visit has no assignment right now. */
  waitingExplanation: string | null
  onAccept: (visit: VisitDto) => void
  onRecordOutcome: (visit: VisitDto, result: PurchaseResult) => void
  onMarkExit: (visit: VisitDto) => void
  onEditProfile: (visit: VisitDto) => void
}

/**
 * The primary operational table. Service status, physical presence and
 * purchase result are three separate columns, because Completed + Inside is a
 * valid combination and a purchase is never inferred from either of the others.
 *
 * Filters change presentation only - they never touch metrics or the data.
 */
export function VisitorsTable({
  visits,
  state,
  errorMessage,
  mutationsBlocked,
  isPending,
  waitingExplanation,
  onAccept,
  onRecordOutcome,
  onMarkExit,
  onEditProfile,
}: VisitorsTableProps) {
  const [serviceFilter, setServiceFilter] = useState<ServiceFilter>('All')
  const [presenceFilter, setPresenceFilter] = useState<PresenceFilter>('All')

  const rows = useMemo(
    () =>
      visits.filter((visit) => {
        if (serviceFilter !== 'All' && visit.serviceStatus !== serviceFilter) return false
        if (presenceFilter !== 'All' && presenceOf(visit) !== presenceFilter) return false
        return true
      }),
    [presenceFilter, serviceFilter, visits],
  )

  const columns = useMemo<Column<VisitDto>[]>(
    () => [
      {
        key: 'appearance',
        header: 'Appearance',
        width: 'w-72',
        cell: (visit) => (
          <div className="flex flex-col gap-1">
            <span className="text-ink">{describeAppearance(visit.profile)}</span>
            <details className="text-label text-muted">
              <summary className="cursor-pointer">Details</summary>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2">
                <dt>Registration order</dt>
                <dd>{visit.registrationOrder}</dd>
                <dt>Source</dt>
                <dd>{visit.source}</dd>
                <dt>Attributes source</dt>
                <dd>{visit.attributesSource}</dd>
                <dt>Enrichment</dt>
                <dd>{visit.enrichmentStatus}</dd>
                <dt>Accepted at</dt>
                <dd>{formatTime(visit.assignment?.acceptedAt ?? null)}</dd>
                <dt>Result recorded</dt>
                <dd>{formatTime(visit.purchaseRecordedAt)}</dd>
              </dl>
            </details>
          </div>
        ),
      },
      {
        key: 'demographics',
        header: 'Age / Gender',
        width: 'w-32',
        cell: (visit) => (
          <span className="text-ink">
            {ageGroupLabels[visit.profile.ageGroup]} · {genderLabels[visit.profile.gender]}
          </span>
        ),
      },
      {
        key: 'times',
        header: 'Entry / Exit',
        width: 'w-32',
        cell: (visit) => (
          <span className="text-ink">
            {formatTime(visit.arrivedAt)} / {visit.departedAt === null ? '—' : formatTime(visit.departedAt)}
          </span>
        ),
      },
      {
        key: 'associate',
        header: 'Associate',
        width: 'w-44',
        cell: (visit) => {
          if (visit.assignment !== null) {
            return <span className="text-ink">{visit.assignment.participantName}</span>
          }
          return (
            <div className="flex flex-col gap-0.5">
              <span className="text-muted">None</span>
              {visit.serviceStatus === 'Waiting' && waitingExplanation !== null ? (
                <span className="text-label text-muted">{waitingExplanation}</span>
              ) : null}
            </div>
          )
        },
      },
      {
        key: 'service',
        header: 'Service',
        width: 'w-28',
        cell: (visit) => (
          <StatusBadge tone={serviceStatusTones[visit.serviceStatus]}>
            {serviceStatusLabels[visit.serviceStatus]}
          </StatusBadge>
        ),
      },
      {
        key: 'presence',
        header: 'Presence',
        width: 'w-24',
        cell: (visit) => {
          const presence = presenceOf(visit)
          return <StatusBadge tone={presenceTones[presence]}>{presenceLabels[presence]}</StatusBadge>
        },
      },
      {
        key: 'purchase',
        header: 'Purchase',
        width: 'w-32',
        cell: (visit) => (
          <StatusBadge tone={purchaseResultTone(visit.purchaseResult)}>
            {purchaseResultLabel(visit.purchaseResult)}
          </StatusBadge>
        ),
      },
      {
        key: 'actions',
        header: 'Actions',
        headerHidden: true,
        width: 'w-72',
        cell: (visit) => (
          <div className="flex flex-wrap items-center gap-2">
            {canAcceptUp(visit) ? (
              <Button
                size="sm"
                variant="primary"
                disabled={mutationsBlocked}
                pending={isPending(actionKeys.accept(visit.visitId))}
                onClick={() => onAccept(visit)}
              >
                Accept UP
              </Button>
            ) : null}

            {canRecordOutcome(visit) ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={mutationsBlocked}
                  pending={isPending(actionKeys.outcome(visit.visitId))}
                  onClick={() => onRecordOutcome(visit, 'Sale')}
                >
                  Sale
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={mutationsBlocked}
                  pending={isPending(actionKeys.outcome(visit.visitId))}
                  onClick={() => onRecordOutcome(visit, 'NoSale')}
                >
                  No-Sale
                </Button>
              </>
            ) : null}

            {canMarkExit(visit) ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={mutationsBlocked}
                pending={isPending(actionKeys.exit(visit.visitId))}
                onClick={() => onMarkExit(visit)}
              >
                Mark Exit
              </Button>
            ) : null}

            <Button
              size="sm"
              variant="text"
              disabled={mutationsBlocked}
              pending={isPending(actionKeys.editProfile(visit.visitId))}
              onClick={() => onEditProfile(visit)}
            >
              Edit
            </Button>
          </div>
        ),
      },
    ],
    [isPending, mutationsBlocked, onAccept, onEditProfile, onMarkExit, onRecordOutcome, waitingExplanation],
  )

  const filtered = rows.length !== visits.length

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
        rows={rows}
        rowKey={(visit) => visit.visitId}
        state={state}
        errorMessage={errorMessage}
        emptyMessage={
          filtered || visits.length > 0
            ? 'No visitors match the current filters.'
            : 'No visitors registered yet. Use Add Visitor to register the first arrival.'
        }
        rowClassName={(visit) => (visit.departedAt === null ? undefined : 'bg-page')}
      />
    </section>
  )
}
