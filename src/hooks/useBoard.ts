/**
 * The one hook that owns fetching, polling and mutation state. Components read
 * the snapshot and call actions through it; none of them talks to a client
 * directly and none of them rotates the queue or increments a counter locally.
 *
 * Rules implemented here:
 *  - poll GET /api/board every 2s with a single request in flight
 *  - refresh after every mutation instead of optimistic authoritative state
 *  - drop snapshots that are older than the newest action or reset
 *  - disable only the affected action while its command is pending
 *  - keep the original eventId / commandId for a retry
 *  - keep the last known board visible while offline, recover on success
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BoardError, toBoardError } from '../services/boardService.ts'
import type { BoardService } from '../services/boardService.ts'
import { newCommandId, newEventId } from '../lib/ids.ts'
import type { BoardSnapshot, ParticipantState, PurchaseResult, VisitorProfileDto } from '../lib/types.ts'

export const POLL_INTERVAL_MS = 2000
const READ_TIMEOUT_MS = 8000

export type ConnectionState = 'connecting' | 'connected' | 'updating' | 'offline'

/** Keys identify which single control is pending, so the rest stay usable. */
export const actionKeys = {
  addVisitor: 'add-visitor',
  reset: 'reset-demo',
  editProfile: (visitId: string) => `visit:${visitId}:profile`,
  accept: (visitId: string) => `visit:${visitId}:accept`,
  outcome: (visitId: string) => `visit:${visitId}:outcome`,
  exit: (visitId: string) => `visit:${visitId}:exit`,
  availability: (participantId: string) => `participant:${participantId}:availability`,
} as const

interface FailedCommand {
  key: string
  /** Re-runs the identical command, original idempotency key included. */
  run: () => Promise<void>
}

export interface BoardActions {
  addVisitor(profile: VisitorProfileDto): Promise<boolean>
  editProfile(visitId: string, profile: VisitorProfileDto): Promise<boolean>
  acceptUp(visitId: string, assignmentId: string): Promise<boolean>
  recordOutcome(visitId: string, result: PurchaseResult): Promise<boolean>
  markExit(visitId: string, purchaseResult: PurchaseResult | null): Promise<boolean>
  setAvailability(
    participantId: string,
    state: Extract<ParticipantState, 'Available' | 'OffFloor'>,
  ): Promise<boolean>
  resetDemo(): Promise<boolean>
}

export interface UseBoardResult extends BoardActions {
  snapshot: BoardSnapshot | null
  connection: ConnectionState
  /** Set only while no board has ever loaded; blocks the workspace. */
  loadError: BoardError | null
  /** Last rejected command. Rendered as a short notice with a retry path. */
  actionError: BoardError | null
  dismissActionError(): void
  /** Retries the last failed command with its original idempotency key. */
  retryFailedCommand(): Promise<boolean>
  canRetryFailedCommand: boolean
  isPending(key: string): boolean
  /** True while a reset is in flight: every mutation is blocked. */
  isResetting: boolean
  refreshNow(): void
}

export function useBoard(service: BoardService): UseBoardResult {
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [loadError, setLoadError] = useState<BoardError | null>(null)
  const [actionError, setActionError] = useState<BoardError | null>(null)
  const [pending, setPending] = useState<readonly string[]>([])
  const [isResetting, setIsResetting] = useState(false)

  const snapshotRef = useRef<BoardSnapshot | null>(null)
  const inFlight = useRef<AbortController | null>(null)
  /** Bumped by every mutation and reset; older reads are discarded. */
  const generation = useRef(0)
  const failedCommand = useRef<FailedCommand | null>(null)
  const [canRetry, setCanRetry] = useState(false)
  const mounted = useRef(true)

  const applySnapshot = useCallback((next: BoardSnapshot) => {
    const current = snapshotRef.current
    // Within one session, never let an older revision overwrite a newer one.
    if (current !== null && current.session.sessionId === next.session.sessionId && next.revision < current.revision) {
      return
    }
    snapshotRef.current = next
    setSnapshot(next)
  }, [])

  const read = useCallback(
    async (startedGeneration: number) => {
      if (inFlight.current !== null) return // one request in flight, no overlap
      const controller = new AbortController()
      inFlight.current = controller
      const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS)

      if (snapshotRef.current !== null) setConnection('updating')

      try {
        const next = await service.getBoard({ signal: controller.signal })
        if (!mounted.current) return
        // A mutation or reset happened after this read started: it is stale.
        if (startedGeneration !== generation.current) return
        applySnapshot(next)
        setLoadError(null)
        setConnection('connected')
      } catch (cause) {
        if (!mounted.current) return
        const error = toBoardError(cause)
        if (snapshotRef.current === null) {
          setLoadError(error)
          setConnection('offline')
        } else {
          // Keep the last known board visible and mark it stale.
          setConnection('offline')
        }
      } finally {
        clearTimeout(timer)
        if (inFlight.current === controller) inFlight.current = null
      }
    },
    [applySnapshot, service],
  )

  // Initial load plus the 2s poll. The interval skips a tick when the previous
  // read has not come back yet.
  useEffect(() => {
    mounted.current = true
    void read(generation.current)
    const interval = setInterval(() => {
      void read(generation.current)
    }, POLL_INTERVAL_MS)
    return () => {
      mounted.current = false
      clearInterval(interval)
      inFlight.current?.abort()
      inFlight.current = null
    }
  }, [read])

  const refreshNow = useCallback(() => {
    void read(generation.current)
  }, [read])

  /**
   * Runs one mutation: marks its control pending, invalidates in-flight reads,
   * then reconciles by refetching. Authoritative state is never guessed.
   */
  const runCommand = useCallback(
    async (key: string, run: () => Promise<void>): Promise<boolean> => {
      setActionError(null)
      setPending((keys) => (keys.includes(key) ? keys : [...keys, key]))
      generation.current += 1
      inFlight.current?.abort()
      inFlight.current = null

      try {
        await run()
        if (!mounted.current) return true
        failedCommand.current = null
        setCanRetry(false)
        return true
      } catch (cause) {
        if (!mounted.current) return false
        const error = toBoardError(cause)
        setActionError(error)
        // The response is uncertain, so keep the command for an exact retry.
        failedCommand.current = { key, run }
        setCanRetry(true)
        return false
      } finally {
        if (mounted.current) {
          setPending((keys) => keys.filter((candidate) => candidate !== key))
          // Reconcile in both directions: a success needs the new board, a
          // failure needs the server's actual current state.
          void read(generation.current)
        }
      }
    },
    [read],
  )

  const requireSessionId = useCallback((): string | null => snapshotRef.current?.session.sessionId ?? null, [])

  const actions = useMemo<BoardActions>(() => {
    /** Mutations are blocked while a reset is in flight or before first load. */
    const guard = (): string | null => {
      if (isResetting) return null
      return requireSessionId()
    }

    return {
      async addVisitor(profile) {
        const sessionId = guard()
        if (sessionId === null) return false
        const eventId = newEventId()
        return runCommand(actionKeys.addVisitor, () =>
          service.registerVisitor({ eventId, sessionId, profile }),
        )
      },

      async editProfile(visitId, profile) {
        const sessionId = guard()
        if (sessionId === null) return false
        const commandId = newCommandId()
        return runCommand(actionKeys.editProfile(visitId), () =>
          service.updateVisitorProfile({ commandId, sessionId, visitId, profile }),
        )
      },

      async acceptUp(visitId, assignmentId) {
        const sessionId = guard()
        if (sessionId === null) return false
        const commandId = newCommandId()
        return runCommand(actionKeys.accept(visitId), () =>
          service.acceptAssignment({ commandId, sessionId, assignmentId }),
        )
      },

      async recordOutcome(visitId, result) {
        const sessionId = guard()
        if (sessionId === null) return false
        const commandId = newCommandId()
        return runCommand(actionKeys.outcome(visitId), () =>
          service.recordOutcome({ commandId, sessionId, visitId, result }),
        )
      },

      async markExit(visitId, purchaseResult) {
        const sessionId = guard()
        if (sessionId === null) return false
        const commandId = newCommandId()
        return runCommand(actionKeys.exit(visitId), () =>
          service.markExit({ commandId, sessionId, visitId, purchaseResult }),
        )
      },

      async setAvailability(participantId, state) {
        const sessionId = guard()
        if (sessionId === null) return false
        const commandId = newCommandId()
        return runCommand(actionKeys.availability(participantId), () =>
          service.setAvailability({ commandId, sessionId, participantId, state }),
        )
      },

      async resetDemo() {
        if (isResetting) return false
        const commandId = newCommandId()
        setIsResetting(true)
        setActionError(null)
        generation.current += 1
        inFlight.current?.abort()
        inFlight.current = null

        try {
          await service.resetDemo({ commandId })
          if (!mounted.current) return true
          // Old snapshots are discarded; the new board loads from zero.
          snapshotRef.current = null
          setSnapshot(null)
          setConnection('connecting')
          failedCommand.current = null
          setCanRetry(false)
          return true
        } catch (cause) {
          if (!mounted.current) return false
          const error = toBoardError(cause)
          setActionError(error)
          // Uncertain response: resolve it by fetching the current session.
          failedCommand.current = { key: actionKeys.reset, run: () => service.resetDemo({ commandId }) }
          setCanRetry(true)
          return false
        } finally {
          if (mounted.current) {
            setIsResetting(false)
            void read(generation.current)
          }
        }
      },
    }
  }, [isResetting, read, requireSessionId, runCommand, service])

  const retryFailedCommand = useCallback(async (): Promise<boolean> => {
    const failed = failedCommand.current
    if (failed === null) return false
    return runCommand(failed.key, failed.run)
  }, [runCommand])

  const isPending = useCallback((key: string) => pending.includes(key), [pending])

  return {
    ...actions,
    snapshot,
    connection,
    loadError,
    actionError,
    dismissActionError: useCallback(() => setActionError(null), []),
    retryFailedCommand,
    canRetryFailedCommand: canRetry,
    isPending,
    isResetting,
    refreshNow,
  }
}
