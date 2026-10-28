/**
 * In-memory board engine for MockBoardClient.
 *
 * Implements the corrected rotation rule (per the user's direct description
 * of the real store process, which superseded the first - wrong - reading
 * of "Assignment Rotation Revision.md" as a single store-wide offer gate):
 *  - each associate may hold at most ONE unconfirmed (pending) offer of
 *    their own at a time; different associates can each simultaneously hold
 *    their own pending offer - there is no session-wide gate
 *  - accepted, unfinished work never makes an associate ineligible for a
 *    new offer; multiple accepted-unfinished assignments per associate are
 *    valid ("Second UP" and beyond)
 *  - the queue position moves at OFFER time, not at Accept time: making an
 *    offer immediately reserves that associate and moves them to the back,
 *    on the optimistic assumption they will confirm, so the next arrival
 *    naturally offers to the next associate in line
 *  - Accept does not move the queue again - it already moved when offered
 *  - a normal outcome (Sale/No-Sale) never changes rotation or availability
 *  - departure of a still-pending offer clears it (reason Departure)
 *    without any further queue effect - the position already moved at
 *    offer time and nothing moves it back
 *  - rejecting a still-pending offer closes it (reason Rejected) the same
 *    way, except the Visit returns to Waiting (not Completed) at its
 *    original registration order, and a dispatch is attempted immediately
 *  - contract v5: a visit excludes its own most recent rejecter, and only
 *    that one associate, for *itself* - not a one-shot dispatch exception,
 *    a property of the visit, checked by every dispatch the same way, so a
 *    later unrelated event can never bounce the same visit back to them.
 *    The exclusion moves to whoever rejects it next; it is lifted as soon
 *    as a different associate rejects, and the first rejecter never
 *    acquires any exclusion from any *other* visitor's dispatch
 *
 * The rules live here and not in components, so they exist in exactly one
 * place and can be deleted together with the mock adapter. Only arrival
 * (`eventId`) and availability (`commandId`) carry a client idempotency key,
 * matching the backend contract; accept, reject, outcome, departure and
 * attributes are made safe to retry by checking current state instead.
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
  WaitingReason,
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

/** The participant's own unresolved (not yet accepted) offer, if any. */
function pendingOfferOf(state: MockState, participantId: string): MockAssignment | undefined {
  return state.assignments.find(
    (a) => a.participantId === participantId && a.acceptedAt === null && a.completedAt === null,
  )
}

/** The unfinished (pending or accepted) assignment of a visit, if there is one. */
function openAssignmentOfVisit(state: MockState, visitId: string): MockAssignment | undefined {
  return state.assignments.find((a) => a.visitId === visitId && a.completedAt === null)
}

/** Open assignment if any, else the last closed one - what a visit row shows. */
function latestAssignmentOfVisit(state: MockState, visitId: string): MockAssignment | undefined {
  return openAssignmentOfVisit(state, visitId) ?? [...state.assignments].reverse().find((a) => a.visitId === visitId)
}

/**
 * The participantId of this visit's most recent Rejected assignment, if
 * any - derived from history already kept, no separate state. This is the
 * one associate excluded from a new offer *for this visit specifically*
 * (contract v5 / Assignment Rotation Revision.md rule 11): if a different
 * associate rejects it afterward, the exclusion moves to them instead.
 */
function lastRejecterOf(state: MockState, visitId: string): string | undefined {
  const rejections = state.assignments.filter((a) => a.visitId === visitId && a.completionReason === 'Rejected')
  return rejections.length > 0 ? rejections[rejections.length - 1].participantId : undefined
}

/**
 * Available AND not already holding their own unconfirmed offer. Accepted,
 * unfinished work does not exclude a participant. Eligibility is scoped to
 * one visit: `excludeParticipantId` (that visit's own last rejecter, if
 * any) is excluded *for this visit only* - the same associate remains a
 * completely normal candidate for every other visitor right away.
 */
function eligibleParticipantsFor(state: MockState, excludeParticipantId: string | undefined): MockParticipant[] {
  return state.participants
    .filter(
      (p) =>
        p.state === 'Available' &&
        p.queueOrder !== null &&
        p.participantId !== excludeParticipantId &&
        pendingOfferOf(state, p.participantId) === undefined,
    )
    .sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0))
}

/** Appends a returning or just-offered participant to the bottom of rotation. */
function appendToQueue(state: MockState, participant: MockParticipant): void {
  participant.state = 'Available'
  participant.queueOrder = state.nextQueueOrder++
}

/**
 * Dense 1-based rank among ALL currently-Available associates, by their raw
 * ordering token - including ones who currently hold their own pending
 * offer (confirmed against the live backend: an associate with a pending
 * offer still shows a queuePosition). This is what `AssociateView.queuePosition`
 * exposes; it is deliberately broader than `eligibleParticipants`, which
 * additionally excludes pending-offer holders from receiving a *new* one.
 */
function queueRanks(state: MockState): Map<string, number> {
  const ranked = state.participants
    .filter((p) => p.state === 'Available' && p.queueOrder !== null)
    .sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0))
  return new Map(ranked.map((participant, index) => [participant.participantId, index + 1]))
}

/**
 * Offers the oldest *dispatchable* Waiting visit to its own front-of-queue
 * eligible participant. "Dispatchable" is visit-specific, not global: a
 * visit excludes only its own last rejecter (see `lastRejecterOf`), so an
 * older visit stuck behind that one exclusion is skipped - keeping its
 * FIFO place - while a newer visit with no such history can still be
 * served in the same pass. The offer reserves that participant and moves
 * them to the back of the queue right away, optimistically assuming they
 * will confirm - Accept does not move the queue again. Returns true when
 * an offer was created.
 *
 * Only tries the single oldest Waiting visit it can actually place, not a
 * full settle pass - callers must loop (`settleDispatch`) until this
 * returns false. One call is not enough under the per-visit exclusion
 * rule: freeing one participant can satisfy the oldest Waiting visit, and
 * that alone can reveal a second, independently-idle-but-excluded
 * participant as newly eligible for a different visit - confirmed live
 * against the backend, where a single reject produced two new offers in
 * one mutation.
 */
function tryCreateOffer(state: MockState, at: string): boolean {
  const waitingVisits = state.visits
    .filter((v) => v.status === 'Waiting' && v.departedAt === null)
    .sort((a, b) => a.registrationOrder - b.registrationOrder)

  for (const visit of waitingVisits) {
    const participant = eligibleParticipantsFor(state, lastRejecterOf(state, visit.visitId))[0]
    if (participant === undefined) continue // this one is stuck; try the next oldest

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
    // Reserve now, on the assumption of acceptance - not when they confirm.
    appendToQueue(state, participant)

    logAt(state, at, 'AssignmentCreated', `UP offered to ${participant.displayName}.`, {
      visitId: visit.visitId,
      participantId: participant.participantId,
      assignmentId: assignment.assignmentId,
    })
    return true
  }
  return false
}

/** Exhausts every offer the current state makes possible, not just one. */
function settleDispatch(state: MockState, at: string): void {
  while (tryCreateOffer(state, at)) {
    // keep going until nobody idle is eligible for any Waiting visit
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

  // Offers the oldest Waiting visit (which may not be this one, if an
  // earlier arrival is still waiting) - stays Waiting if no offer can be made.
  settleDispatch(state, at)
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
    // Closed by an early departure or a reject before acceptance: never
    // fabricate one.
    throw new BoardError('Conflict', 'That offer was already closed.', {
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
  // The queue already moved when this offer was made - accepting does not
  // move it again. Clearing the pending offer does make this participant
  // eligible for a new one, so try once more in case a Waiting visit exists.

  logAt(state, at, 'AssignmentAccepted', `${participant.displayName} accepted the UP.`, {
    visitId: visit.visitId,
    participantId: participant.participantId,
    assignmentId: assignment.assignmentId,
  })

  settleDispatch(state, at)
}

/**
 * Rejects a still-pending offer. If Accept exists, Reject must too (the
 * real store process confirms associates can decline a UP). Unlike a
 * departure, the visitor is still here - the Visit returns to Waiting at
 * its original registration order (never a fictitious new arrival), and a
 * dispatch is attempted immediately so it may go straight to a different
 * eligible associate.
 */
export function rejectAssignment(
  state: MockState,
  input: { sessionId: string; assignmentId: string },
  at: string,
): void {
  requireSession(state, input.sessionId)
  const assignment = findAssignment(state, input.assignmentId)

  if (assignment.acceptedAt !== null) {
    // An accepted turn cannot be rejected - never undo a confirmed acceptance.
    throw new BoardError('Conflict', 'That offer was already accepted.', {
      retryable: false,
      apiCode: 'INVALID_TRANSITION',
    })
  }
  // Already closed (rejected, or departed before acceptance): a blind
  // retry reports replayed, no further effect.
  if (assignment.completedAt !== null) return

  const visit = findVisit(state, assignment.visitId)
  const participant = findParticipant(state, assignment.participantId)

  assignment.completedAt = at
  assignment.completionReason = 'Rejected'
  // Back to Waiting, not Completed - the visitor is still here and still
  // needs service. Registration order is untouched, so FIFO fairness holds.
  visit.status = 'Waiting'
  // The rejecting associate's queue position is untouched - it already
  // moved to the back when this offer was created, same as Accept.

  logAt(state, at, 'AssignmentRejected', `${participant.displayName} rejected the UP.`, {
    visitId: visit.visitId,
    participantId: participant.participantId,
    assignmentId: assignment.assignmentId,
  })

  // The visit's own history now excludes this participant for itself (see
  // lastRejecterOf), so dispatch naturally offers it elsewhere if someone
  // else is eligible, or leaves it Waiting - never back to the rejecter -
  // without settleDispatch needing to know a reject just happened.
  settleDispatch(state, at)
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
  // Rotation/availability are untouched: the queue already moved when this
  // offer was made, and a normal outcome never moves it again.

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
      // The queue already moved when this offer was made (whether or not
      // it was ever accepted), so departure never moves it again - there
      // is nothing left to undo or consume.
    }
  }

  logAt(state, at, 'VisitorDeparted', 'Visitor exit recorded.', { visitId: visit.visitId })

  // Harmless no-op unless this departure cleared this participant's own
  // pending offer: they're now eligible again, so try new ones for them.
  if (!wasAlreadyComplete) settleDispatch(state, at)
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
    // Rejected only while this participant owns their own unresolved
    // pending offer; accepted, unfinished work never blocks it.
    if (pendingOfferOf(state, participant.participantId) !== undefined) {
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
  if (input.state === 'Available') settleDispatch(state, at)
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

/**
 * Server-computed, per visit (contract v5): why a Waiting visit has no
 * assignment. Exactly one of three reasons, derived from the authoritative
 * snapshot - never implied client-side, never "all associates busy".
 */
function waitingReasonOf(state: MockState, visit: MockVisit): WaitingReason | null {
  if (visit.status !== 'Waiting' || visit.departedAt !== null) return null

  const available = state.participants.filter((p) => p.state === 'Available')
  if (available.length === 0) return 'NoAvailableAssociates'

  const notBusy = available.filter((p) => pendingOfferOf(state, p.participantId) === undefined)
  if (notBusy.length === 0) return 'AwaitingConfirmation'

  const excluded = lastRejecterOf(state, visit.visitId)
  const eligible = notBusy.filter((p) => p.participantId !== excluded)
  // If `eligible` were non-empty here, dispatch would already have claimed
  // this visit - `null` is the defensive fallback for that impossible case.
  return eligible.length === 0 ? 'AwaitingOtherAssociate' : null
}

function toVisitView(state: MockState, visit: MockVisit): VisitView {
  // Waiting always means "no assignment currently connects to this visit" -
  // true by construction before Reject existed, but Reject introduces the
  // first path back to Waiting from Assigned, so a visit can now carry
  // closed/rejected history while Waiting. Never let that leak through.
  const assignment = visit.status === 'Waiting' ? undefined : latestAssignmentOfVisit(state, visit.visitId)
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
    waitingReason: waitingReasonOf(state, visit),
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
