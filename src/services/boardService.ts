/**
 * BoardService is the only contract the UI depends on. Components never touch
 * Supabase, SQL or database rows; they call this through the `useBoard` hook.
 *
 * Two adapters implement it with identical DTOs:
 *  - MockBoardClient  - deterministic in-memory scenarios for frontend review
 *  - HttpBoardClient  - same-origin /api calls against the Vercel backend
 */
import type { BoardSnapshot, ParticipantState, PurchaseResult, VisitorProfileDto } from '../lib/types.ts'

export type BoardServiceMode = 'mock' | 'http'

/** Every mutation carries the session it was composed against. */
interface SessionScoped {
  sessionId: string
}

/** `eventId` makes a resubmitted registration a no-op instead of a duplicate. */
export interface RegisterVisitorCommand extends SessionScoped {
  eventId: string
  profile: VisitorProfileDto
}

export interface UpdateProfileCommand extends SessionScoped {
  commandId: string
  visitId: string
  profile: VisitorProfileDto
}

/** Identifies the assignment, not a manually chosen associate. */
export interface AcceptAssignmentCommand extends SessionScoped {
  commandId: string
  assignmentId: string
}

export interface RecordOutcomeCommand extends SessionScoped {
  commandId: string
  visitId: string
  result: PurchaseResult
}

export interface MarkExitCommand extends SessionScoped {
  commandId: string
  visitId: string
  /** Required only when the visit has no recorded outcome yet. */
  purchaseResult: PurchaseResult | null
}

export interface SetAvailabilityCommand extends SessionScoped {
  commandId: string
  participantId: string
  state: Extract<ParticipantState, 'Available' | 'OffFloor'>
}

/** Reset is not session scoped - it replaces the session. */
export interface ResetDemoCommand {
  commandId: string
}

export interface BoardService {
  readonly mode: BoardServiceMode
  /** Reads the authoritative board. Supports abort so polls never overlap. */
  getBoard(options?: { signal?: AbortSignal }): Promise<BoardSnapshot>
  registerVisitor(command: RegisterVisitorCommand): Promise<void>
  updateVisitorProfile(command: UpdateProfileCommand): Promise<void>
  acceptAssignment(command: AcceptAssignmentCommand): Promise<void>
  recordOutcome(command: RecordOutcomeCommand): Promise<void>
  markExit(command: MarkExitCommand): Promise<void>
  setAvailability(command: SetAvailabilityCommand): Promise<void>
  resetDemo(command: ResetDemoCommand): Promise<void>
}

export type BoardErrorCode =
  /** Transport failed - last known board stays visible, retry is safe. */
  | 'Network'
  /** Server refused the transition (stale session, conflicting outcome). */
  | 'Conflict'
  /** Operator token missing or rejected. */
  | 'Unauthorized'
  /** Backend fault. */
  | 'Server'
  | 'Unknown'

/**
 * Short, operator-readable failure. SQL text and stack details never reach
 * the UI; `message` is what the Notice renders.
 */
export class BoardError extends Error {
  readonly code: BoardErrorCode
  readonly retryable: boolean
  readonly status?: number

  constructor(code: BoardErrorCode, message: string, options?: { retryable?: boolean; status?: number }) {
    super(message)
    this.name = 'BoardError'
    this.code = code
    this.status = options?.status
    this.retryable = options?.retryable ?? (code === 'Network' || code === 'Server')
  }
}

export function toBoardError(cause: unknown): BoardError {
  if (cause instanceof BoardError) return cause
  if (cause instanceof DOMException && cause.name === 'AbortError') {
    return new BoardError('Network', 'Request cancelled.', { retryable: true })
  }
  return new BoardError('Unknown', 'Unexpected error. Try again.', { retryable: true })
}
