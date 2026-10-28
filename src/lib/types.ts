/**
 * Board DTOs - the wire contract between the React prototype and the
 * separate Vercel API. These shapes are what BoardService returns, for both
 * the mock and the HTTP adapter.
 *
 * `Prototype Design.md` / `Design Class Diagram.md` are not in the repository
 * yet, so the names below follow the vocabulary used by
 * `Frontend and UI Requirements.md` and `Prototype Backlog.md`. The machine
 * values are the ones the UI sends and must be confirmed against the backend;
 * see README "Remaining API integration work".
 */

/* ------------------------------------------------------------------ enums */

export const AgeGroups = ['Under20', 'From20To39', 'From40To59', 'Over60', 'Unknown'] as const
export type AgeGroup = (typeof AgeGroups)[number]

export const Genders = ['Female', 'Male', 'Unknown'] as const
export type Gender = (typeof Genders)[number]

/** How the visit entered the system. Only `Manual` is produced in stage 1. */
export type VisitSource = 'Manual' | 'CV'

/** Whose values the stored profile holds. Manual wins over future CV estimates. */
export type AttributesSource = 'Manual' | 'CV'

/** CV enrichment lifecycle. Stage 1 manual path always writes `NotRequested`. */
export type EnrichmentStatus = 'NotRequested' | 'Pending' | 'Completed' | 'Failed'

/** Service lifecycle of a visit. Independent of physical presence. */
export type ServiceStatus = 'Waiting' | 'Assigned' | 'Accepted' | 'Completed'

/** Physical presence, derived from `departedAt` - never from serviceStatus. */
export type Presence = 'Inside' | 'Left'

/** Purchase outcome. `null` means not recorded; it is never a No-Sale. */
export type PurchaseResult = 'Sale' | 'NoSale'

export type ParticipantState = 'Available' | 'OffFloor' | 'PendingAcceptance' | 'OnUP'

export type AssignmentCompletionReason = 'OutcomeRecorded' | 'Departure'

export type ActivityKind =
  | 'SessionStarted'
  | 'VisitRegistered'
  | 'AssignmentCreated'
  | 'AssignmentAccepted'
  | 'OutcomeRecorded'
  | 'VisitDeparted'
  | 'ProfileUpdated'
  | 'AvailabilityChanged'
  | 'SessionReset'

/* -------------------------------------------------------------------- DTOs */

export interface VisitorProfileDto {
  /** Free text; may be empty when the receptionist cannot describe it. */
  upperDescription: string
  lowerDescription: string
  /** Optional accessory. */
  accessory: string
  ageGroup: AgeGroup
  gender: Gender
}

export interface AssignmentDto {
  assignmentId: string
  participantId: string
  /** Denormalised for display so rows do not join tables themselves. */
  participantName: string
  assignedAt: string
  acceptedAt: string | null
  completedAt: string | null
  completionReason: AssignmentCompletionReason | null
}

export interface VisitDto {
  visitId: string
  /** Server FIFO registration order; the default table order. */
  registrationOrder: number
  source: VisitSource
  attributesSource: AttributesSource
  enrichmentStatus: EnrichmentStatus
  profile: VisitorProfileDto
  /** Server-set entry time (UTC). */
  arrivedAt: string
  /** Server-set exit time (UTC), or null while the visitor is inside. */
  departedAt: string | null
  serviceStatus: ServiceStatus
  purchaseResult: PurchaseResult | null
  purchaseRecordedAt: string | null
  /** The current unfinished assignment, or the last closed one, if any. */
  assignment: AssignmentDto | null
}

export interface ParticipantDto {
  participantId: string
  /** Stable roster identity, kept across demo resets. */
  associateId: string
  displayName: string
  state: ParticipantState
  /** Rotation order among eligible participants; null when not eligible. */
  queuePosition: number | null
  assignedCount: number
  acceptedCount: number
  /** Visit the participant is currently reserved for, if any. */
  currentVisitId: string | null
}

export interface SessionDto {
  sessionId: string
  startedAt: string
}

export interface MetricsDto {
  visitors: number
  assignedTurns: number
  acceptedTurns: number
  closedSales: number
  /** 0..1; formatted for display by the UI. */
  conversionRate: number
}

export interface ActivityEntryDto {
  entryId: string
  occurredAt: string
  kind: ActivityKind
  message: string
  visitId?: string
  participantId?: string
}

/** One read of the whole board. The UI renders snapshots, never fragments. */
export interface BoardSnapshot {
  session: SessionDto
  participants: ParticipantDto[]
  visits: VisitDto[]
  metrics: MetricsDto
  /** Newest first. */
  activity: ActivityEntryDto[]
  serverTime: string
  /** Monotonic per session; used to drop out-of-order snapshots. */
  revision: number
}

/* ---------------------------------------------------------------- derived */

export function presenceOf(visit: VisitDto): Presence {
  return visit.departedAt === null ? 'Inside' : 'Left'
}

/** Next UP = first eligible participant by queuePosition. */
export function nextUpParticipantId(participants: ParticipantDto[]): string | null {
  const eligible = participants
    .filter((p) => p.state === 'Available' && p.queuePosition !== null)
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
  return eligible[0]?.participantId ?? null
}

/** Accept UP is only offered for a pending assignment of a visitor still inside. */
export function canAcceptUp(visit: VisitDto): boolean {
  return (
    visit.serviceStatus === 'Assigned' &&
    visit.departedAt === null &&
    visit.assignment !== null &&
    visit.assignment.acceptedAt === null &&
    visit.assignment.completedAt === null
  )
}

/** Sale / No-Sale is only offered for an accepted, unfinished turn. */
export function canRecordOutcome(visit: VisitDto): boolean {
  return (
    visit.serviceStatus === 'Accepted' &&
    visit.assignment !== null &&
    visit.assignment.acceptedAt !== null &&
    visit.assignment.completedAt === null
  )
}

/** Mark Exit is available for any visit that has not departed yet. */
export function canMarkExit(visit: VisitDto): boolean {
  return visit.departedAt === null
}

/** Availability can only be changed for an idle participant. */
export function isIdle(participant: ParticipantDto): boolean {
  return participant.state === 'Available' || participant.state === 'OffFloor'
}
