/**
 * Read-only joins over one BoardSnapshot. `assignments` and `associates` are
 * sibling arrays in the DTO (a visit only carries an `assignmentId`), so a
 * visitor row needs to look up the assigned associate's name itself. That
 * lookup lives here, once, instead of inside VisitorsTable - no business
 * rule or join belongs in a row component.
 */
import type { AssignmentView, AssociateView, BoardSnapshot, VisitView } from './types.ts'

export interface VisitRow {
  visit: VisitView
  assignment: AssignmentView | null
  /** Display name of the assigned associate, if any. */
  associateName: string | null
}

export function buildVisitRows(snapshot: BoardSnapshot): VisitRow[] {
  const assignmentsById = new Map(snapshot.assignments.map((assignment) => [assignment.assignmentId, assignment]))
  const associatesById = new Map(snapshot.associates.map((associate) => [associate.participantId, associate]))

  return snapshot.visits.map((visit) => {
    const assignment = visit.assignmentId === null ? null : assignmentsById.get(visit.assignmentId) ?? null
    const associate = assignment === null ? null : associatesById.get(assignment.participantId) ?? null
    return { visit, assignment, associateName: associate?.displayName ?? null }
  })
}

/** The associate currently reserved for Next UP, if any are eligible. */
export function findAssociate(snapshot: BoardSnapshot, participantId: string): AssociateView | undefined {
  return snapshot.associates.find((candidate) => candidate.participantId === participantId)
}

export interface PendingOffer {
  visit: VisitView
  assignment: AssignmentView
  associateName: string
}

/**
 * The session's one unresolved offer, if any. At most one can exist at a
 * time under the "advance on acceptance" rotation rule, and later arrivals
 * wait on it regardless of how many other associates are Available.
 */
export function findPendingOffer(snapshot: BoardSnapshot): PendingOffer | null {
  const assignment = snapshot.assignments.find((candidate) => candidate.phase === 'PendingAcceptance')
  if (assignment === undefined) return null

  const visit = snapshot.visits.find((candidate) => candidate.visitId === assignment.visitId)
  const associate = snapshot.associates.find((candidate) => candidate.participantId === assignment.participantId)
  if (visit === undefined || associate === undefined) return null

  return { visit, assignment, associateName: associate.displayName }
}
