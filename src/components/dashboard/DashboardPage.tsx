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
import type { ParticipantDto, PurchaseResult, VisitDto, VisitorProfileDto } from '../../lib/types.ts'
import { boardService, boardServiceMode, mockController } from '../../services/index.ts'
import type { ScenarioId } from '../../services/mockScenarios.ts'

interface DialogState {
  kind: 'none' | 'visitor-form' | 'exit' | 'reset'
  mode?: VisitorFormMode
  /** The visit the dialog acts on; its live row is read from the snapshot. */
  visitId?: string
  /** Captured once on open, so a 2s poll cannot overwrite typed input. */
  initialProfile?: VisitorProfileDto
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

  /** Explains a Waiting visit with no assignment, from the current roster. */
  const waitingExplanation = useMemo(
    () => explainWaiting(snapshot?.participants ?? []),
    [snapshot?.participants],
  )

  /** Always the live row, so an open dialog follows server state. */
  const activeVisit = useMemo<VisitDto | null>(() => {
    if (dialog.visitId === undefined || snapshot === null) return null
    return snapshot.visits.find((visit) => visit.visitId === dialog.visitId) ?? null
  }, [dialog.visitId, snapshot])

  const close = useCallback(() => setDialog(CLOSED), [])

  const submitProfile = useCallback(
    async (profile: VisitorProfileDto) => {
      const current = dialog
      const ok =
        current.kind === 'visitor-form' && current.mode === 'edit' && current.visitId !== undefined
          ? await board.editProfile(current.visitId, profile)
          : await board.addVisitor(profile)
      if (ok) setDialog(CLOSED)
    },
    [board, dialog],
  )

  const commitExit = useCallback(
    async (purchaseResult: PurchaseResult | null) => {
      if (dialog.kind !== 'exit' || dialog.visitId === undefined) return
      const ok = await board.markExit(dialog.visitId, purchaseResult)
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
        visits={snapshot?.visits ?? []}
        state={tableState}
        errorMessage={board.loadError?.message}
        mutationsBlocked={mutationsBlocked}
        isPending={board.isPending}
        waitingExplanation={waitingExplanation}
        onAccept={(visit) => {
          if (visit.assignment === null) return
          void board.acceptUp(visit.visitId, visit.assignment.assignmentId)
        }}
        onRecordOutcome={(visit, result) => void board.recordOutcome(visit.visitId, result)}
        onMarkExit={(visit) => setDialog({ kind: 'exit', visitId: visit.visitId })}
        onEditProfile={(visit) =>
          setDialog({
            kind: 'visitor-form',
            mode: 'edit',
            visitId: visit.visitId,
            initialProfile: visit.profile,
          })
        }
      />

      <AssociatesTable
        participants={snapshot?.participants ?? []}
        state={tableState}
        errorMessage={board.loadError?.message}
        mutationsBlocked={mutationsBlocked}
        isPending={board.isPending}
        onSetAvailability={(participant, next) => void board.setAvailability(participant.participantId, next)}
      />

      <ActivityLog entries={snapshot?.activity ?? []} />

      {/* Dialogs are mounted per opening, so each one starts from clean state. */}
      {dialog.kind === 'visitor-form' ? (
        <VisitorForm
          mode={dialog.mode ?? 'create'}
          initial={dialog.initialProfile}
          pending={
            dialog.visitId === undefined
              ? board.isPending(actionKeys.addVisitor)
              : board.isPending(actionKeys.editProfile(dialog.visitId))
          }
          errorMessage={dialogError}
          onSubmit={(profile) => void submitProfile(profile)}
          onCancel={close}
        />
      ) : null}

      {dialog.kind === 'exit' && activeVisit !== null ? (
        <ExitDialog
          visit={activeVisit}
          pending={board.isPending(actionKeys.exit(activeVisit.visitId))}
          errorMessage={dialogError}
          onCommit={(result) => void commitExit(result)}
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

/**
 * Waiting visits exist only when no participant is eligible. This states the
 * reason so the board never looks simply broken.
 */
function explainWaiting(participants: readonly ParticipantDto[]): string | null {
  if (participants.length === 0) return null
  const offFloor = participants.filter((p) => p.state === 'OffFloor').length
  const busy = participants.filter((p) => p.state === 'PendingAcceptance' || p.state === 'OnUP').length

  if (offFloor === participants.length) return 'All associates are Off Floor.'
  if (busy === participants.length) return 'All associates are busy with a turn.'
  if (offFloor + busy === participants.length) return 'No eligible associate: the rest are busy or Off Floor.'
  return null
}
