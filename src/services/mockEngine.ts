/**
 * In-memory board engine for MockBoardClient.
 *
 * It follows the same transitions the real backend owns - FIFO registration,
 * one unfinished assignment per participant, bottom-of-rotation release,
 * waiting dispatch on returning capacity, state-checked idempotency, rejected
 * conflicts. The rules live here and not in components, so they exist in
 * exactly one place and can be deleted together with the mock adapter.
 *
 * Only arrival (`eventId`) and availability (`commandId`) carry a client
 * idempotency key, matching the backend contract; accept, outcome, departure
 * and attributes are made safe to retry by checking current state instead.
 *
 * Every mutation takes an explicit `at` timestamp, which keeps the seeded
 * review scenarios deterministic.
 */
import { BoardError } from './boardService.ts'
import type {
  ActivityKind,
  ActivityView,
  AssignmentPhase,
  AssignmentView,
  AssociateView,
  BoardSnapshot,
  CompletionReason,
  MetricsView,
  Outcome,
  ParticipantState,
  VisitorAttributes,
  VisitStatus,
  VisitView,
} from '../lib/types.ts'

/** Predefined roster. Survives Reset Demo; only the demo session is cleared. */
export const ASSOCIATE_ROSTER = [
  { associateId: 'as_1', displayName: 'Avery Collins' },
  { associateId: 'as_2', displayName: 'Jordan Reyes' },
  { associateId: 'as_3', displayName: 'Morgan Patel' },
] as const

interface MockParticipant {
  participantId: string
  associateId: string
  displayName: string
  state: ParticipantState
  queuePosition: number | null
  assignedTurns: number
  acceptedTurns: number
  currentAssignmentId: string | null
}

interface MockAssignment {
  assignmentId: string
  visitId: string
  participantId: string
  assignedAt: string
  acceptedAt: string | null
  completedAt: string | null
  completionReason: CompletionReason | null
}

interface MockVisit {
  visitId: string
  /** Internal FIFO rank; the DTO exposes order only as array position. */
  registrationOrder: number
  attributes: VisitorAttributes
  arrivedAt: string
  departedAt: string | null
  status: VisitStatus
  outcome: Outcome | null
  outcomeRecordedAt: string | null
}

export interface MockState {
  sessionId: string
  startedAt: string
  participants: MockParticipant[]
  visits: MockVisit[]
  assignments: MockAssignment[]
  /** Append order; the snapshot exposes it newest first. */
  activity: ActivityView[]
  /** Dedupe ledger for resubmitted arrivals: eventId -> the visit it created. */
  eventIdToVisitId: Map<string, string>
  /** Dedupe ledger for replayed availability commands. */
  seenAvailabilityCommandIds: Set<string>
  nextQueuePosition: number
  counters: Record<string, number>
}

function nextId(state: MockState, prefix: string): string {
  const current = (state.counters[prefix] ?? 0) + 1
  state.counters[prefix] = current
  return `${prefix}_${current}`
}

function logAt(
  state: MockState,
  at: string,
  kind: ActivityKind,
  description: string,
  refs?: { visitId?: string; participantId?: string; assignmentId?: string },
): void {
  state.activity.push({
    activityId: nextId(state, 'act'),
    occurredAt: at,
    kind,
    description,
    visitId: refs?.visitId ?? null,
    participantId: refs?.participantId ?? null,
    assignmentId: refs?.assignmentId ?? null,
  })
}

/* --------------------------------------------------------------- seeding */

export function createSession(sessionId: string, startedAt: string): MockState {
  const state: MockState = {
    sessionId,
    startedAt,
    participants: [],
    visits: [],
    assignments: [],
    // No activity entry for session start/reset: the backend's activity kinds
    // only cover board events, and a fresh session starts with an empty log.
    activity: [],
    eventIdToVisitId: new Map(),
    seenAvailabilityCommandIds: new Set(),
    nextQueuePosition: 1,
    counters: {},
  }

  // Deterministic initial order: roster order, all Available.
  for (const associate of ASSOCIATE_ROSTER) {
    state.participants.push({
      participantId: nextId(state, 'prt'),
      associateId: associate.associateId,
      displayName: associate.displayName,
      state: 'Available',
      queuePosition: state.nextQueuePosition++,
      assignedTurns: 0,
      acceptedTurns: 0,
      currentAssignmentId: null,
    })
  }

  return state
}

/* ------------------------------------------------------------- internals */

function requireSession(state: MockState, sessionId: string): void {
  if (sessionId !== state.sessionId) {
    throw new BoardError('Conflict', 'This demo session was reset. The board was reloaded.', {
      retryable: false,
      apiCode: 'STALE_SESSION',
    })
  }
}

function findVisit(state: MockState, visitId: string): MockVisit {
  const visit = state.visits.find((candidate) => candidate.visitId === visitId)
  if (visit === undefined) {
    throw new BoardError('Conflict', 'That visitor is no longer on the board.', {
      retryable: false,
      apiCode: 'NOT_FOUND',
    })
  }
  return visit
}

function findParticipant(state: MockState, participantId: string): MockParticipant {
  const participant = state.participants.find((candidate) => candidate.participantId === participantId)
  if (participant === undefined) {
    throw new BoardError('Conflict', 'That associate is no longer on the board.', {
      retryable: false,
      apiCode: 'NOT_FOUND',
    })
  }
  return participant
}

function findAssignment(state: MockState, assignmentId: string): MockAssignment {
  const assignment = state.assignments.find((candidate) => candidate.assignmentId === assignmentId)
  if (assignment === undefined) {
    throw new BoardError('Conflict', 'That UP no longer exists.', { retryable: false, apiCode: 'NOT_FOUND' })
  }
  return assignment
}

/** The unfinished assignment of a visit, if there is one. */
function openAssignmentOfVisit(state: MockState, visitId: string): MockAssignment | undefined {
  return state.assignments.find((a) => a.visitId === visitId && a.completedAt === null)
}

/** Open assignment if any, else the last closed one - what a visit row shows. */
function latestAssignmentOfVisit(state: MockState, visitId: string): MockAssignment | undefined {
  return openAssignmentOfVisit(state, visitId) ?? [...state.assignments].reverse().find((a) => a.visitId === visitId)
}

function eligibleParticipants(state: MockState): MockParticipant[] {
  return state.participants
    .filter((p) => p.state === 'Available' && p.queuePosition !== null)
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
}

/** Appends a released or returning participant to the bottom of rotation. */
function appendToQueue(state: MockState, participant: MockParticipant): void {
  participant.state = 'Available'
  participant.queuePosition = state.nextQueuePosition++
  participant.currentAssignmentId = null
}

/** Reserves the first eligible participant. Returns false when none exists. */
function reserveFor(state: MockState, visit: MockVisit, at: string): boolean {
  const participant = eligibleParticipants(state)[0]
  if (participant === undefined) return false

  const assignment: MockAssignment = {
    assignmentId: nextId(state, 'asg'),
    visitId: visit.visitId,
    participantId: participant.participantId,
    assignedAt: at,
    acceptedAt: null,
    completedAt: null,
    completionReason: null,
  }
  state.assignments.push(assignment)

  participant.state = 'PendingAcceptance'
  participant.queuePosition = null
  participant.currentAssignmentId = assignment.assignmentId
  participant.assignedTurns += 1

  visit.status = 'Assigned'

  logAt(state, at, 'AssignmentCreated', `UP assigned to ${participant.displayName}.`, {
    visitId: visit.visitId,
    participantId: participant.participantId,
    assignmentId: assignment.assignmentId,
  })
  return true
}

/**
 * Assigns Waiting visits in server registration order while capacity exists.
 * Runs after every event that can free a participant.
 */
function dispatchWaiting(state: MockState, at: string): void {
  const waiting = state.visits
    .filter((visit) => visit.status === 'Waiting' && visit.departedAt === null)
    .sort((a, b) => a.registrationOrder - b.registrationOrder)

  for (const visit of waiting) {
    if (!reserveFor(state, visit, at)) break
  }
}

/** Closes the open assignment of a visit and releases the participant once. */
function closeOpenAssignment(state: MockState, visitId: string, reason: CompletionReason, at: string): void {
  const assignment = openAssignmentOfVisit(state, visitId)
  if (assignment === undefined) return

  assignment.completedAt = at
  assignment.completionReason = reason

  const participant = state.participants.find((p) => p.participantId === assignment.participantId)
  if (participant !== undefined && participant.currentAssignmentId === assignment.assignmentId) {
    appendToQueue(state, participant)
  }
}

/* -------------------------------------------------------------- commands */

export interface RegisterVisitorResult {
  visitId: string
  duplicate: boolean
  status: VisitStatus
}

export function registerVisitor(
  state: MockState,
  input: { eventId: string; sessionId: string; attributes: VisitorAttributes },
  at: string,
): RegisterVisitorResult {
  requireSession(state, input.sessionId)

  const existingVisitId = state.eventIdToVisitId.get(input.eventId)
  if (existingVisitId !== undefined) {
    // A resubmitted intentional registration creates nothing extra.
    const existing = findVisit(state, existingVisitId)
    return { visitId: existing.visitId, duplicate: true, status: existing.status }
  }

  const visit: MockVisit = {
    visitId: nextId(state, 'vis'),
    registrationOrder: state.visits.length + 1,
    attributes: { ...input.attributes },
    arrivedAt: at,
    departedAt: null,
    status: 'Waiting',
    outcome: null,
    outcomeRecordedAt: null,
  }
  state.visits.push(visit)
  state.eventIdToVisitId.set(input.eventId, visit.visitId)
  logAt(state, at, 'ArrivalRecorded', 'Visitor registered manually.', { visitId: visit.visitId })

  // Reserved immediately; the visit stays Waiting when nobody is eligible.
  reserveFor(state, visit, at)
  return { visitId: visit.visitId, duplicate: false, status: visit.status }
}

export function updateAttributes(
  state: MockState,
  input: { sessionId: string; visitId: string; attributes: VisitorAttributes },
  at: string,
): void {
  requireSession(state, input.sessionId)
  const visit = findVisit(state, input.visitId)
  // Attributes only: timestamps, outcome, assignment and queue stay untouched.
  // A repeated identical PATCH is naturally idempotent - no ledger needed.
  visit.attributes = { ...input.attributes }
  logAt(state, at, 'VisitorAttributesUpdated', 'Visitor attributes corrected.', { visitId: visit.visitId })
}

export function acceptAssignment(
  state: MockState,
  input: { sessionId: string; assignmentId: string },
  at: string,
): void {
  requireSession(state, input.sessionId)
  const assignment = findAssignment(state, input.assignmentId)

  // Already accepted: a blind retry reports replayed, no further effect.
  if (assignment.acceptedAt !== null) return
  if (assignment.completedAt !== null) {
    throw new BoardError('Conflict', 'That turn is already closed.', {
      retryable: false,
      apiCode: 'INVALID_TRANSITION',
    })
  }

  const visit = findVisit(state, assignment.visitId)
  if (visit.departedAt !== null) {
    throw new BoardError('Conflict', 'That visitor has already left.', {
      retryable: false,
      apiCode: 'INVALID_TRANSITION',
    })
  }

  assignment.acceptedAt = at
  visit.status = 'Accepted'

  const participant = findParticipant(state, assignment.participantId)
  participant.state = 'OnUP'
  participant.acceptedTurns += 1

  logAt(state, at, 'AssignmentAccepted', `${participant.displayName} accepted the UP.`, {
    visitId: visit.visitId,
    participantId: participant.participantId,
    assignmentId: assignment.assignmentId,
  })
}

export function recordOutcome(
  state: MockState,
  input: { sessionId: string; assignmentId: string; outcome: Outcome },
  at: string,
): void {
  requireSession(state, input.sessionId)
  const assignment = findAssignment(state, input.assignmentId)
  const visit = findVisit(state, assignment.visitId)

  if (visit.outcome !== null) {
    // The same outcome again is a no-op; a different one is a real conflict.
    if (visit.outcome === input.outcome) return
    throw new BoardError('Conflict', 'A different purchase result is already recorded.', {
      retryable: false,
      apiCode: 'OUTCOME_CONFLICT',
    })
  }
  if (assignment.acceptedAt === null || assignment.completedAt !== null) {
    throw new BoardError('Conflict', 'Only an accepted, unfinished turn can record an outcome.', {
      retryable: false,
      apiCode: 'INVALID_TRANSITION',
    })
  }

  visit.outcome = input.outcome
  visit.outcomeRecordedAt = at
  // The turn is complete, but the visitor stays Inside until Mark Exit.
  visit.status = 'Completed'

  closeOpenAssignment(state, visit.visitId, 'OutcomeRecorded', at)

  logAt(state, at, 'TurnCompleted', input.outcome === 'Sale' ? 'Sale recorded.' : 'No-Sale recorded.', {
    visitId: visit.visitId,
    participantId: assignment.participantId,
    assignmentId: assignment.assignmentId,
  })

  dispatchWaiting(state, at)
}

export function markDeparture(
  state: MockState,
  input: { sessionId: string; visitId: string; outcome: Outcome | null },
  at: string,
): void {
  requireSession(state, input.sessionId)
  const visit = findVisit(state, input.visitId)

  if (visit.departedAt !== null) {
    // A duplicate departure preserves the original time and result.
    if (input.outcome !== null && visit.outcome !== input.outcome) {
      throw new BoardError('Conflict', 'A different purchase result is already recorded.', {
        retryable: false,
        apiCode: 'OUTCOME_CONFLICT',
      })
    }
    return
  }

  if (visit.outcome === null) {
    if (input.outcome === null) {
      throw new BoardError('Conflict', 'Select Sale or No-Sale before recording the exit.', {
        retryable: false,
        apiCode: 'OUTCOME_REQUIRED',
      })
    }
    visit.outcome = input.outcome
    visit.outcomeRecordedAt = at
  } else if (input.outcome !== null && input.outcome !== visit.outcome) {
    throw new BoardError('Conflict', 'A different purchase result is already recorded.', {
      retryable: false,
      apiCode: 'OUTCOME_CONFLICT',
    })
  }

  const wasAlreadyComplete = visit.status === 'Completed'

  visit.departedAt = at
  visit.status = 'Completed'

  // Already-completed service does not touch the participant or the queue,
  // even if that participant now serves another visitor.
  if (!wasAlreadyComplete) {
    closeOpenAssignment(state, visit.visitId, 'Departure', at)
  }

  logAt(state, at, 'VisitorDeparted', 'Visitor exit recorded.', { visitId: visit.visitId })

  if (!wasAlreadyComplete) dispatchWaiting(state, at)
}

export function setAvailability(
  state: MockState,
  input: { sessionId: string; participantId: string; commandId: string; state: 'Available' | 'OffFloor' },
  at: string,
): void {
  requireSession(state, input.sessionId)
  // A delayed replay of the original commandId must not append again or undo
  // a later change.
  if (state.seenAvailabilityCommandIds.has(input.commandId)) return
  state.seenAvailabilityCommandIds.add(input.commandId)

  const participant = findParticipant(state, input.participantId)

  if (participant.state === 'PendingAcceptance' || participant.state === 'OnUP') {
    throw new BoardError('Conflict', 'Only an idle associate can change availability.', {
      retryable: false,
      apiCode: 'INVALID_TRANSITION',
    })
  }
  if (participant.state === input.state) return

  if (input.state === 'OffFloor') {
    participant.state = 'OffFloor'
    participant.queuePosition = null
  } else {
    appendToQueue(state, participant)
  }

  logAt(
    state,
    at,
    'AvailabilityChanged',
    `${participant.displayName} marked ${input.state === 'OffFloor' ? 'Off Floor' : 'Available'}.`,
    { participantId: participant.participantId },
  )

  if (input.state === 'Available') dispatchWaiting(state, at)
}

/* -------------------------------------------------------------- snapshot */

function metricsOf(state: MockState): MetricsView {
  // All current-run visits are the denominator; Sale visits the numerator.
  const visitors = state.visits.length
  const closedSales = state.visits.filter((visit) => visit.outcome === 'Sale').length
  return {
    visitors,
    assignedTurns: state.assignments.length,
    acceptedTurns: state.assignments.filter((a) => a.acceptedAt !== null).length,
    closedSales,
    conversionRate: visitors === 0 ? 0 : (closedSales / visitors) * 100,
  }
}

/** 1-based FIFO rank among Waiting, still-inside visitors; null otherwise. */
function waitingPositionOf(state: MockState, visit: MockVisit): number | null {
  if (visit.status !== 'Waiting' || visit.departedAt !== null) return null
  const waitingOrder = state.visits
    .filter((candidate) => candidate.status === 'Waiting' && candidate.departedAt === null)
    .sort((a, b) => a.registrationOrder - b.registrationOrder)
  return waitingOrder.findIndex((candidate) => candidate.visitId === visit.visitId) + 1
}

function toVisitView(state: MockState, visit: MockVisit): VisitView {
  const assignment = latestAssignmentOfVisit(state, visit.visitId)
  return {
    visitId: visit.visitId,
    arrivedAt: visit.arrivedAt,
    detectedAt: null,
    departedAt: visit.departedAt,
    source: 'Manual',
    status: visit.status,
    attributes: { ...visit.attributes },
    attributesSource: 'Manual',
    enrichmentStatus: 'NotRequested',
    outcome: visit.outcome,
    outcomeRecordedAt: visit.outcomeRecordedAt,
    waitingPosition: waitingPositionOf(state, visit),
    assignmentId: assignment?.assignmentId ?? null,
  }
}

function phaseOf(assignment: MockAssignment): AssignmentPhase {
  if (assignment.completedAt !== null) return 'Completed'
  if (assignment.acceptedAt !== null) return 'Accepted'
  return 'PendingAcceptance'
}

function toAssignmentView(assignment: MockAssignment): AssignmentView {
  return {
    assignmentId: assignment.assignmentId,
    visitId: assignment.visitId,
    participantId: assignment.participantId,
    phase: phaseOf(assignment),
    assignedAt: assignment.assignedAt,
    acceptedAt: assignment.acceptedAt,
    completedAt: assignment.completedAt,
    completionReason: assignment.completionReason,
  }
}

function toAssociateView(participant: MockParticipant): AssociateView {
  return {
    participantId: participant.participantId,
    associateId: participant.associateId,
    displayName: participant.displayName,
    state: participant.state,
    queuePosition: participant.queuePosition,
    currentAssignmentId: participant.currentAssignmentId,
    assignedTurns: participant.assignedTurns,
    acceptedTurns: participant.acceptedTurns,
  }
}

export function toSnapshot(state: MockState, serverTime: string): BoardSnapshot {
  return {
    session: { sessionId: state.sessionId, startedAt: state.startedAt },
    associates: state.participants.map(toAssociateView),
    visits: [...state.visits]
      .sort((a, b) => a.registrationOrder - b.registrationOrder)
      .map((visit) => toVisitView(state, visit)),
    assignments: state.assignments.map(toAssignmentView),
    metrics: metricsOf(state),
    activity: [...state.activity].reverse(),
    serverTime,
  }
}
