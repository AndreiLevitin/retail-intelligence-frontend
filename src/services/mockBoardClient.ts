/**
 * MockBoardClient - a replaceable BoardService implementation for frontend
 * review. It is the only place mock behaviour exists; no component knows the
 * board is simulated.
 */
import { BoardError } from './boardService.ts'
import type {
  AcceptAssignmentCommand,
  BoardService,
  MarkDepartureCommand,
  RecordOutcomeCommand,
  RegisterVisitorCommand,
  ResetDemoCommand,
  SetAvailabilityCommand,
  UpdateAttributesCommand,
} from './boardService.ts'
import * as engine from './mockEngine.ts'
import type { MockState } from './mockEngine.ts'
import { DEFAULT_SCENARIO_ID, defaultScenarioBase, findScenario } from './mockScenarios.ts'
import type { ScenarioId } from './mockScenarios.ts'
import type { BoardSnapshot } from '../lib/types.ts'

/** Extra surface the mock-mode review panel uses. Not part of BoardService. */
export interface MockBoardController {
  readonly scenarioId: ScenarioId
  loadScenario(id: ScenarioId): void
  /** Makes the next read fail once, to exercise the offline indicator. */
  failNextRead(): void
}

const READ_LATENCY_MS = 180
const WRITE_LATENCY_MS = 320

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class MockBoardClient implements BoardService, MockBoardController {
  readonly mode = 'mock' as const

  private state: MockState
  private scenario: ScenarioId
  private pendingFailures: number

  constructor(scenarioId: ScenarioId = DEFAULT_SCENARIO_ID) {
    this.scenario = scenarioId
    const scenario = findScenario(scenarioId)
    this.state = scenario.build(defaultScenarioBase())
    this.pendingFailures = scenario.failingReads ?? 0
  }

  get scenarioId(): ScenarioId {
    return this.scenario
  }

  loadScenario(id: ScenarioId): void {
    const scenario = findScenario(id)
    this.scenario = id
    this.state = scenario.build(defaultScenarioBase())
    this.pendingFailures = scenario.failingReads ?? 0
  }

  failNextRead(): void {
    this.pendingFailures += 1
  }

  async getBoard(options?: { signal?: AbortSignal }): Promise<BoardSnapshot> {
    await delay(READ_LATENCY_MS, options?.signal)
    if (this.pendingFailures > 0) {
      this.pendingFailures -= 1
      throw new BoardError('Network', 'Cannot reach the board service.', { retryable: true })
    }
    return engine.toSnapshot(this.state, new Date().toISOString())
  }

  async registerVisitor(command: RegisterVisitorCommand): Promise<void> {
    await this.write(() => engine.registerVisitor(this.state, command, this.now()))
  }

  async updateAttributes(command: UpdateAttributesCommand): Promise<void> {
    await this.write(() => engine.updateAttributes(this.state, command, this.now()))
  }

  async acceptAssignment(command: AcceptAssignmentCommand): Promise<void> {
    await this.write(() => engine.acceptAssignment(this.state, command, this.now()))
  }

  async recordOutcome(command: RecordOutcomeCommand): Promise<void> {
    await this.write(() => engine.recordOutcome(this.state, command, this.now()))
  }

  async markDeparture(command: MarkDepartureCommand): Promise<void> {
    await this.write(() => engine.markDeparture(this.state, command, this.now()))
  }

  async setAvailability(command: SetAvailabilityCommand): Promise<void> {
    await this.write(() => engine.setAvailability(this.state, command, this.now()))
  }

  async resetDemo(command: ResetDemoCommand): Promise<void> {
    await delay(WRITE_LATENCY_MS)
    // The reset itself is session-scoped: a stale sessionId (e.g. a second
    // click's request, issued against an already-replaced session) is
    // rejected rather than silently creating another fresh run.
    if (command.sessionId !== this.state.sessionId) {
      throw new BoardError('Conflict', 'This demo session was already reset.', {
        retryable: false,
        apiCode: 'STALE_SESSION',
      })
    }
    // One step: new session identity and start time, old demo data gone,
    // participants reseeded Available in initial order. The roster itself
    // (associateId / displayName) is persistent and is not cleared.
    this.state = engine.createSession(`ses_${Date.now().toString(36)}`, new Date().toISOString())
  }

  private now(): string {
    return new Date().toISOString()
  }

  private async write(apply: () => void): Promise<void> {
    await delay(WRITE_LATENCY_MS)
    apply()
  }
}
