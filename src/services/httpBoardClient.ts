/**
 * HttpBoardClient - the integration adapter. Same-origin `/api` paths, no
 * Supabase SDK, no SQL, no credentials in the bundle.
 *
 * The operator token is held in memory for the tab's lifetime only; it is not
 * an account system and is never written to storage.
 *
 * The route shapes below are the frontend's assumption about the Vercel API.
 * See README "Remaining API integration work" before wiring the real backend.
 */
import { BoardError } from './boardService.ts'
import type {
  AcceptAssignmentCommand,
  BoardService,
  MarkExitCommand,
  RecordOutcomeCommand,
  RegisterVisitorCommand,
  ResetDemoCommand,
  SetAvailabilityCommand,
  UpdateProfileCommand,
} from './boardService.ts'
import type { BoardSnapshot } from '../lib/types.ts'

export const BOARD_ROUTES = {
  board: '/api/board',
  visits: '/api/visits',
  profile: (visitId: string) => `/api/visits/${encodeURIComponent(visitId)}/profile`,
  accept: (assignmentId: string) => `/api/assignments/${encodeURIComponent(assignmentId)}/accept`,
  outcome: (visitId: string) => `/api/visits/${encodeURIComponent(visitId)}/outcome`,
  exit: (visitId: string) => `/api/visits/${encodeURIComponent(visitId)}/exit`,
  availability: (participantId: string) => `/api/participants/${encodeURIComponent(participantId)}/availability`,
  reset: '/api/demo/reset',
} as const

interface ApiErrorBody {
  message?: string
  code?: string
}

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
    await this.request('POST', BOARD_ROUTES.visits, command)
  }

  async updateVisitorProfile(command: UpdateProfileCommand): Promise<void> {
    await this.request('PATCH', BOARD_ROUTES.profile(command.visitId), command)
  }

  async acceptAssignment(command: AcceptAssignmentCommand): Promise<void> {
    await this.request('POST', BOARD_ROUTES.accept(command.assignmentId), command)
  }

  async recordOutcome(command: RecordOutcomeCommand): Promise<void> {
    await this.request('POST', BOARD_ROUTES.outcome(command.visitId), command)
  }

  async markExit(command: MarkExitCommand): Promise<void> {
    await this.request('POST', BOARD_ROUTES.exit(command.visitId), command)
  }

  async setAvailability(command: SetAvailabilityCommand): Promise<void> {
    await this.request('POST', BOARD_ROUTES.availability(command.participantId), command)
  }

  async resetDemo(command: ResetDemoCommand): Promise<void> {
    await this.request('POST', BOARD_ROUTES.reset, command)
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response
    try {
      response = await fetch(path, {
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

/** Maps an HTTP failure to a short operator message - never SQL or stack text. */
async function toBoardError(response: Response): Promise<BoardError> {
  let body: ApiErrorBody = {}
  try {
    body = (await response.json()) as ApiErrorBody
  } catch {
    body = {}
  }
  const detail = typeof body.message === 'string' && body.message.length > 0 && body.message.length <= 160
    ? body.message
    : null

  if (response.status === 401 || response.status === 403) {
    return new BoardError('Unauthorized', detail ?? 'Operator token was rejected.', {
      retryable: false,
      status: response.status,
    })
  }
  if (response.status === 409 || response.status === 422 || response.status === 400) {
    return new BoardError('Conflict', detail ?? 'The board rejected that action. Reloading current state.', {
      retryable: false,
      status: response.status,
    })
  }
  if (response.status >= 500) {
    return new BoardError('Server', detail ?? 'The board service failed. Try again.', {
      retryable: true,
      status: response.status,
    })
  }
  return new BoardError('Unknown', detail ?? 'Request failed.', { status: response.status })
}
