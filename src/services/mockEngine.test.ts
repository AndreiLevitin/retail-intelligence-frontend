/**
 * Story-level checks on the mock engine. These verify the transitions the
 * stories describe, not component rendering: US-01 initial order, US-02
 * registration and idempotency, US-03 accept/outcome, US-04 departure,
 * US-05 availability and waiting fairness, US-06 reset and stale sessions.
 */
import { describe, expect, it } from 'vitest'
import { BoardError } from './boardService.ts'
import * as engine from './mockEngine.ts'
import type { MockState } from './mockEngine.ts'
import { nextUpParticipantId } from '../lib/types.ts'
import type { VisitorProfileDto } from '../lib/types.ts'

const BASE = new Date('2026-01-05T09:00:00.000Z')
const at = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000).toISOString()

const profile: VisitorProfileDto = {
  upperDescription: 'Navy puffer jacket',
  lowerDescription: 'Grey jeans',
  accessory: '',
  ageGroup: 'From20To39',
  gender: 'Female',
}

function session(): MockState {
  return engine.createSession('ses_test', BASE.toISOString())
}

/** Registers a visitor and returns its id. */
function arrive(state: MockState, minutes: number, eventId = `evt_${minutes}`): string {
  engine.registerVisitor(state, { eventId, sessionId: state.sessionId, profile }, at(minutes))
  return state.visits[state.visits.length - 1].visitId
}

function openAssignmentId(state: MockState, visitId: string): string {
  const snapshot = engine.toSnapshot(state, at(99))
  const visit = snapshot.visits.find((candidate) => candidate.visitId === visitId)
  const assignment = visit?.assignment
  if (assignment === undefined || assignment === null) throw new Error('no assignment')
  return assignment.assignmentId
}

function accept(state: MockState, visitId: string, minutes: number, commandId = `cmd_accept_${visitId}`): void {
  engine.acceptAssignment(
    state,
    { commandId, sessionId: state.sessionId, assignmentId: openAssignmentId(state, visitId) },
    at(minutes),
  )
}

function snap(state: MockState) {
  return engine.toSnapshot(state, at(99))
}

function visitOf(state: MockState, visitId: string) {
  const visit = snap(state).visits.find((candidate) => candidate.visitId === visitId)
  if (visit === undefined) throw new Error('missing visit')
  return visit
}

describe('US-01 opening the board', () => {
  it('seeds the roster Available in deterministic initial order with Next UP first', () => {
    const board = snap(session())
    expect(board.participants.map((p) => p.displayName)).toEqual([
      'Avery Collins',
      'Jordan Reyes',
      'Morgan Patel',
    ])
    expect(board.participants.every((p) => p.state === 'Available')).toBe(true)
    expect(board.participants.map((p) => p.queuePosition)).toEqual([1, 2, 3])
    expect(nextUpParticipantId(board.participants)).toBe(board.participants[0].participantId)
  })

  it('reports zero counts and 0% conversion on an empty run', () => {
    expect(snap(session()).metrics).toEqual({
      visitors: 0,
      assignedTurns: 0,
      acceptedTurns: 0,
      closedSales: 0,
      conversionRate: 0,
    })
  })
})

describe('US-02 registering a visitor', () => {
  it('reserves the first Available participant immediately', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const board = snap(state)

    expect(visitOf(state, visitId).serviceStatus).toBe('Assigned')
    expect(board.participants[0].state).toBe('PendingAcceptance')
    expect(board.participants[0].queuePosition).toBeNull()
    expect(board.participants[0].assignedCount).toBe(1)
    // Next UP moves on to the following eligible participant.
    expect(nextUpParticipantId(board.participants)).toBe(board.participants[1].participantId)
  })

  it('writes Manual source, Manual attributes and NotRequested enrichment', () => {
    const state = session()
    const visit = visitOf(state, arrive(state, 1))
    expect(visit.source).toBe('Manual')
    expect(visit.attributesSource).toBe('Manual')
    expect(visit.enrichmentStatus).toBe('NotRequested')
    expect(visit.arrivedAt).toBe(at(1))
    expect(visit.purchaseResult).toBeNull()
  })

  it('creates nothing extra when the same eventId is submitted again', () => {
    const state = session()
    arrive(state, 2, 'evt_same')
    const before = snap(state)
    engine.registerVisitor(state, { eventId: 'evt_same', sessionId: state.sessionId, profile }, at(3))
    const after = snap(state)

    expect(after.visits).toHaveLength(1)
    expect(after.metrics.assignedTurns).toBe(before.metrics.assignedTurns)
    expect(after.activity).toHaveLength(before.activity.length)
  })

  it('corrects profile fields without touching lifecycle state', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const before = visitOf(state, visitId)

    engine.updateVisitorProfile(
      state,
      {
        commandId: 'cmd_edit',
        sessionId: state.sessionId,
        visitId,
        profile: { ...profile, upperDescription: 'Red coat', gender: 'Unknown' },
      },
      at(4),
    )
    const after = visitOf(state, visitId)

    expect(after.profile.upperDescription).toBe('Red coat')
    expect(after.arrivedAt).toBe(before.arrivedAt)
    expect(after.serviceStatus).toBe(before.serviceStatus)
    expect(after.assignment?.assignmentId).toBe(before.assignment?.assignmentId)
    expect(after.purchaseResult).toBeNull()
  })
})

describe('US-03 accepting and completing a turn', () => {
  it('sets Accepted and On UP while keeping the participant ineligible', () => {
    const state = session()
    const visitId = arrive(state, 2)
    accept(state, visitId, 4)
    const board = snap(state)

    expect(visitOf(state, visitId).serviceStatus).toBe('Accepted')
    expect(visitOf(state, visitId).assignment?.acceptedAt).toBe(at(4))
    expect(board.participants[0].state).toBe('OnUP')
    expect(board.participants[0].queuePosition).toBeNull()
    expect(board.participants[0].acceptedCount).toBe(1)
  })

  it('completes the visit, releases the participant to the bottom and leaves them Inside', () => {
    const state = session()
    const visitId = arrive(state, 2)
    accept(state, visitId, 4)
    engine.recordOutcome(
      state,
      { commandId: 'cmd_sale', sessionId: state.sessionId, visitId, result: 'Sale' },
      at(10),
    )

    const visit = visitOf(state, visitId)
    expect(visit.serviceStatus).toBe('Completed')
    expect(visit.departedAt).toBeNull() // Completed but still Inside
    expect(visit.purchaseResult).toBe('Sale')
    expect(visit.assignment?.completionReason).toBe('OutcomeRecorded')

    const released = snap(state).participants[0]
    expect(released.state).toBe('Available')
    // Bottom of rotation: behind the two untouched participants.
    expect(released.queuePosition).toBe(4)
  })

  it('counts Sale visits only and uses every run visit as the denominator', () => {
    const state = session()
    const saleVisit = arrive(state, 1, 'evt_a')
    const noSaleVisit = arrive(state, 2, 'evt_b')
    accept(state, saleVisit, 3)
    accept(state, noSaleVisit, 4)
    engine.recordOutcome(
      state,
      { commandId: 'cmd_1', sessionId: state.sessionId, visitId: saleVisit, result: 'Sale' },
      at(5),
    )
    engine.recordOutcome(
      state,
      { commandId: 'cmd_2', sessionId: state.sessionId, visitId: noSaleVisit, result: 'NoSale' },
      at(6),
    )

    expect(snap(state).metrics).toEqual({
      visitors: 2,
      assignedTurns: 2,
      acceptedTurns: 2,
      closedSales: 1,
      conversionRate: 0.5,
    })
  })

  it('ignores a repeated acceptance and rejects a conflicting outcome', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const assignmentId = openAssignmentId(state, visitId)
    accept(state, visitId, 4)

    engine.acceptAssignment(
      state,
      { commandId: 'cmd_accept_again', sessionId: state.sessionId, assignmentId },
      at(5),
    )
    expect(snap(state).participants[0].acceptedCount).toBe(1)

    engine.recordOutcome(
      state,
      { commandId: 'cmd_o1', sessionId: state.sessionId, visitId, result: 'Sale' },
      at(6),
    )
    // Same outcome again is a no-op...
    engine.recordOutcome(
      state,
      { commandId: 'cmd_o2', sessionId: state.sessionId, visitId, result: 'Sale' },
      at(7),
    )
    expect(visitOf(state, visitId).purchaseRecordedAt).toBe(at(6))
    // ...a different one is rejected.
    expect(() =>
      engine.recordOutcome(
        state,
        { commandId: 'cmd_o3', sessionId: state.sessionId, visitId, result: 'NoSale' },
        at(8),
      ),
    ).toThrow(BoardError)
  })

  it('refuses an outcome on a turn that was never accepted', () => {
    const state = session()
    const visitId = arrive(state, 2)
    expect(() =>
      engine.recordOutcome(
        state,
        { commandId: 'cmd_early', sessionId: state.sessionId, visitId, result: 'Sale' },
        at(3),
      ),
    ).toThrow(BoardError)
  })
})

describe('US-04 registering a departure', () => {
  it('lets a Waiting visitor leave with a result and zero assignments', () => {
    const state = session()
    // Fill every participant so the fourth arrival has no capacity.
    const a = arrive(state, 1, 'evt_1')
    const b = arrive(state, 2, 'evt_2')
    const c = arrive(state, 3, 'evt_3')
    const waiting = arrive(state, 4, 'evt_4')
    expect([a, b, c].every((id) => visitOf(state, id).serviceStatus === 'Assigned')).toBe(true)
    expect(visitOf(state, waiting).serviceStatus).toBe('Waiting')
    expect(visitOf(state, waiting).assignment).toBeNull()

    engine.markExit(
      state,
      { commandId: 'cmd_exit', sessionId: state.sessionId, visitId: waiting, purchaseResult: 'NoSale' },
      at(6),
    )

    const visit = visitOf(state, waiting)
    expect(visit.departedAt).toBe(at(6))
    expect(visit.serviceStatus).toBe('Completed')
    expect(visit.purchaseResult).toBe('NoSale')
    expect(visit.assignment).toBeNull()
    expect(snap(state).metrics.assignedTurns).toBe(3)
  })

  it('requires an explicit result when none is recorded yet', () => {
    const state = session()
    const visitId = arrive(state, 2)
    expect(() =>
      engine.markExit(
        state,
        { commandId: 'cmd_exit', sessionId: state.sessionId, visitId, purchaseResult: null },
        at(5),
      ),
    ).toThrow(BoardError)
  })

  it('closes a pending assignment with reason Departure and no acceptedAt', () => {
    const state = session()
    const visitId = arrive(state, 2)
    engine.markExit(
      state,
      { commandId: 'cmd_exit', sessionId: state.sessionId, visitId, purchaseResult: 'NoSale' },
      at(5),
    )

    const visit = visitOf(state, visitId)
    expect(visit.assignment?.completionReason).toBe('Departure')
    expect(visit.assignment?.acceptedAt).toBeNull()
    // The reserved participant is released exactly once, to the bottom.
    const participants = snap(state).participants
    expect(participants[0].state).toBe('Available')
    expect(participants[0].queuePosition).toBe(4)
  })

  it('closes an accepted assignment with reason Departure while keeping acceptedAt', () => {
    const state = session()
    const visitId = arrive(state, 2)
    accept(state, visitId, 4)
    engine.markExit(
      state,
      { commandId: 'cmd_exit', sessionId: state.sessionId, visitId, purchaseResult: 'Sale' },
      at(9),
    )

    const visit = visitOf(state, visitId)
    expect(visit.assignment?.acceptedAt).toBe(at(4))
    expect(visit.assignment?.completionReason).toBe('Departure')
    expect(visit.purchaseResult).toBe('Sale')
  })

  it('does not touch the queue when service was already completed', () => {
    const state = session()
    const first = arrive(state, 1, 'evt_1')
    accept(state, first, 2)
    engine.recordOutcome(
      state,
      { commandId: 'cmd_sale', sessionId: state.sessionId, visitId: first, result: 'Sale' },
      at(5),
    )
    const queueAfterOutcome = snap(state).participants.map((p) => p.queuePosition)

    engine.markExit(
      state,
      { commandId: 'cmd_exit', sessionId: state.sessionId, visitId: first, purchaseResult: null },
      at(8),
    )

    expect(snap(state).participants.map((p) => p.queuePosition)).toEqual(queueAfterOutcome)
    expect(visitOf(state, first).purchaseResult).toBe('Sale')
    expect(visitOf(state, first).departedAt).toBe(at(8))
  })

  it('preserves the original exit on a duplicate and rejects a conflicting result', () => {
    const state = session()
    const visitId = arrive(state, 2)
    engine.markExit(
      state,
      { commandId: 'cmd_exit_1', sessionId: state.sessionId, visitId, purchaseResult: 'Sale' },
      at(5),
    )
    engine.markExit(
      state,
      { commandId: 'cmd_exit_2', sessionId: state.sessionId, visitId, purchaseResult: 'Sale' },
      at(7),
    )
    expect(visitOf(state, visitId).departedAt).toBe(at(5))

    expect(() =>
      engine.markExit(
        state,
        { commandId: 'cmd_exit_3', sessionId: state.sessionId, visitId, purchaseResult: 'NoSale' },
        at(8),
      ),
    ).toThrow(BoardError)
  })

  it('refuses to accept a departed visit again', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const assignmentId = openAssignmentId(state, visitId)
    engine.markExit(
      state,
      { commandId: 'cmd_exit', sessionId: state.sessionId, visitId, purchaseResult: 'NoSale' },
      at(5),
    )
    expect(() =>
      engine.acceptAssignment(
        state,
        { commandId: 'cmd_accept', sessionId: state.sessionId, assignmentId },
        at(6),
      ),
    ).toThrow(BoardError)
  })
})

describe('US-05 availability and waiting visitors', () => {
  it('refuses availability changes for a busy participant', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const reserved = snap(state).participants[0]
    expect(() =>
      engine.setAvailability(
        state,
        { commandId: 'cmd_a', sessionId: state.sessionId, participantId: reserved.participantId, state: 'OffFloor' },
        at(3),
      ),
    ).toThrow(BoardError)

    accept(state, visitId, 4)
    expect(() =>
      engine.setAvailability(
        state,
        { commandId: 'cmd_b', sessionId: state.sessionId, participantId: reserved.participantId, state: 'OffFloor' },
        at(5),
      ),
    ).toThrow(BoardError)
  })

  it('keeps a visit Waiting while everyone is Off Floor, then assigns on return', () => {
    const state = session()
    for (const participant of snap(state).participants) {
      engine.setAvailability(
        state,
        {
          commandId: `cmd_off_${participant.participantId}`,
          sessionId: state.sessionId,
          participantId: participant.participantId,
          state: 'OffFloor',
        },
        at(1),
      )
    }

    const visitId = arrive(state, 2)
    expect(visitOf(state, visitId).serviceStatus).toBe('Waiting')
    expect(snap(state).metrics.assignedTurns).toBe(0)

    const returning = snap(state).participants[1]
    engine.setAvailability(
      state,
      { commandId: 'cmd_back', sessionId: state.sessionId, participantId: returning.participantId, state: 'Available' },
      at(5),
    )

    expect(visitOf(state, visitId).serviceStatus).toBe('Assigned')
    expect(visitOf(state, visitId).assignment?.participantId).toBe(returning.participantId)
  })

  it('assigns waiting visits in registration order when capacity returns', () => {
    const state = session()
    const ids = [1, 2, 3, 4, 5].map((minute) => arrive(state, minute, `evt_${minute}`))
    const [first, second, third, fourth, fifth] = ids
    expect(visitOf(state, fourth).serviceStatus).toBe('Waiting')
    expect(visitOf(state, fifth).serviceStatus).toBe('Waiting')

    accept(state, first, 6)
    engine.recordOutcome(
      state,
      { commandId: 'cmd_sale', sessionId: state.sessionId, visitId: first, result: 'Sale' },
      at(7),
    )

    // The released participant takes the oldest waiting visit, not the newest.
    expect(visitOf(state, fourth).serviceStatus).toBe('Assigned')
    expect(visitOf(state, fifth).serviceStatus).toBe('Waiting')
    expect(visitOf(state, second).serviceStatus).toBe('Assigned')
    expect(visitOf(state, third).serviceStatus).toBe('Assigned')
  })

  it('appends a returning participant to the bottom of the rotation', () => {
    const state = session()
    const target = snap(state).participants[0]
    engine.setAvailability(
      state,
      { commandId: 'cmd_off', sessionId: state.sessionId, participantId: target.participantId, state: 'OffFloor' },
      at(1),
    )
    expect(snap(state).participants[0].queuePosition).toBeNull()

    engine.setAvailability(
      state,
      { commandId: 'cmd_on', sessionId: state.sessionId, participantId: target.participantId, state: 'Available' },
      at(2),
    )
    expect(snap(state).participants[0].queuePosition).toBe(4)
    expect(nextUpParticipantId(snap(state).participants)).toBe(snap(state).participants[1].participantId)
  })

  it('treats a delayed replay of the original commandId as a no-op', () => {
    const state = session()
    const target = snap(state).participants[0]
    engine.setAvailability(
      state,
      { commandId: 'cmd_retry', sessionId: state.sessionId, participantId: target.participantId, state: 'OffFloor' },
      at(1),
    )
    engine.setAvailability(
      state,
      { commandId: 'cmd_later', sessionId: state.sessionId, participantId: target.participantId, state: 'Available' },
      at(2),
    )
    const positions = snap(state).participants.map((p) => p.queuePosition)

    // The replay must not undo the later change or append a second time.
    engine.setAvailability(
      state,
      { commandId: 'cmd_retry', sessionId: state.sessionId, participantId: target.participantId, state: 'OffFloor' },
      at(3),
    )
    expect(snap(state).participants.map((p) => p.queuePosition)).toEqual(positions)
    expect(snap(state).participants[0].state).toBe('Available')
  })

  it('never reserves one participant twice under rapid arrivals', () => {
    const state = session()
    const ids = [1, 2, 3, 4].map((minute) => arrive(state, minute, `evt_${minute}`))
    const assigned = ids
      .map((id) => visitOf(state, id).assignment?.participantId)
      .filter((value): value is string => value !== undefined && value !== null)

    expect(assigned).toHaveLength(3)
    expect(new Set(assigned).size).toBe(3)
  })
})

describe('US-06 resetting the demonstration', () => {
  it('creates a fresh session with zero metrics and the initial roster order', () => {
    const state = session()
    const visitId = arrive(state, 2)
    accept(state, visitId, 4)

    const reset = engine.createSession('ses_next', at(30))
    const board = engine.toSnapshot(reset, at(31))

    expect(board.session.sessionId).not.toBe(state.sessionId)
    expect(board.session.startedAt).toBe(at(30))
    expect(board.visits).toHaveLength(0)
    expect(board.metrics.visitors).toBe(0)
    expect(board.metrics.conversionRate).toBe(0)
    expect(board.participants.map((p) => p.state)).toEqual(['Available', 'Available', 'Available'])
    expect(board.participants.map((p) => p.queuePosition)).toEqual([1, 2, 3])
    expect(board.participants.map((p) => p.associateId)).toEqual(['as_1', 'as_2', 'as_3'])
  })

  it('rejects an in-flight command carrying the old sessionId', () => {
    const state = session()
    expect(() =>
      engine.registerVisitor(state, { eventId: 'evt_stale', sessionId: 'ses_old', profile }, at(3)),
    ).toThrow(BoardError)
    expect(snap(state).visits).toHaveLength(0)
  })
})

describe('activity log', () => {
  it('is newest first and records each board event once', () => {
    const state = session()
    const visitId = arrive(state, 2)
    accept(state, visitId, 4)
    const entries = snap(state).activity

    expect(entries.map((entry) => entry.kind)).toEqual([
      'AssignmentAccepted',
      'AssignmentCreated',
      'VisitRegistered',
      'SessionStarted',
    ])
    expect(entries[0].occurredAt).toBe(at(4))
  })
})
