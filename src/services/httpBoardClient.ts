/**
 * HttpBoardClient - the integration adapter. No Supabase SDK, no SQL, no
 * credentials in the bundle.
 *
 * Frontend and backend are two independent projects/deployments; this client
 * never assumes same-origin hosting. Every request is built against a
 * configurable `VITE_API_BASE_URL` (see `src/lib/env.ts`), and the backend is
 * expected to answer with an environment-allowlisted CORS policy. An unset
 * base URL falls back to relative `/api/...` paths, which only works when a
 * dev proxy or reverse proxy happens to put both behind one origin - that is
 * a local convenience, not the supported production shape.
 *
 * The operator token is held in memory for the tab's lifetime only; it is not
 * an account system and is never written to storage.
 *
 * Routes, bodies and error codes mirror the backend's canonical contract
 * at `retail-intelligence-backend/src/contracts/{dto,errors}.ts`.
 */
import { BoardError } from './boardService.ts'
import type {
  AcceptAssignmentCommand,
  ApiErrorCode,
  BoardService,
  MarkDepartureCommand,
  RecordOutcomeCommand,
  RegisterVisitorCommand,
  RejectAssignmentCommand,
  ResetDemoCommand,
  SetAvailabilityCommand,
  UpdateAttributesCommand,
} from './boardService.ts'
import type { BoardSnapshot } from '../lib/types.ts'

export const BOARD_ROUTES = {
  board: '/api/board',
  arrivals: '/api/arrivals',
  attributes: (visitId: string) => `/api/visits/${encodeURIComponent(visitId)}/attributes`,
  accept: (assignmentId: string) => `/api/assignments/${encodeURIComponent(assignmentId)}/accept`,
  reject: (assignmentId: string) => `/api/assignments/${encodeURIComponent(assignmentId)}/reject`,
  outcome: (assignmentId: string) => `/api/assignments/${encodeURIComponent(assignmentId)}/outcome`,
  departure: (visitId: string) => `/api/visits/${encodeURIComponent(visitId)}/departure`,
  availability: '/api/availability',
  reset: '/api/demo/reset',
} as const

interface ApiErrorBody {
  code?: string
  message?: string
}

const KNOWN_API_CODES: readonly ApiErrorCode[] = [
  'VALIDATION_ERROR',
  'OUTCOME_REQUIRED',
  'UNAUTHORIZED',
  'ORIGIN_NOT_ALLOWED',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'STALE_SESSION',
  'INVALID_TRANSITION',
  'REPLAY_CONFLICT',
  'OUTCOME_CONFLICT',
  'INTERNAL_ERROR',
  'DATABASE_UNAVAILABLE',
]

export class HttpBoardClient implements BoardService {
  readonly mode = 'http' as const

  private token: string | null = null

  setToken(token: string | null): void {
    this.token = token === null || token.trim() === '' ? null : token.trim()
  }

  hasToken(): boolean {
    return this.token !== null
  }

  getBoard(options?: { signal?: AbortSignal }): Promise<BoardSnapshot> {
    return this.request<BoardSnapshot>('GET', BOARD_ROUTES.board, undefined, options?.signal)
  }

  async registerVisitor(command: RegisterVisitorCommand): Promise<void> {
    await this.request('POST', BOARD_ROUTES.arrivals, {
      sessionId: command.sessionId,
      eventId: command.eventId,
      source: 'Manual',
      detectedAt: null,
      attributes: command.attributes,
    })
  }

  async updateAttributes(command: UpdateAttributesCommand): Promise<void> {
    await this.request('PATCH', BOARD_ROUTES.attributes(command.visitId), {
      sessionId: command.sessionId,
      source: 'Manual',
      attributes: command.attributes,
      enrichmentStatus: 'NotRequested',
    })
  }

  async acceptAssignment(command: AcceptAssignmentCommand): Promise<void> {
    await this.request('POST', BOARD_ROUTES.accept(command.assignmentId), { sessionId: command.sessionId })
  }

  async rejectAssignment(command: RejectAssignmentCommand): Promise<void> {
    await this.request('POST', BOARD_ROUTES.reject(command.assignmentId), { sessionId: command.sessionId })
  }

  async recordOutcome(command: RecordOutcomeCommand): Promise<void> {
    await this.request('POST', BOARD_ROUTES.outcome(command.assignmentId), {
      sessionId: command.sessionId,
      outcome: command.outcome,
    })
  }

  async markDeparture(command: MarkDepartureCommand): Promise<void> {
    await this.request('POST', BOARD_ROUTES.departure(command.visitId), {
      sessionId: command.sessionId,
      outcome: command.outcome,
    })
  }

  async setAvailability(command: SetAvailabilityCommand): Promise<void> {
    await this.request('POST', BOARD_ROUTES.availability, {
      sessionId: command.sessionId,
      participantId: command.participantId,
      commandId: command.commandId,
      state: command.state,
    })
  }

  async resetDemo(command: ResetDemoCommand): Promise<void> {
    await this.request('POST', BOARD_ROUTES.reset, { sessionId: command.sessionId })
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const base = import.meta.env.VITE_API_BASE_URL ?? ''
    const url = `${base}${path}`
    let response: Response
    try {
      response = await fetch(url, {
        method,
        signal,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token === null ? {} : { Authorization: `Bearer ${this.token}` }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
      throw new BoardError('Network', 'Cannot reach the board service.', { retryable: true })
    }

    if (!response.ok) throw await toBoardError(response)

    if (response.status === 204) return undefined as T
    try {
      return (await response.json()) as T
    } catch {
      throw new BoardError('Server', 'The board service returned an unreadable response.')
    }
  }
}

/** Maps the backend's {code, message} body to a short operator-facing error. */
async function toBoardError(response: Response): Promise<BoardError> {
  let body: ApiErrorBody = {}
  try {
    body = (await response.json()) as ApiErrorBody
  } catch {
    body = {}
  }

  const message =
    typeof body.message === 'string' && body.message.length > 0 && body.message.length <= 160
      ? body.message
      : 'The board service rejected that request.'

  const apiCode = KNOWN_API_CODES.find((candidate) => candidate === body.code)
  if (apiCode !== undefined) return BoardError.fromApi(apiCode, message, response.status)

  // An unrecognised code or a non-JSON body: fall back to the HTTP status.
  if (response.status === 401 || response.status === 403) {
    return new BoardError('Unauthorized', message, { retryable: false, status: response.status })
  }
  if (response.status >= 500) {
    return new BoardError('Server', message, { retryable: true, status: response.status })
  }
  return new BoardError('Unknown', message, { status: response.status })
}
