import { useMemo } from 'react'
import { Button } from '../ui/Button.tsx'
import { DataTable } from '../ui/DataTable.tsx'
import type { Column, TableState } from '../ui/DataTable.tsx'
import { StatusBadge } from '../ui/StatusBadge.tsx'
import { participantStateLabels, participantStateTones } from '../../lib/labels.ts'
import { isIdle, nextUpParticipantId } from '../../lib/types.ts'
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
 * Secondary table. Queue order comes from the server: there is no local
 * sorting control, and returning Available always joins the bottom.
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
        key: 'state',
        header: 'State',
        width: 'w-44',
        cell: (associate) => (
          <StatusBadge tone={participantStateTones[associate.state]}>
            {participantStateLabels[associate.state]}
          </StatusBadge>
        ),
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
        width: 'w-56',
        cell: (associate) => {
          // Pending Acceptance and On UP are not idle, so availability is
          // locked rather than hidden - the reason stays visible.
          if (!isIdle(associate)) {
            return <span className="text-label text-muted">Busy — availability locked</span>
          }
          const next: AvailabilityState = associate.state === 'Available' ? 'OffFloor' : 'Available'
          return (
            <Button
              size="sm"
              variant="secondary"
              disabled={mutationsBlocked}
              pending={isPending(actionKeys.availability(associate.participantId))}
              onClick={() => onSetAvailability(associate, next)}
            >
              {next === 'OffFloor' ? 'Mark Off Floor' : 'Mark Available'}
            </Button>
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
          Rotation order is server-authoritative. Availability can only change for an idle associate.
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
