/**
 * Internal code values are distinguished from human labels here, once.
 * Components never inline a label string for a domain value.
 */
import type {
  ActivityKind,
  AgeGroup,
  AssignmentPhase,
  AvailabilityState,
  Gender,
  Outcome,
  VisitorAttributes,
  VisitStatus,
} from './types.ts'

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'muted'

export const ageGroupLabels: Record<AgeGroup, string> = {
  Under20: '<20',
  From20To39: '20-39',
  From40To59: '40-59',
  Age60Plus: '60+',
  Unknown: 'Unknown',
}

export const genderLabels: Record<Gender, string> = {
  Female: 'Female',
  Male: 'Male',
  Unknown: 'Unknown',
}

export const visitStatusLabels: Record<VisitStatus, string> = {
  Waiting: 'Waiting',
  Assigned: 'Assigned',
  Accepted: 'Accepted',
  Completed: 'Completed',
}

export const visitStatusTones: Record<VisitStatus, Tone> = {
  Waiting: 'warning',
  Assigned: 'info',
  Accepted: 'info',
  Completed: 'neutral',
}

export const presenceLabels: Record<'Inside' | 'Left', string> = {
  Inside: 'Inside',
  Left: 'Left',
}

export const presenceTones: Record<'Inside' | 'Left', Tone> = {
  Inside: 'neutral',
  Left: 'neutral',
}

/** An associate's own availability - accepted/pending work has its own badge. */
export const availabilityLabels: Record<AvailabilityState, string> = {
  Available: 'Available',
  OffFloor: 'Off Floor',
}

export const availabilityTones: Record<AvailabilityState, Tone> = {
  Available: 'success',
  OffFloor: 'neutral',
}

/** Per-assignment phase - shown separately from the associate's availability. */
export const assignmentPhaseLabels: Record<AssignmentPhase, string> = {
  PendingAcceptance: 'Pending Acceptance',
  Accepted: 'Accepted',
  Completed: 'Completed',
}

export const assignmentPhaseTones: Record<AssignmentPhase, Tone> = {
  PendingAcceptance: 'warning',
  Accepted: 'info',
  Completed: 'neutral',
}

/** `null` is an explicit "Not recorded", never a No-Sale. */
export function outcomeLabel(outcome: Outcome | null): string {
  if (outcome === 'Sale') return 'Sale'
  if (outcome === 'NoSale') return 'No-Sale'
  return 'Not recorded'
}

export function outcomeTone(outcome: Outcome | null): Tone {
  if (outcome === 'Sale') return 'success'
  if (outcome === 'NoSale') return 'neutral'
  return 'muted'
}

export const activityKindLabels: Record<ActivityKind, string> = {
  ArrivalRecorded: 'Visitor registered',
  AssignmentCreated: 'UP assigned',
  AssignmentAccepted: 'UP accepted',
  TurnCompleted: 'Outcome recorded',
  AvailabilityChanged: 'Availability changed',
  VisitorAttributesUpdated: 'Attributes updated',
  VisitorDeparted: 'Visitor left',
}

export const NO_DESCRIPTION = 'Description not provided'

/**
 * Joins only the known, non-empty appearance parts. Never fabricates text and
 * never substitutes a demographic guess.
 */
export function describeAppearance(attributes: VisitorAttributes): string {
  const parts = [attributes.upperDescription, attributes.lowerDescription, attributes.accessoryDescription ?? '']
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return parts.length > 0 ? parts.join(' / ') : NO_DESCRIPTION
}

export const AGE_GROUP_OPTIONS = (Object.keys(ageGroupLabels) as AgeGroup[]).map((value) => ({
  value,
  label: ageGroupLabels[value],
}))

export const GENDER_OPTIONS = (Object.keys(genderLabels) as Gender[]).map((value) => ({
  value,
  label: genderLabels[value],
}))
