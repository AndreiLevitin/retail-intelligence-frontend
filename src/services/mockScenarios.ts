/**
 * Deterministic review scenarios for MockBoardClient.
 *
 * Each one is built by replaying real engine transitions, so a seeded board is
 * always a state the backend could actually produce. `Reset Demo` is an action
 * available in every scenario rather than a scenario of its own.
 */
import {
  acceptAssignment,
  createSession,
  markDeparture,
  recordOutcome,
  registerVisitor,
  setAvailability,
} from './mockEngine.ts'
import type { MockState } from './mockEngine.ts'
import type { VisitorAttributes } from '../lib/types.ts'

export type ScenarioId =
  | 'empty'
  | 'pending'
  | 'accepted'
  | 'completed-inside'
  | 'waiting-no-capacity'
  | 'departed-waiting'
  | 'departed-completed'
  | 'api-failure'

export interface MockScenario {
  id: ScenarioId
  label: string
  /** Shown in the mock-mode panel so a reviewer knows what to look for. */
  description: string
  /** Number of initial reads that fail before the client recovers. */
  failingReads?: number
  build: (base: Date) => MockState
}

/* ------------------------------------------------------------- fixtures */

const attributes: Record<string, VisitorAttributes> = {
  puffer: {
    upperDescription: 'Navy puffer jacket',
    lowerDescription: 'Grey jeans',
    accessoryDescription: 'Black backpack',
    ageGroup: 'From20To39',
    gender: 'Female',
  },
  trench: {
    upperDescription: 'Beige trench coat',
    lowerDescription: 'Black trousers',
    accessoryDescription: null,
    ageGroup: 'From40To59',
    gender: 'Male',
  },
  // Nothing could be determined: the row must fall back to a readable label
  // instead of fabricated text or a guessed demographic.
  unknown: {
    upperDescription: '',
    lowerDescription: '',
    accessoryDescription: null,
    ageGroup: 'Unknown',
    gender: 'Unknown',
  },
  hoodie: {
    upperDescription: 'Red hoodie',
    lowerDescription: 'Blue shorts',
    accessoryDescription: 'Yellow cap',
    ageGroup: 'Under20',
    gender: 'Unknown',
  },
}

/** Minutes after the session start, as an ISO timestamp. */
function at(base: Date, minutes: number): string {
  return new Date(base.getTime() + minutes * 60_000).toISOString()
}

let seedCounter = 0

function freshSession(base: Date): MockState {
  seedCounter += 1
  return createSession(`ses_mock_${seedCounter}`, base.toISOString())
}

/** Registers a visitor and returns the id of the visit just created. */
function arrive(state: MockState, profile: VisitorAttributes, when: string, eventId?: string): string {
  const result = registerVisitor(
    state,
    { eventId: eventId ?? `seed_evt_${state.visits.length + 1}`, sessionId: state.sessionId, attributes: profile },
    when,
  )
  return result.visitId
}

function openAssignmentId(state: MockState, visitId: string): string {
  const visit = state.visits.find((candidate) => candidate.visitId === visitId)
  if (visit === undefined) throw new Error(`Scenario seed: unknown visit ${visitId}`)
  const assignment = state.assignments.find((a) => a.visitId === visitId && a.completedAt === null)
  if (assignment === undefined) throw new Error(`Scenario seed: no open assignment for ${visitId}`)
  return assignment.assignmentId
}

function accept(state: MockState, visitId: string, when: string): void {
  acceptAssignment(state, { sessionId: state.sessionId, assignmentId: openAssignmentId(state, visitId) }, when)
}

/* ------------------------------------------------------------ scenarios */

export const MOCK_SCENARIOS: MockScenario[] = [
  {
    id: 'empty',
    label: 'Empty run',
    description: 'Seeded session, three Available associates, no visits. Zero counts and 0% conversion.',
    build: (base) => freshSession(base),
  },
  {
    id: 'pending',
    label: 'Pending turn',
    description: 'One visitor Assigned; the reserved associate is Pending Acceptance. Accept UP is the next step.',
    build: (base) => {
      const state = freshSession(base)
      arrive(state, attributes.puffer, at(base, 4))
      return state
    },
  },
  {
    id: 'accepted',
    label: 'Accepted turn',
    description: 'Turn accepted, associate On UP, visitor Accepted and Inside. Sale / No-Sale is available.',
    build: (base) => {
      const state = freshSession(base)
      const visitId = arrive(state, attributes.puffer, at(base, 4))
      accept(state, visitId, at(base, 6))
      return state
    },
  },
  {
    id: 'completed-inside',
    label: 'Completed but Inside',
    description:
      'Sale recorded, so the turn is Completed while presence is still Inside. The associate is back at the bottom of rotation.',
    build: (base) => {
      const state = freshSession(base)
      const visitId = arrive(state, attributes.trench, at(base, 3))
      accept(state, visitId, at(base, 5))
      recordOutcome(
        state,
        { sessionId: state.sessionId, assignmentId: openAssignmentId(state, visitId), outcome: 'Sale' },
        at(base, 12),
      )
      return state
    },
  },
  {
    id: 'waiting-no-capacity',
    label: 'Waiting, no capacity',
    description:
      'One associate On UP, one Pending Acceptance, one Off Floor, so the newest visitor stays Waiting with no assignment.',
    build: (base) => {
      const state = freshSession(base)
      const first = arrive(state, attributes.puffer, at(base, 2))
      accept(state, first, at(base, 4))
      arrive(state, attributes.trench, at(base, 7))
      // The third associate is still idle at this point, so Off Floor is allowed.
      const idle = state.participants.find((p) => p.state === 'Available')
      if (idle !== undefined) {
        setAvailability(
          state,
          { sessionId: state.sessionId, participantId: idle.participantId, commandId: 'seed_cmd_offfloor_1', state: 'OffFloor' },
          at(base, 8),
        )
      }
      arrive(state, attributes.unknown, at(base, 10))
      return state
    },
  },
  {
    id: 'departed-waiting',
    label: 'Departed without assignment',
    description:
      'A Waiting visitor left with No-Sale recorded and zero assignments - purchase result without an associate or turn.',
    build: (base) => {
      const state = freshSession(base)
      const first = arrive(state, attributes.puffer, at(base, 2))
      accept(state, first, at(base, 4))
      arrive(state, attributes.trench, at(base, 6))
      const idle = state.participants.find((p) => p.state === 'Available')
      if (idle !== undefined) {
        setAvailability(
          state,
          { sessionId: state.sessionId, participantId: idle.participantId, commandId: 'seed_cmd_offfloor_1', state: 'OffFloor' },
          at(base, 7),
        )
      }
      const waiting = arrive(state, attributes.hoodie, at(base, 9))
      markDeparture(state, { sessionId: state.sessionId, visitId: waiting, outcome: 'NoSale' }, at(base, 14))
      return state
    },
  },
  {
    id: 'departed-completed',
    label: 'Departed after completion',
    description: 'Exit recorded after a Sale: the existing result is preserved read-only and the queue is untouched.',
    build: (base) => {
      const state = freshSession(base)
      const visitId = arrive(state, attributes.trench, at(base, 3))
      accept(state, visitId, at(base, 5))
      recordOutcome(
        state,
        { sessionId: state.sessionId, assignmentId: openAssignmentId(state, visitId), outcome: 'Sale' },
        at(base, 11),
      )
      markDeparture(state, { sessionId: state.sessionId, visitId, outcome: null }, at(base, 16))
      arrive(state, attributes.hoodie, at(base, 18))
      return state
    },
  },
  {
    id: 'api-failure',
    label: 'Temporary API failure',
    description: 'The first two reads fail, so loading and offline states appear before the board recovers on retry.',
    failingReads: 2,
    build: (base) => {
      const state = freshSession(base)
      const visitId = arrive(state, attributes.puffer, at(base, 4))
      accept(state, visitId, at(base, 6))
      return state
    },
  },
]

export const DEFAULT_SCENARIO_ID: ScenarioId = 'pending'

export function findScenario(id: ScenarioId): MockScenario {
  const scenario = MOCK_SCENARIOS.find((candidate) => candidate.id === id)
  if (scenario === undefined) throw new Error(`Unknown mock scenario: ${id}`)
  return scenario
}

/** Session start used by seeded scenarios: 45 minutes of demo history. */
export function defaultScenarioBase(): Date {
  return new Date(Date.now() - 45 * 60_000)
}
