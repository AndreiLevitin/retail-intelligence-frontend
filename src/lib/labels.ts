/**
 * Internal code values are distinguished from human labels here, once.
 * Components never inline a label string for a domain value.
 */
import type {
  ActivityKind,
  AgeGroup,
  Gender,
  ParticipantState,
  Presence,
  PurchaseResult,
  ServiceStatus,
  VisitorProfileDto,
} from './types.ts'

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'muted'

export const ageGroupLabels: Record<AgeGroup, string> = {
  Under20: '<20',
  From20To39: '20-39',
  From40To59: '40-59',
  Over60: '60+',
  Unknown: 'Unknown',
}

export const genderLabels: Record<Gender, string> = {
  Female: 'Female',
  Male: 'Male',
  Unknown: 'Unknown',
}

export const serviceStatusLabels: Record<ServiceStatus, string> = {
  Waiting: 'Waiting',
  Assigned: 'Assigned',
  Accepted: 'Accepted',
  Completed: 'Completed',
}

export const serviceStatusTones: Record<ServiceStatus, Tone> = {
  Waiting: 'warning',
  Assigned: 'info',
  Accepted: 'info',
  Completed: 'neutral',
}

export const presenceLabels: Record<Presence, string> = {
  Inside: 'Inside',
  Left: 'Left',
}

export const presenceTones: Record<Presence, Tone> = {
  Inside: 'neutral',
  Left: 'neutral',
}

export const participantStateLabels: Record<ParticipantState, string> = {
  Available: 'Available',
  OffFloor: 'Off Floor',
  PendingAcceptance: 'Pending Acceptance',
  OnUP: 'On UP',
}

export const participantStateTones: Record<ParticipantState, Tone> = {
  Available: 'success',
  OffFloor: 'neutral',
  PendingAcceptance: 'warning',
  OnUP: 'info',
}

/** `null` is an explicit "Not recorded", never a No-Sale. */
export function purchaseResultLabel(result: PurchaseResult | null): string {
  if (result === 'Sale') return 'Sale'
  if (result === 'NoSale') return 'No-Sale'
  return 'Not recorded'
}

export function purchaseResultTone(result: PurchaseResult | null): Tone {
  if (result === 'Sale') return 'success'
  if (result === 'NoSale') return 'neutral'
  return 'muted'
}

export const activityKindLabels: Record<ActivityKind, string> = {
  SessionStarted: 'Session started',
  VisitRegistered: 'Visitor registered',
  AssignmentCreated: 'UP assigned',
  AssignmentAccepted: 'UP accepted',
  OutcomeRecorded: 'Outcome recorded',
  VisitDeparted: 'Visitor left',
  ProfileUpdated: 'Attributes updated',
  AvailabilityChanged: 'Availability changed',
  SessionReset: 'Demo reset',
}

export const NO_DESCRIPTION = 'Description not provided'

/**
 * Joins only the known, non-empty appearance parts. Never fabricates text and
 * never substitutes a demographic guess.
 */
export function describeAppearance(profile: VisitorProfileDto): string {
  const parts = [profile.upperDescription, profile.lowerDescription, profile.accessory]
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
