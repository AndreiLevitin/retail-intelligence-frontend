/**
 * In-memory board engine for MockBoardClient.
 *
 * It follows the same transitions the real backend owns - FIFO registration,
 * one unfinished assignment per participant, bottom-of-rotation release,
 * waiting dispatch on returning capacity, idempotent commands. The rules live
 * here and not in components, so they exist in exactly one place and can be
 * deleted together with the mock adapter.
 *
 * Every mutation takes an explicit `at` timestamp, which keeps the seeded
 * review scenarios deterministic.
 */
import { BoardError } from './boardService.ts'
import type {
  ActivityEntryDto,
  ActivityKind,
  AssignmentCompletionReason,
  BoardSnapshot,
  MetricsDto,
  ParticipantDto,
  ParticipantState,
  PurchaseResult,
  ServiceStatus,
  VisitDto,
  VisitorProfileDto,
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
  assignedCount: number
  acceptedCount: number
  currentAssignmentId: string | null
}

interface MockAssignment {
  assignmentId: string
  visitId: string
  participantId: string
  assignedAt: string
  acceptedAt: string | null
  completedAt: string | null
  completionReason: AssignmentCompletionReason | null
}

interface MockVisit {
  visitId: string
  registrationOrder: number
  profile: VisitorProfileDto
  arrivedAt: string
  departedAt: string | null
  serviceStatus: ServiceStatus
  purchaseResult: PurchaseResult | null
  purchaseRecordedAt: string | null
}

export interface MockState {
  sessionId: string
  startedAt: string
  participants: MockParticipant[]
  visits: MockVisit[]
  assignments: MockAssignment[]
  /** Append order; the snapshot exposes it newest first. */
  activity: ActivityEntryDto[]
  revision: number
  /** Idempotency ledgers for replayed registrations and commands. */
  seenEventIds: Set<string>
  seenCommandIds: Set<string>
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
  message: string,
  refs?: { visitId?: string; participantId?: string },
): void {
  state.activity.push({
    entryId: nextId(state, 'act'),
    occurredAt: at,
    kind,
    message,
    ...refs,
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
    activity: [],
    revision: 1,
    seenEventIds: new Set(),
    seenCommandIds: new Set(),
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
      assignedCount: 0,
      acceptedCount: 0,
      currentAssignmentId: null,
    })
  }

  logAt(state, startedAt, 'SessionStarted', 'Demo session started with the initial roster Available.')
  return state
}

/* ------------------------------------------------------------- internals */

function requireSession(state: MockState, sessionId: string): void {
  if (sessionId !== state.sessionId) {
    throw new BoardError('Conflict', 'This demo session was reset. The board was reloaded.', {
      retryable: false,
    })
  }
}

function findVisit(state: MockState, visitId: string): MockVisit {
  const visit = state.visits.find((candidate) => candidate.visitId === visitId)
  if (visit === undefined) {
    throw new BoardError('Conflict', 'That visitor is no longer on the board.', { retryable: false })
  }
  return visit
}

function findParticipant(state: MockState, participantId: string): MockParticipant {
  const participant = state.participants.find((candidate) => candidate.participantId === participantId)
  if (participant === undefined) {
    throw new BoardError('Conflict', 'That associate is no longer on the board.', { retryable: false })
  }
  return participant
}

/** The unfinished assignment of a visit, if there is one. */
function openAssignmentOfVisit(state: MockState, visitId: string): MockAssignment | undefined {
  return state.assignments.find((a) => a.visitId === visitId && a.completedAt === null)
}

/** Last assignment of a visit, open or closed - what the visitor row shows. */
function latestAssignmentOfVisit(state: MockState, visitId: string): MockAssignment | undefined {
  return [...state.assignments].reverse().find((a) => a.visitId === visitId)
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
  participant.assignedCount += 1

  visit.serviceStatus = 'Assigned'

  logAt(state, at, 'AssignmentCreated', `UP assigned to ${participant.displayName}.`, {
    visitId: visit.visitId,
    participantId: participant.participantId,
  })
  return true
}

/**
 * Assigns Waiting visits in server registration order while capacity exists.
 * Runs after every event that can free a participant.
 */
function dispatchWaiting(state: MockState, at: string): void {
  const waiting = state.visits
    .filter((visit) => visit.serviceStatus === 'Waiting' && visit.departedAt === null)
    .sort((a, b) => a.registrationOrder - b.registrationOrder)

  for (const visit of waiting) {
    if (!reserveFor(state, visit, at)) break
  }
}

/** Closes the open assignment of a visit and releases the participant once. */
function closeOpenAssignment(
  state: MockState,
  visitId: string,
  reason: AssignmentCompletionReason,
  at: string,
): void {
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

export function registerVisitor(
  state: MockState,
  input: { eventId: string; sessionId: string; profile: VisitorProfileDto },
  at: string,
): void {
  requireSession(state, input.sessionId)
  // Resubmitting the same intentional registration must not duplicate a
  // visit, an assignment or an activity entry.
  if (state.seenEventIds.has(input.eventId)) return
  state.seenEventIds.add(input.eventId)

  const visit: MockVisit = {
    visitId: nextId(state, 'vis'),
    registrationOrder: state.visits.length + 1,
    profile: { ...input.profile },
    arrivedAt: at,
    departedAt: null,
    serviceStatus: 'Waiting',
    purchaseResult: null,
    purchaseRecordedAt: null,
  }
  state.visits.push(visit)
  logAt(state, at, 'VisitRegistered', 'Visitor registered manually.', { visitId: visit.visitId })

  // Reserved immediately; the visit stays Waiting when nobody is eligible.
  reserveFor(state, visit, at)
  state.revision += 1
}

export function updateVisitorProfile(
  state: MockState,
  input: { commandId: string; sessionId: string; visitId: string; profile: VisitorProfileDto },
  at: string,
): void {
  requireSession(state, input.sessionId)
  if (state.seenCommandIds.has(input.commandId)) return
  state.seenCommandIds.add(input.commandId)

  const visit = findVisit(state, input.visitId)
  // Profile only: timestamps, outcome, assignment and queue stay untouched.
  visit.profile = { ...input.profile }
  logAt(state, at, 'ProfileUpdated', 'Visitor attributes corrected.', { visitId: visit.visitId })
  state.revision += 1
}

export function acceptAssignment(
  state: MockState,
  input: { commandId: string; sessionId: string; assignmentId: string },
  at: string,
): void {
  requireSession(state, input.sessionId)
  if (state.seenCommandIds.has(input.commandId)) return
  state.seenCommandIds.add(input.commandId)

  const assignment = state.assignments.find((a) => a.assignmentId === input.assignmentId)
  if (assignment === undefined) {
    throw new BoardError('Conflict', 'That UP is no longer available to accept.', { retryable: false })
  }
  // Repeated acceptance has no further effect.
  if (assignment.acceptedAt !== null) return
  if (assignment.completedAt !== null) {
    throw new BoardError('Conflict', 'That turn is already closed.', { retryable: false })
  }

  const visit = findVisit(state, assignment.visitId)
  if (visit.departedAt !== null) {
    throw new BoardError('Conflict', 'That visitor has already left.', { retryable: false })
  }

  assignment.acceptedAt = at
  visit.serviceStatus = 'Accepted'

  const participant = findParticipant(state, assignment.participantId)
  // Still ineligible: OnUP is not an idle state.
  participant.state = 'OnUP'
  participant.acceptedCount += 1

  logAt(state, at, 'AssignmentAccepted', `${participant.displayName} accepted the UP.`, {
    visitId: visit.visitId,
    participantId: participant.participantId,
  })
  state.revision += 1
}

export function recordOutcome(
  state: MockState,
  input: { commandId: string; sessionId: string; visitId: string; result: PurchaseResult },
  at: string,
): void {
  requireSession(state, input.sessionId)
  if (state.seenCommandIds.has(input.commandId)) return
  state.seenCommandIds.add(input.commandId)

  const visit = findVisit(state, input.visitId)

  if (visit.purchaseResult !== null) {
    // The same outcome again is a no-op; a different one is a real conflict.
    if (visit.purchaseResult === input.result) return
    throw new BoardError('Conflict', 'A different purchase result is already recorded.', {
      retryable: false,
    })
  }

  const assignment = openAssignmentOfVisit(state, input.visitId)
  if (assignment === undefined || assignment.acceptedAt === null) {
    throw new BoardError('Conflict', 'Only an accepted, unfinished turn can record an outcome.', {
      retryable: false,
    })
  }

  visit.purchaseResult = input.result
  visit.purchaseRecordedAt = at
  // Service is complete; the visitor stays Inside until Mark Exit.
  visit.serviceStatus = 'Completed'

  closeOpenAssignment(state, visit.visitId, 'OutcomeRecorded', at)

  logAt(state, at, 'OutcomeRecorded', input.result === 'Sale' ? 'Sale recorded.' : 'No-Sale recorded.', {
    visitId: visit.visitId,
    participantId: assignment.participantId,
  })

  dispatchWaiting(state, at)
  state.revision += 1
}

export function markExit(
  state: MockState,
  input: { commandId: string; sessionId: string; visitId: string; purchaseResult: PurchaseResult | null },
  at: string,
): void {
  requireSession(state, input.sessionId)
  if (state.seenCommandIds.has(input.commandId)) return
  state.seenCommandIds.add(input.commandId)

  const visit = findVisit(state, input.visitId)

  if (visit.departedAt !== null) {
    // A duplicate exit preserves the original time and result.
    if (input.purchaseResult !== null && visit.purchaseResult !== input.purchaseResult) {
      throw new BoardError('Conflict', 'A different purchase result is already recorded.', {
        retryable: false,
      })
    }
    return
  }

  if (visit.purchaseResult === null) {
    if (input.purchaseResult === null) {
      throw new BoardError('Conflict', 'Select Sale or No-Sale before recording the exit.', {
        retryable: false,
      })
    }
    visit.purchaseResult = input.purchaseResult
    visit.purchaseRecordedAt = at
  } else if (input.purchaseResult !== null && input.purchaseResult !== visit.purchaseResult) {
    throw new BoardError('Conflict', 'A different purchase result is already recorded.', {
      retryable: false,
    })
  }

  const serviceWasComplete = visit.serviceStatus === 'Completed'

  visit.departedAt = at
  visit.serviceStatus = 'Completed'

  // Already-completed service does not touch the participant or the queue,
  // even if that participant now serves another visitor.
  if (!serviceWasComplete) {
    closeOpenAssignment(state, visit.visitId, 'Departure', at)
  }

  logAt(state, at, 'VisitDeparted', 'Visitor exit recorded.', { visitId: visit.visitId })

  if (!serviceWasComplete) dispatchWaiting(state, at)
  state.revision += 1
}

export function setAvailability(
  state: MockState,
  input: {
    commandId: string
    sessionId: string
    participantId: string
    state: Extract<ParticipantState, 'Available' | 'OffFloor'>
  },
  at: string,
): void {
  requireSession(state, input.sessionId)
  // A delayed replay of the original commandId must not append again or undo
  // a later change.
  if (state.seenCommandIds.has(input.commandId)) return
  state.seenCommandIds.add(input.commandId)

  const participant = findParticipant(state, input.participantId)

  if (participant.state === 'PendingAcceptance' || participant.state === 'OnUP') {
    throw new BoardError('Conflict', 'Only an idle associate can change availability.', {
      retryable: false,
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
  state.revision += 1
}

/* -------------------------------------------------------------- snapshot */

function metricsOf(state: MockState): MetricsDto {
  // All current-run visits are the denominator; Sale visits the numerator.
  const visitors = state.visits.length
  const closedSales = state.visits.filter((visit) => visit.purchaseResult === 'Sale').length
  return {
    visitors,
    assignedTurns: state.assignments.length,
    acceptedTurns: state.assignments.filter((a) => a.acceptedAt !== null).length,
    closedSales,
    conversionRate: visitors === 0 ? 0 : closedSales / visitors,
  }
}

function toVisitDto(state: MockState, visit: MockVisit): VisitDto {
  const assignment = latestAssignmentOfVisit(state, visit.visitId)
  return {
    visitId: visit.visitId,
    registrationOrder: visit.registrationOrder,
    source: 'Manual',
    attributesSource: 'Manual',
    enrichmentStatus: 'NotRequested',
    profile: { ...visit.profile },
    arrivedAt: visit.arrivedAt,
    departedAt: visit.departedAt,
    serviceStatus: visit.serviceStatus,
    purchaseResult: visit.purchaseResult,
    purchaseRecordedAt: visit.purchaseRecordedAt,
    assignment:
      assignment === undefined
        ? null
        : {
            assignmentId: assignment.assignmentId,
            participantId: assignment.participantId,
            participantName: findParticipant(state, assignment.participantId).displayName,
            assignedAt: assignment.assignedAt,
            acceptedAt: assignment.acceptedAt,
            completedAt: assignment.completedAt,
            completionReason: assignment.completionReason,
          },
  }
}

function toParticipantDto(state: MockState, participant: MockParticipant): ParticipantDto {
  // Resolved here so associate rows never join tables themselves.
  const open = state.assignments.find((a) => a.assignmentId === participant.currentAssignmentId)
  return {
    participantId: participant.participantId,
    associateId: participant.associateId,
    displayName: participant.displayName,
    state: participant.state,
    queuePosition: participant.queuePosition,
    assignedCount: participant.assignedCount,
    acceptedCount: participant.acceptedCount,
    currentVisitId: open?.visitId ?? null,
  }
}

export function toSnapshot(state: MockState, serverTime: string): BoardSnapshot {
  return {
    session: { sessionId: state.sessionId, startedAt: state.startedAt },
    participants: state.participants.map((participant) => toParticipantDto(state, participant)),
    visits: [...state.visits]
      .sort((a, b) => a.registrationOrder - b.registrationOrder)
      .map((visit) => toVisitDto(state, visit)),
    metrics: metricsOf(state),
    activity: [...state.activity].reverse(),
    serverTime,
    revision: state.revision,
  }
}
