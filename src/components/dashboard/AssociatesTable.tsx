import { useMemo } from 'react'
import { Button } from '../ui/Button.tsx'
import { DataTable } from '../ui/DataTable.tsx'
import type { Column, TableState } from '../ui/DataTable.tsx'
import { StatusBadge } from '../ui/StatusBadge.tsx'
import { participantStateLabels, participantStateTones } from '../../lib/labels.ts'
import { isIdle, nextUpParticipantId } from '../../lib/types.ts'
import type { ParticipantDto, ParticipantState } from '../../lib/types.ts'
import { actionKeys } from '../../hooks/useBoard.ts'

interface AssociatesTableProps {
  participants: readonly ParticipantDto[]
  state: TableState
  errorMessage?: string
  mutationsBlocked: boolean
  isPending: (key: string) => boolean
  onSetAvailability: (
    participant: ParticipantDto,
    next: Extract<ParticipantState, 'Available' | 'OffFloor'>,
  ) => void
}

/**
 * Secondary table. Queue order comes from the server: there is no local
 * sorting control, and returning Available always joins the bottom.
 */
export function AssociatesTable({
  participants,
  state,
  errorMessage,
  mutationsBlocked,
  isPending,
  onSetAvailability,
}: AssociatesTableProps) {
  const nextUpId = useMemo(() => nextUpParticipantId([...participants]), [participants])

  const columns = useMemo<Column<ParticipantDto>[]>(
    () => [
      {
        key: 'name',
        header: 'Associate',
        width: 'w-56',
        cell: (participant) => <span className="font-medium text-ink">{participant.displayName}</span>,
      },
      {
        key: 'state',
        header: 'State',
        width: 'w-44',
        cell: (participant) => (
          <StatusBadge tone={participantStateTones[participant.state]}>
            {participantStateLabels[participant.state]}
          </StatusBadge>
        ),
      },
      {
        key: 'queue',
        header: 'Queue',
        width: 'w-36',
        cell: (participant) => {
          if (participant.queuePosition === null) {
            return <span className="text-muted">Not in rotation</span>
          }
          return participant.participantId === nextUpId ? (
            <StatusBadge tone="info">Next UP</StatusBadge>
          ) : (
            <span className="text-ink">Position {participant.queuePosition}</span>
          )
        },
      },
      {
        key: 'assigned',
        header: 'Assigned',
        width: 'w-24',
        align: 'right',
        cell: (participant) => <span className="text-ink">{participant.assignedCount}</span>,
      },
      {
        key: 'accepted',
        header: 'Accepted',
        width: 'w-24',
        align: 'right',
        cell: (participant) => <span className="text-ink">{participant.acceptedCount}</span>,
      },
      {
        key: 'actions',
        header: 'Availability actions',
        headerHidden: true,
        width: 'w-56',
        cell: (participant) => {
          // Pending Acceptance and On UP are not idle, so availability is
          // locked rather than hidden - the reason stays visible.
          if (!isIdle(participant)) {
            return <span className="text-label text-muted">Busy — availability locked</span>
          }
          const next: Extract<ParticipantState, 'Available' | 'OffFloor'> =
            participant.state === 'Available' ? 'OffFloor' : 'Available'
          return (
            <Button
              size="sm"
              variant="secondary"
              disabled={mutationsBlocked}
              pending={isPending(actionKeys.availability(participant.participantId))}
              onClick={() => onSetAvailability(participant, next)}
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
        rows={participants}
        rowKey={(participant) => participant.participantId}
        state={state}
        errorMessage={errorMessage}
        emptyMessage="No associates in this session."
      />
    </section>
  )
}
