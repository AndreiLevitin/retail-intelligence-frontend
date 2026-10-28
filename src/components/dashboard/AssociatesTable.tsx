import { useMemo } from 'react'
import { Button } from '../ui/Button.tsx'
import { DataTable } from '../ui/DataTable.tsx'
import type { Column, TableState } from '../ui/DataTable.tsx'
import { StatusBadge } from '../ui/StatusBadge.tsx'
import { assignmentPhaseLabels, availabilityLabels, availabilityTones } from '../../lib/labels.ts'
import { canMarkOffFloor, nextUpParticipantId } from '../../lib/types.ts'
import type { AssociateView, AvailabilityState } from '../../lib/types.ts'
import { actionKeys } from '../../hooks/useBoard.ts'

interface AssociatesTableProps {
  associates: readonly AssociateView[]
  state: TableState
  errorMessage?: string
  mutationsBlocked: boolean
  isPending: (key: string) => boolean
  onSetAvailability: (associate: AssociateView, next: AvailabilityState) => void
}

/**
 * Secondary table. Availability (Available/OffFloor) and assignment work are
 * shown as two independent facts: accepted, unfinished turns never make an
 * associate ineligible for a new offer. Each associate can hold at most one
 * unconfirmed offer of their own at a time - that is a per-associate limit,
 * not a session-wide one, so several associates may each be mid-offer.
 */
export function AssociatesTable({
  associates,
  state,
  errorMessage,
  mutationsBlocked,
  isPending,
  onSetAvailability,
}: AssociatesTableProps) {
  const nextUpId = useMemo(() => nextUpParticipantId(associates), [associates])

  const columns = useMemo<Column<AssociateView>[]>(
    () => [
      {
        key: 'name',
        header: 'Associate',
        width: 'w-56',
        cell: (associate) => <span className="font-medium text-ink">{associate.displayName}</span>,
      },
      {
        key: 'availability',
        header: 'Availability',
        width: 'w-32',
        cell: (associate) => (
          <StatusBadge tone={availabilityTones[associate.state]}>{availabilityLabels[associate.state]}</StatusBadge>
        ),
      },
      {
        key: 'assignment',
        header: 'Assignment',
        width: 'w-40',
        cell: (associate) => {
          // Shown separately from availability: accepted unfinished work is
          // never evidence of ineligibility, and each associate can hold at
          // most one unconfirmed offer of their own at a time.
          if (associate.pendingAssignmentId !== null) {
            return <StatusBadge tone="warning">{assignmentPhaseLabels.PendingAcceptance}</StatusBadge>
          }
          if (associate.activeTurns > 0) {
            return (
              <span className="text-ink">
                {associate.activeTurns} active {associate.activeTurns === 1 ? 'turn' : 'turns'}
              </span>
            )
          }
          return <span className="text-muted">None</span>
        },
      },
      {
        key: 'queue',
        header: 'Queue',
        width: 'w-36',
        cell: (associate) => {
          if (associate.queuePosition === null) {
            return <span className="text-muted">Not in rotation</span>
          }
          return associate.participantId === nextUpId ? (
            <StatusBadge tone="info">Next UP</StatusBadge>
          ) : (
            <span className="text-ink">Position {associate.queuePosition}</span>
          )
        },
      },
      {
        key: 'assigned',
        header: 'Assigned',
        width: 'w-24',
        align: 'right',
        cell: (associate) => <span className="text-ink">{associate.assignedTurns}</span>,
      },
      {
        key: 'accepted',
        header: 'Accepted',
        width: 'w-24',
        align: 'right',
        cell: (associate) => <span className="text-ink">{associate.acceptedTurns}</span>,
      },
      {
        key: 'actions',
        header: 'Availability actions',
        headerHidden: true,
        width: 'w-64',
        cell: (associate) => {
          if (associate.state === 'OffFloor') {
            return (
              <Button
                size="sm"
                variant="secondary"
                disabled={mutationsBlocked}
                pending={isPending(actionKeys.availability(associate.participantId))}
                onClick={() => onSetAvailability(associate, 'Available')}
              >
                Mark Available
              </Button>
            )
          }

          // Off Floor is rejected only while this associate owns their own
          // unconfirmed offer; accepted work never blocks it.
          const blocked = !canMarkOffFloor(associate)
          return (
            <div className="flex flex-col gap-1">
              <Button
                size="sm"
                variant="secondary"
                disabled={mutationsBlocked || blocked}
                pending={isPending(actionKeys.availability(associate.participantId))}
                onClick={() => onSetAvailability(associate, 'OffFloor')}
              >
                Mark Off Floor
              </Button>
              {blocked ? (
                <span className="text-label text-muted">Has a pending offer — resolve it first.</span>
              ) : null}
            </div>
          )
        },
      },
    ],
    [isPending, mutationsBlocked, nextUpId, onSetAvailability],
  )

  return (
    <section aria-labelledby="associates-heading" className="panel flex flex-col">
      <div className="flex flex-col gap-1 p-4">
        <h2 id="associates-heading" className="text-section font-semibold text-ink">
          Associates
        </h2>
        <p className="text-label text-muted">
          Rotation order is server-authoritative. Accepted, unfinished work never blocks a new offer; an associate
          can only go Off Floor once their own pending offer is resolved.
        </p>
      </div>
      <DataTable
        caption="Predefined associates and their rotation state"
        columns={columns}
        rows={associates}
        rowKey={(associate) => associate.participantId}
        state={state}
        errorMessage={errorMessage}
        emptyMessage="No associates in this session."
      />
    </section>
  )
}
