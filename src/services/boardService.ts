/**
 * BoardService is the only contract the UI depends on. Components never touch
 * Supabase, SQL or database rows; they call this through the `useBoard` hook.
 *
 * Two adapters implement it with identical DTOs:
 *  - MockBoardClient  - deterministic in-memory scenarios for frontend review
 *  - HttpBoardClient  - same-origin /api calls against the Vercel backend
 *
 * Command shapes mirror the backend's public contract exactly: only arrival
 * and availability carry a client idempotency key (`eventId` / `commandId`);
 * accept, reject, outcome, departure and attributes do not, because the
 * backend's own current-state check makes a blind retry of those safe.
 */
import type { AvailabilityState, BoardSnapshot, Outcome, VisitorAttributes } from '../lib/types.ts'

export type BoardServiceMode = 'mock' | 'http'

interface SessionScoped {
  sessionId: string
}

/** POST /api/arrivals */
export interface RegisterVisitorCommand extends SessionScoped {
  eventId: string
  attributes: VisitorAttributes
}

/** PATCH /api/visits/{visitId}/attributes - full replacement, no client key. */
export interface UpdateAttributesCommand extends SessionScoped {
  visitId: string
  attributes: VisitorAttributes
}

/** POST /api/assignments/{assignmentId}/accept */
export interface AcceptAssignmentCommand extends SessionScoped {
  assignmentId: string
}

/** POST /api/assignments/{assignmentId}/reject - same shape as accept. */
export interface RejectAssignmentCommand extends SessionScoped {
  assignmentId: string
}

/** POST /api/assignments/{assignmentId}/outcome - keyed by assignment, not visit. */
export interface RecordOutcomeCommand extends SessionScoped {
  assignmentId: string
  outcome: Outcome
}

/** POST /api/visits/{visitId}/departure */
export interface MarkDepartureCommand extends SessionScoped {
  visitId: string
  /** Required only when the visit has no stored outcome yet. */
  outcome: Outcome | null
}

/** POST /api/availability - participantId travels in the body, not the URL. */
export interface SetAvailabilityCommand extends SessionScoped {
  participantId: string
  commandId: string
  state: AvailabilityState
}

/** POST /api/demo/reset - session-scoped: a stale sessionId is rejected. */
export interface ResetDemoCommand extends SessionScoped {}

export interface BoardService {
  readonly mode: BoardServiceMode
  /** Reads the authoritative board. Supports abort so polls never overlap. */
  getBoard(options?: { signal?: AbortSignal }): Promise<BoardSnapshot>
  registerVisitor(command: RegisterVisitorCommand): Promise<void>
  updateAttributes(command: UpdateAttributesCommand): Promise<void>
  acceptAssignment(command: AcceptAssignmentCommand): Promise<void>
  rejectAssignment(command: RejectAssignmentCommand): Promise<void>
  recordOutcome(command: RecordOutcomeCommand): Promise<void>
  markDeparture(command: MarkDepartureCommand): Promise<void>
  setAvailability(command: SetAvailabilityCommand): Promise<void>
  resetDemo(command: ResetDemoCommand): Promise<void>
}

/** The backend's stable error codes (Backend Requirements.md section 6). */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'OUTCOME_REQUIRED'
  | 'UNAUTHORIZED'
  /** Browser request from an origin outside the backend's CORS allowlist. */
  | 'ORIGIN_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'STALE_SESSION'
  | 'INVALID_TRANSITION'
  | 'REPLAY_CONFLICT'
  | 'OUTCOME_CONFLICT'
  | 'INTERNAL_ERROR'
  | 'DATABASE_UNAVAILABLE'

export type BoardErrorCode =
  /** Transport failed - last known board stays visible, retry is safe. */
  | 'Network'
  /** Server refused the transition (stale session, conflicting outcome, bad input). */
  | 'Conflict'
  /** Operator token missing or rejected. */
  | 'Unauthorized'
  /** Backend fault. */
  | 'Server'
  | 'Unknown'

const API_CODE_TO_BOARD_ERROR: Record<ApiErrorCode, { code: BoardErrorCode; retryable: boolean }> = {
  VALIDATION_ERROR: { code: 'Conflict', retryable: false },
  OUTCOME_REQUIRED: { code: 'Conflict', retryable: false },
  UNAUTHORIZED: { code: 'Unauthorized', retryable: false },
  // Misconfiguration (wrong VITE_API_BASE_URL/origin), not an operator action.
  ORIGIN_NOT_ALLOWED: { code: 'Unauthorized', retryable: false },
  NOT_FOUND: { code: 'Conflict', retryable: false },
  METHOD_NOT_ALLOWED: { code: 'Unknown', retryable: false },
  STALE_SESSION: { code: 'Conflict', retryable: false },
  INVALID_TRANSITION: { code: 'Conflict', retryable: false },
  REPLAY_CONFLICT: { code: 'Conflict', retryable: false },
  OUTCOME_CONFLICT: { code: 'Conflict', retryable: false },
  INTERNAL_ERROR: { code: 'Server', retryable: true },
  DATABASE_UNAVAILABLE: { code: 'Server', retryable: true },
}

/**
 * Short, operator-readable failure. SQL text and stack details never reach
 * the UI; `message` is what the Notice renders.
 */
export class BoardError extends Error {
  readonly code: BoardErrorCode
  readonly retryable: boolean
  readonly apiCode?: ApiErrorCode
  readonly status?: number

  constructor(
    code: BoardErrorCode,
    message: string,
    options?: { retryable?: boolean; status?: number; apiCode?: ApiErrorCode },
  ) {
    super(message)
    this.name = 'BoardError'
    this.code = code
    this.status = options?.status
    this.apiCode = options?.apiCode
    this.retryable = options?.retryable ?? (code === 'Network' || code === 'Server')
  }

  /** Builds a BoardError from the backend's {code, message} response body. */
  static fromApi(apiCode: ApiErrorCode, message: string, status: number): BoardError {
    const mapped = API_CODE_TO_BOARD_ERROR[apiCode] ?? { code: 'Unknown' as const, retryable: false }
    return new BoardError(mapped.code, message, { retryable: mapped.retryable, status, apiCode })
  }
}

export function toBoardError(cause: unknown): BoardError {
  if (cause instanceof BoardError) return cause
  if (cause instanceof DOMException && cause.name === 'AbortError') {
    return new BoardError('Network', 'Request cancelled.', { retryable: true })
  }
  return new BoardError('Unknown', 'Unexpected error. Try again.', { retryable: true })
}
