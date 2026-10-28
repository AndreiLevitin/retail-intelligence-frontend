import { useCallback, useMemo, useState } from 'react'
import { ActivityLog } from './ActivityLog.tsx'
import { AssociatesTable } from './AssociatesTable.tsx'
import { DashboardHeader } from './DashboardHeader.tsx'
import { ExitDialog } from './ExitDialog.tsx'
import { MockModePanel } from './MockModePanel.tsx'
import { ResetDialog } from './ResetDialog.tsx'
import { VisitorForm } from './VisitorForm.tsx'
import type { VisitorFormMode } from './VisitorForm.tsx'
import { ShiftSummary } from './ShiftSummary.tsx'
import { VisitorsTable } from './VisitorsTable.tsx'
import { Notice } from '../ui/Notice.tsx'
import type { TableState } from '../ui/DataTable.tsx'
import { actionKeys, useBoard } from '../../hooks/useBoard.ts'
import { formatTimeWithSeconds } from '../../lib/format.ts'
import { buildVisitRows } from '../../lib/selectors.ts'
import type { VisitRow } from '../../lib/selectors.ts'
import type { AvailabilityState, Outcome, VisitorAttributes } from '../../lib/types.ts'
import { boardService, boardServiceMode, mockController } from '../../services/index.ts'
import type { ScenarioId } from '../../services/mockScenarios.ts'

interface DialogState {
  kind: 'none' | 'visitor-form' | 'exit' | 'reset'
  mode?: VisitorFormMode
  /** The visit the dialog acts on; its live row is read from the snapshot. */
  visitId?: string
  /** Captured once on open, so a 2s poll cannot overwrite typed input. */
  initialAttributes?: VisitorAttributes
}

const CLOSED: DialogState = { kind: 'none' }

/**
 * The only implemented page. It owns dialog state and wiring; all board rules
 * and all network behaviour live in `useBoard` and the BoardService adapters.
 */
export function DashboardPage() {
  const board = useBoard(boardService)
  const [dialog, setDialog] = useState<DialogState>(CLOSED)
  const [scenarioId, setScenarioId] = useState<ScenarioId | null>(mockController?.scenarioId ?? null)

  const { snapshot, isResetting } = board
  const mutationsBlocked = isResetting || snapshot === null

  const tableState: TableState =
    snapshot !== null ? 'ready' : board.loadError !== null ? 'error' : 'loading'

  /** The visit/assignment/associate join lives in one selector, not in rows. */
  const visitRows = useMemo<VisitRow[]>(() => (snapshot === null ? [] : buildVisitRows(snapshot)), [snapshot])

  /** Always the live row, so an open dialog follows server state. */
  const activeRow = useMemo<VisitRow | null>(() => {
    if (dialog.visitId === undefined) return null
    return visitRows.find((row) => row.visit.visitId === dialog.visitId) ?? null
  }, [dialog.visitId, visitRows])

  const close = useCallback(() => setDialog(CLOSED), [])

  const submitAttributes = useCallback(
    async (attributes: VisitorAttributes) => {
      const current = dialog
      const ok =
        current.kind === 'visitor-form' && current.mode === 'edit' && current.visitId !== undefined
          ? await board.editAttributes(current.visitId, attributes)
          : await board.addVisitor(attributes)
      if (ok) setDialog(CLOSED)
    },
    [board, dialog],
  )

  const commitExit = useCallback(
    async (outcome: Outcome | null) => {
      if (dialog.kind !== 'exit' || dialog.visitId === undefined) return
      const ok = await board.markDeparture(dialog.visitId, outcome)
      if (ok) setDialog(CLOSED)
    },
    [board, dialog],
  )

  const confirmReset = useCallback(async () => {
    const ok = await board.resetDemo()
    if (ok) setDialog(CLOSED)
  }, [board])

  const handleScenario = useCallback(
    (id: ScenarioId) => {
      mockController?.loadScenario(id)
      setScenarioId(id)
      setDialog(CLOSED)
      board.refreshNow()
    },
    [board],
  )

  const dialogError = board.actionError?.message

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-6">
      {boardServiceMode === 'mock' && scenarioId !== null ? (
        <MockModePanel
          scenarioId={scenarioId}
          onSelectScenario={handleScenario}
          onFailNextRead={() => mockController?.failNextRead()}
        />
      ) : null}

      <DashboardHeader
        sessionStartedAt={snapshot?.session.startedAt ?? null}
        connection={board.connection}
        lastUpdated={snapshot === null ? undefined : formatTimeWithSeconds(snapshot.serverTime)}
        onAddVisitor={() => setDialog({ kind: 'visitor-form', mode: 'create' })}
        onResetDemo={() => setDialog({ kind: 'reset' })}
        addVisitorPending={board.isPending(actionKeys.addVisitor)}
        resetPending={isResetting}
        mutationsBlocked={mutationsBlocked}
      />

      {board.loadError !== null && snapshot === null ? (
        <Notice tone="error" title="Could not load the board" onRetry={board.refreshNow}>
          <p>{board.loadError.message}</p>
        </Notice>
      ) : null}

      {board.connection === 'offline' && snapshot !== null ? (
        <Notice
          tone="warning"
          title="Showing the last known board"
          onRetry={board.refreshNow}
          retryLabel="Refresh now"
        >
          <p>The board service is unreachable. Polling continues every 2 seconds.</p>
        </Notice>
      ) : null}

      {/* A rejected command that is not already shown inside an open dialog. */}
      {board.actionError !== null && dialog.kind === 'none' ? (
        <Notice
          tone="error"
          title={board.actionError.message}
          onRetry={board.canRetryFailedCommand ? () => void board.retryFailedCommand() : undefined}
          onDismiss={board.dismissActionError}
        />
      ) : null}

      {isResetting ? (
        <Notice tone="info" title="Resetting the demo — actions are blocked until the new board loads." />
      ) : null}

      <ShiftSummary metrics={snapshot?.metrics ?? null} />

      <VisitorsTable
        rows={visitRows}
        state={tableState}
        errorMessage={board.loadError?.message}
        mutationsBlocked={mutationsBlocked}
        isPending={board.isPending}
        onAccept={(row) => {
          if (row.visit.assignmentId === null) return
          void board.acceptUp(row.visit.visitId, row.visit.assignmentId)
        }}
        onReject={(row) => {
          if (row.visit.assignmentId === null) return
          void board.rejectUp(row.visit.visitId, row.visit.assignmentId)
        }}
        onRecordOutcome={(row, outcome) => {
          if (row.visit.assignmentId === null) return
          void board.recordOutcome(row.visit.visitId, row.visit.assignmentId, outcome)
        }}
        onMarkExit={(row) => setDialog({ kind: 'exit', visitId: row.visit.visitId })}
        onEditAttributes={(row) =>
          setDialog({
            kind: 'visitor-form',
            mode: 'edit',
            visitId: row.visit.visitId,
            initialAttributes: row.visit.attributes,
          })
        }
      />

      <AssociatesTable
        associates={snapshot?.associates ?? []}
        state={tableState}
        errorMessage={board.loadError?.message}
        mutationsBlocked={mutationsBlocked}
        isPending={board.isPending}
        onSetAvailability={(associate, next: AvailabilityState) =>
          void board.setAvailability(associate.participantId, next)
        }
      />

      <ActivityLog entries={snapshot?.activity ?? []} />

      {/* Dialogs are mounted per opening, so each one starts from clean state. */}
      {dialog.kind === 'visitor-form' ? (
        <VisitorForm
          mode={dialog.mode ?? 'create'}
          initial={dialog.initialAttributes}
          pending={
            dialog.visitId === undefined
              ? board.isPending(actionKeys.addVisitor)
              : board.isPending(actionKeys.editAttributes(dialog.visitId))
          }
          errorMessage={dialogError}
          onSubmit={(attributes) => void submitAttributes(attributes)}
          onCancel={close}
        />
      ) : null}

      {dialog.kind === 'exit' && activeRow !== null ? (
        <ExitDialog
          visit={activeRow.visit}
          associateName={activeRow.associateName}
          pending={board.isPending(actionKeys.departure(activeRow.visit.visitId))}
          errorMessage={dialogError}
          onCommit={(outcome) => void commitExit(outcome)}
          onCancel={close}
        />
      ) : null}

      {dialog.kind === 'reset' ? (
        <ResetDialog
          open
          pending={isResetting}
          errorMessage={dialogError}
          onConfirm={() => void confirmReset()}
          onCancel={close}
        />
      ) : null}
    </div>
  )
}
