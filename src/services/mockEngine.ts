/**
 * In-memory board engine for MockBoardClient.
 *
 * Implements "Assignment Rotation Revision - Advance on Acceptance":
 *  - an associate's own availability is only Available/OffFloor; accepted,
 *    unfinished work never makes them ineligible, and multiple accepted
 *    unfinished assignments per participant are valid
 *  - at most ONE unresolved pending offer exists across the whole session;
 *    later Waiting visitors wait for it regardless of how many other
 *    associates are Available
 *  - offering a visit never touches the offered participant's queue
 *    position or availability; only *accepting* moves them to the bottom,
 *    exactly once, and immediately tries the next oldest Waiting visit
 *  - a normal outcome (Sale/No-Sale) never changes rotation or availability
 *  - departure of a still-pending offer clears the gate without consuming
 *    the participant's turn or moving the queue; departure of an accepted
 *    or completed turn does not touch rotation either
 *
 * The rules live here and not in components, so they exist in exactly one
 * place and can be deleted together with the mock adapter. Only arrival
 * (`eventId`) and availability (`commandId`) carry a client idempotency key,
 * matching the backend contract; accept, outcome, departure and attributes
 * are made safe to retry by checking current state instead.
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
  AvailabilityState,
  BoardSnapshot,
  CompletionReason,
  MetricsView,
  Outcome,
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
  state: AvailabilityState
  /**
   * Raw, ever-increasing ordering token; null when OffFloor. The DTO does
   * NOT expose this directly - `queuePosition` on the wire is a dense
   * 1-based rank among currently-Available associates, recomputed at
   * snapshot time (confirmed against the live backend: marking one
   * associate OffFloor compacts the remaining ranks, and a returning
   * associate reappears at the new bottom rank, not at a raw token value).
   */
  queueOrder: number | null
  /** Created offers, including ones later closed by early departure. */
  assignedTurns: number
  acceptedTurns: number
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
  nextQueueOrder: number
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
    nextQueueOrder: 1,
    counters: {},
  }

  // Deterministic initial order: roster order, all Available.
  for (const associate of ASSOCIATE_ROSTER) {
    state.participants.push({
      participantId: nextId(state, 'prt'),
      associateId: associate.associateId,
      displayName: associate.displayName,
      state: 'Available',
      queueOrder: state.nextQueueOrder++,
      assignedTurns: 0,
      acceptedTurns: 0,
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

/** The one unresolved offer across the whole session, if any. */
function pendingOffer(state: MockState): MockAssignment | undefined {
  return state.assignments.find((a) => a.acceptedAt === null && a.completedAt === null)
}

/** The unfinished (pending or accepted) assignment of a visit, if there is one. */
function openAssignmentOfVisit(state: MockState, visitId: string): MockAssignment | undefined {
  return state.assignments.find((a) => a.visitId === visitId && a.completedAt === null)
}

/** Open assignment if any, else the last closed one - what a visit row shows. */
function latestAssignmentOfVisit(state: MockState, visitId: string): MockAssignment | undefined {
  return openAssignmentOfVisit(state, visitId) ?? [...state.assignments].reverse().find((a) => a.visitId === visitId)
}

function eligibleParticipants(state: MockState): MockParticipant[] {
  return state.participants
    .filter((p) => p.state === 'Available' && p.queueOrder !== null)
    .sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0))
}

/** Appends a returning or just-accepted participant to the bottom of rotation. */
function appendToQueue(state: MockState, participant: MockParticipant): void {
  participant.state = 'Available'
  participant.queueOrder = state.nextQueueOrder++
}

/**
 * Dense 1-based rank among currently-Available associates, by their raw
 * ordering token. This is what `AssociateView.queuePosition` exposes - the
 * raw token itself only matters for relative order, never on the wire.
 */
function queueRanks(state: MockState): Map<string, number> {
  const ranked = eligibleParticipants(state)
  return new Map(ranked.map((participant, index) => [participant.participantId, index + 1]))
}

/**
 * Creates the session's one offer, if none is currently unresolved: the
 * oldest Waiting visit to the front-of-queue Available participant. Offering
 * never moves the participant or changes their availability - only accepting
 * does that. Returns true when an offer was created.
 */
function tryCreateOffer(state: MockState, at: string): boolean {
  if (pendingOffer(state) !== undefined) return false

  const visit = state.visits
    .filter((v) => v.status === 'Waiting' && v.departedAt === null)
    .sort((a, b) => a.registrationOrder - b.registrationOrder)[0]
  if (visit === undefined) return false

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
  participant.assignedTurns += 1
  visit.status = 'Assigned'

  logAt(state, at, 'AssignmentCreated', `UP offered to ${participant.displayName}.`, {
    visitId: visit.visitId,
    participantId: participant.participantId,
    assignmentId: assignment.assignmentId,
  })
  return true
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

  // Offers the oldest Waiting visit (which may not be this one, if an
  // earlier arrival is still waiting) - stays Waiting if no offer can be made.
  tryCreateOffer(state, at)
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
    // Closed by an early departure before acceptance: never fabricate one.
    throw new BoardError('Conflict', 'That offer was already closed by a departure.', {
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
  participant.acceptedTurns += 1
  // Advances the queue exactly once, on acceptance - never on offer, outcome
  // or departure. Accepted, unfinished work never blocks future offers to
  // this same participant.
  appendToQueue(state, participant)

  logAt(state, at, 'AssignmentAccepted', `${participant.displayName} accepted the UP.`, {
    visitId: visit.visitId,
    participantId: participant.participantId,
    assignmentId: assignment.assignmentId,
  })

  // The gate is clear: offer the next oldest Waiting visit, if any.
  tryCreateOffer(state, at)
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
    // A turn closed by departure before acceptance cannot receive an outcome.
    throw new BoardError('Conflict', 'Only an accepted, unfinished turn can record an outcome.', {
      retryable: false,
      apiCode: 'INVALID_TRANSITION',
    })
  }

  visit.outcome = input.outcome
  visit.outcomeRecordedAt = at
  // The turn is complete, but the visitor stays Inside until Mark Exit.
  visit.status = 'Completed'

  assignment.completedAt = at
  assignment.completionReason = 'OutcomeRecorded'
  // Rotation/availability are untouched: acceptance already advanced the
  // queue, and a normal outcome never moves it again.

  logAt(state, at, 'TurnCompleted', input.outcome === 'Sale' ? 'Sale recorded.' : 'No-Sale recorded.', {
    visitId: visit.visitId,
    participantId: assignment.participantId,
    assignmentId: assignment.assignmentId,
  })
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

  if (!wasAlreadyComplete) {
    const assignment = openAssignmentOfVisit(state, visit.visitId)
    if (assignment !== undefined) {
      assignment.completedAt = at
      assignment.completionReason = 'Departure'
      // Pending-offer departure clears the gate without consuming the
      // participant's turn or moving the queue. An accepted-but-unfinished
      // departure likewise never touches rotation - acceptance already
      // moved that participant once, and this does not move them again.
    }
  }

  logAt(state, at, 'VisitorDeparted', 'Visitor exit recorded.', { visitId: visit.visitId })

  // Harmless no-op unless this departure was the pending offer: then the
  // gate just cleared and the next oldest Waiting visit can be offered.
  if (!wasAlreadyComplete) tryCreateOffer(state, at)
}

export function setAvailability(
  state: MockState,
  input: { sessionId: string; participantId: string; commandId: string; state: AvailabilityState },
  at: string,
): void {
  requireSession(state, input.sessionId)
  // A delayed replay of the original commandId must not append again or undo
  // a later change.
  if (state.seenAvailabilityCommandIds.has(input.commandId)) return
  state.seenAvailabilityCommandIds.add(input.commandId)

  const participant = findParticipant(state, input.participantId)

  // Request to set a participant to their existing state is a no-op: keep
  // queue position, append no activity, but the command is still recorded
  // (the replay guard above already did that).
  if (participant.state === input.state) return

  if (input.state === 'OffFloor') {
    // Rejected only while this participant owns the one unresolved pending
    // offer; accepted, unfinished work never blocks it.
    const offer = pendingOffer(state)
    if (offer !== undefined && offer.participantId === participant.participantId) {
      throw new BoardError('Conflict', 'Resolve the pending offer before marking Off Floor.', {
        retryable: false,
        apiCode: 'INVALID_TRANSITION',
      })
    }
    participant.state = 'OffFloor'
    participant.queueOrder = null
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

  // Returning Available attempts a dispatch; it is a no-op if a different
  // offer is already pending.
  if (input.state === 'Available') tryCreateOffer(state, at)
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

function toAssociateView(state: MockState, participant: MockParticipant, rank: number | null): AssociateView {
  const own = state.assignments.filter((a) => a.participantId === participant.participantId)
  const pending = own.find((a) => a.acceptedAt === null && a.completedAt === null)
  const active = own.filter((a) => a.acceptedAt !== null && a.completedAt === null)
  return {
    participantId: participant.participantId,
    associateId: participant.associateId,
    displayName: participant.displayName,
    state: participant.state,
    queuePosition: rank,
    pendingAssignmentId: pending?.assignmentId ?? null,
    activeAssignmentIds: active.map((a) => a.assignmentId),
    activeTurns: active.length,
    assignedTurns: participant.assignedTurns,
    acceptedTurns: participant.acceptedTurns,
  }
}

export function toSnapshot(state: MockState, serverTime: string): BoardSnapshot {
  const ranks = queueRanks(state)
  return {
    session: { sessionId: state.sessionId, startedAt: state.startedAt },
    associates: state.participants.map((participant) =>
      toAssociateView(state, participant, ranks.get(participant.participantId) ?? null),
    ),
    visits: [...state.visits]
      .sort((a, b) => a.registrationOrder - b.registrationOrder)
      .map((visit) => toVisitView(state, visit)),
    assignments: state.assignments.map(toAssignmentView),
    metrics: metricsOf(state),
    activity: [...state.activity].reverse(),
    serverTime,
  }
}
