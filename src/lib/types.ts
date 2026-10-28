/**
 * Board DTOs - the wire contract between the React prototype and the
 * separate Vercel API. These shapes are what BoardService returns, for both
 * the mock and the HTTP adapter.
 *
 * This file mirrors the backend's canonical, dependency-free contract at
 * `retail-intelligence-backend/src/contracts/dto.ts` (itself following
 * "Prototype Design.md" Public DTOs and "Backend Requirements.md" section 6).
 * The two repos are separate deployments, so the shapes are copied rather
 * than imported; if the backend contract changes, update this file to match
 * and do not drift the public shape unilaterally from the frontend side.
 *
 * Reflects the corrected "Assignment Rotation Revision - Per-Associate
 * Offers": an associate's own availability is only Available/OffFloor -
 * accepted, unfinished work never makes them ineligible - and each
 * associate may hold at most one unconfirmed offer of their own at a time
 * (not a session-wide gate; different associates can each hold their own
 * offer in parallel). Confirmed end-to-end against the live backend
 * (contract v3); see README for the verification note.
 */

/* ------------------------------------------------------------ enum values */

/** An associate's own availability. Accepted/pending work is tracked on the assignment, not here. */
export const AvailabilityStates = ['Available', 'OffFloor'] as const
export type AvailabilityState = (typeof AvailabilityStates)[number]

export const AssignmentPhases = ['PendingAcceptance', 'Accepted', 'Completed'] as const
export type AssignmentPhase = (typeof AssignmentPhases)[number]

export const CompletionReasons = ['OutcomeRecorded', 'Departure', 'Rejected'] as const
export type CompletionReason = (typeof CompletionReasons)[number]

export const Outcomes = ['Sale', 'NoSale'] as const
export type Outcome = (typeof Outcomes)[number]

export const VisitStatuses = ['Waiting', 'Assigned', 'Accepted', 'Completed'] as const
export type VisitStatus = (typeof VisitStatuses)[number]

/** How the visit entered the system. Only `Manual` is produced in stage 1. */
export const VisitSources = ['CV', 'Manual'] as const
export type VisitSource = (typeof VisitSources)[number]

export const AgeGroups = ['Under20', 'From20To39', 'From40To59', 'Age60Plus', 'Unknown'] as const
export type AgeGroup = (typeof AgeGroups)[number]

export const Genders = ['Female', 'Male', 'Unknown'] as const
export type Gender = (typeof Genders)[number]

/** Whose values the stored attributes hold. Manual wins over future CV estimates. */
export const AttributesSources = ['Manual', 'CV', 'Unknown'] as const
export type AttributesSource = (typeof AttributesSources)[number]

/** CV enrichment lifecycle. Stage 1 manual path always writes `NotRequested`. */
export const EnrichmentStatuses = ['Pending', 'Complete', 'Failed', 'NotRequested'] as const
export type EnrichmentStatus = (typeof EnrichmentStatuses)[number]

/**
 * Why a Waiting visit has no assignment. Computed server-side (contract v5)
 * since the third reason needs the visit's rejection history, and the
 * project's own rule is that authoritative queue logic never lives in React.
 */
export const WaitingReasons = ['NoAvailableAssociates', 'AwaitingConfirmation', 'AwaitingOtherAssociate'] as const
export type WaitingReason = (typeof WaitingReasons)[number]

export const ActivityKinds = [
  'ArrivalRecorded',
  'AssignmentCreated',
  'AssignmentAccepted',
  'AssignmentRejected',
  'TurnCompleted',
  'AvailabilityChanged',
  'VisitorAttributesUpdated',
  'VisitorDeparted',
] as const
export type ActivityKind = (typeof ActivityKinds)[number]

/** Maximum length (Unicode code points) of each description field. */
export const DESCRIPTION_MAX_LENGTH = 200

/* ------------------------------------------------------------- read model */

export interface SessionContext {
  sessionId: string
  startedAt: string
}

export interface AssociateView {
  participantId: string
  /** Stable roster identity, kept across demo resets. */
  associateId: string
  displayName: string
  state: AvailabilityState
  /** 1-based rank among Available participants; null unless Available. */
  queuePosition: number | null
  /** This associate's own unresolved offer, if any - independent of other associates'. */
  pendingAssignmentId: string | null
  /** Accepted, unfinished assignments - any number of these is valid. */
  activeAssignmentIds: string[]
  activeTurns: number
  /** Created offers, including ones later closed by early departure. */
  assignedTurns: number
  acceptedTurns: number
}

export interface VisitorAttributes {
  /** Trimmed; empty string means "not known". */
  upperDescription: string
  lowerDescription: string
  /** Trimmed; null when absent (empty input is normalized to null). */
  accessoryDescription: string | null
  ageGroup: AgeGroup
  gender: Gender
}

export interface VisitView {
  visitId: string
  /** Server registration (entry) time. */
  arrivedAt: string
  /** Separate CV observation time; always null in Stage 1. */
  detectedAt: string | null
  /** Registered exit time; presence is Inside while null, Left otherwise. */
  departedAt: string | null
  source: VisitSource
  status: VisitStatus
  attributes: VisitorAttributes
  attributesSource: AttributesSource
  enrichmentStatus: EnrichmentStatus
  outcome: Outcome | null
  outcomeRecordedAt: string | null
  /** 1-based FIFO rank among Waiting visitors still inside; otherwise null. */
  waitingPosition: number | null
  /**
   * Non-null only while `status` is `Waiting` and the visitor is inside.
   * `AwaitingOtherAssociate` means the only otherwise-eligible associate(s)
   * rejected this specific visit most recently - excluded for this visit
   * only, until someone else also rejects it (see Assignment Rotation
   * Revision.md rule 11/contract v5).
   */
  waitingReason: WaitingReason | null
  /**
   * Null whenever status is `Waiting` - including after a Reject, which
   * returns a visit to Waiting but leaves a closed assignment in its
   * history. Never let a stale id leak through and make a Waiting row
   * look assigned.
   */
  assignmentId: string | null
}

export interface AssignmentView {
  assignmentId: string
  visitId: string
  participantId: string
  /** Derived: completedAt -> Completed, acceptedAt -> Accepted, else PendingAcceptance. */
  phase: AssignmentPhase
  assignedAt: string
  acceptedAt: string | null
  completedAt: string | null
  completionReason: CompletionReason | null
}

export interface MetricsView {
  visitors: number
  assignedTurns: number
  acceptedTurns: number
  closedSales: number
  /** Sale visits / all visits * 100 (0 when there are no visits); not rounded. */
  conversionRate: number
}

export interface ActivityView {
  activityId: string
  occurredAt: string
  kind: ActivityKind
  description: string
  visitId: string | null
  participantId: string | null
  assignmentId: string | null
}

/**
 * GET /api/board. Associates are in stable initial roster order, visits and
 * assignments in server registration order of their visits, activity newest
 * first. The frontend never derives order itself: it is the array order.
 */
export interface BoardSnapshot {
  session: SessionContext
  associates: AssociateView[]
  visits: VisitView[]
  assignments: AssignmentView[]
  metrics: MetricsView
  activity: ActivityView[]
  serverTime: string
}

/* ---------------------------------------------------------------- derived */

export function presenceOf(visit: VisitView): 'Inside' | 'Left' {
  return visit.departedAt === null ? 'Inside' : 'Left'
}

/** Next UP = first eligible associate by queuePosition. */
export function nextUpParticipantId(associates: readonly AssociateView[]): string | null {
  const eligible = associates
    .filter((p) => p.state === 'Available' && p.queuePosition !== null)
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
  return eligible[0]?.participantId ?? null
}

/** Accept UP is only offered for a pending assignment of a visitor still inside. */
export function canAcceptUp(visit: VisitView): boolean {
  return visit.status === 'Assigned' && visit.departedAt === null && visit.assignmentId !== null
}

/** Reject UP has the identical precondition to Accept UP - they are offered side by side. */
export function canRejectUp(visit: VisitView): boolean {
  return canAcceptUp(visit)
}

/** Sale / No-Sale is only offered for an accepted, unfinished turn. */
export function canRecordOutcome(visit: VisitView): boolean {
  return visit.status === 'Accepted' && visit.assignmentId !== null
}

/** Mark Exit is available for any visit that has not departed yet. */
export function canMarkExit(visit: VisitView): boolean {
  return visit.departedAt === null
}

/**
 * Off Floor is rejected only while the associate owns their own unresolved
 * pending offer - accepted, unfinished work never blocks it. Different
 * associates may each hold their own pending offer at the same time; this
 * is a per-associate check, not a session-wide gate.
 * Available -> Available is always allowed (there is nothing to resolve).
 */
export function canMarkOffFloor(associate: AssociateView): boolean {
  return associate.pendingAssignmentId === null
}

/** True while any assignment anywhere in the session is offered but not yet accepted. */
export function hasPendingOffer(snapshot: BoardSnapshot): boolean {
  return snapshot.assignments.some((assignment) => assignment.phase === 'PendingAcceptance')
}
