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
import type { VisitorAttributes } from '../lib/types.ts'

const BASE = new Date('2026-01-05T09:00:00.000Z')
const at = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000).toISOString()

const attributes: VisitorAttributes = {
  upperDescription: 'Navy puffer jacket',
  lowerDescription: 'Grey jeans',
  accessoryDescription: null,
  ageGroup: 'From20To39',
  gender: 'Female',
}

function session(): MockState {
  return engine.createSession('ses_test', BASE.toISOString())
}

/** Registers a visitor and returns its id. */
function arrive(state: MockState, minutes: number, eventId = `evt_${minutes}`): string {
  const result = engine.registerVisitor(state, { eventId, sessionId: state.sessionId, attributes }, at(minutes))
  return result.visitId
}

function snap(state: MockState) {
  return engine.toSnapshot(state, at(99))
}

function visitOf(state: MockState, visitId: string) {
  const visit = snap(state).visits.find((candidate) => candidate.visitId === visitId)
  if (visit === undefined) throw new Error('missing visit')
  return visit
}

function assignmentIdOf(state: MockState, visitId: string): string {
  const assignmentId = visitOf(state, visitId).assignmentId
  if (assignmentId === null) throw new Error(`no assignment for ${visitId}`)
  return assignmentId
}

function accept(state: MockState, visitId: string, minutes: number): void {
  engine.acceptAssignment(state, { sessionId: state.sessionId, assignmentId: assignmentIdOf(state, visitId) }, at(minutes))
}

describe('US-01 opening the board', () => {
  it('seeds the roster Available in deterministic initial order with Next UP first', () => {
    const board = snap(session())
    expect(board.associates.map((p) => p.displayName)).toEqual(['Avery Collins', 'Jordan Reyes', 'Morgan Patel'])
    expect(board.associates.every((p) => p.state === 'Available')).toBe(true)
    expect(board.associates.map((p) => p.queuePosition)).toEqual([1, 2, 3])
    expect(nextUpParticipantId(board.associates)).toBe(board.associates[0].participantId)
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

  it('starts with an empty activity log', () => {
    expect(snap(session()).activity).toEqual([])
  })
})

describe('US-02 registering a visitor', () => {
  it('reserves the first Available participant immediately', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const board = snap(state)

    expect(visitOf(state, visitId).status).toBe('Assigned')
    expect(board.associates[0].state).toBe('PendingAcceptance')
    expect(board.associates[0].queuePosition).toBeNull()
    expect(board.associates[0].assignedTurns).toBe(1)
    // Next UP moves on to the following eligible participant.
    expect(nextUpParticipantId(board.associates)).toBe(board.associates[1].participantId)
  })

  it('writes Manual source, Manual attributes and NotRequested enrichment', () => {
    const state = session()
    const visit = visitOf(state, arrive(state, 1))
    expect(visit.source).toBe('Manual')
    expect(visit.attributesSource).toBe('Manual')
    expect(visit.enrichmentStatus).toBe('NotRequested')
    expect(visit.arrivedAt).toBe(at(1))
    expect(visit.outcome).toBeNull()
  })

  it('creates nothing extra when the same eventId is submitted again', () => {
    const state = session()
    arrive(state, 2, 'evt_same')
    const before = snap(state)
    const replay = engine.registerVisitor(state, { eventId: 'evt_same', sessionId: state.sessionId, attributes }, at(3))
    const after = snap(state)

    expect(replay.duplicate).toBe(true)
    expect(after.visits).toHaveLength(1)
    expect(after.metrics.assignedTurns).toBe(before.metrics.assignedTurns)
    expect(after.activity).toHaveLength(before.activity.length)
  })

  it('corrects attributes without touching lifecycle state', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const before = visitOf(state, visitId)

    engine.updateAttributes(
      state,
      {
        sessionId: state.sessionId,
        visitId,
        attributes: { ...attributes, upperDescription: 'Red coat', gender: 'Unknown' },
      },
      at(4),
    )
    const after = visitOf(state, visitId)

    expect(after.attributes.upperDescription).toBe('Red coat')
    expect(after.arrivedAt).toBe(before.arrivedAt)
    expect(after.status).toBe(before.status)
    expect(after.assignmentId).toBe(before.assignmentId)
    expect(after.outcome).toBeNull()
  })
})

describe('US-03 accepting and completing a turn', () => {
  it('sets Accepted and On UP while keeping the participant ineligible', () => {
    const state = session()
    const visitId = arrive(state, 2)
    accept(state, visitId, 4)
    const board = snap(state)

    expect(visitOf(state, visitId).status).toBe('Accepted')
    expect(board.assignments[0].acceptedAt).toBe(at(4))
    expect(board.associates[0].state).toBe('OnUP')
    expect(board.associates[0].queuePosition).toBeNull()
    expect(board.associates[0].acceptedTurns).toBe(1)
  })

  it('completes the turn, releases the participant to the bottom and leaves them Inside', () => {
    const state = session()
    const visitId = arrive(state, 2)
    accept(state, visitId, 4)
    const assignmentId = assignmentIdOf(state, visitId)
    engine.recordOutcome(state, { sessionId: state.sessionId, assignmentId, outcome: 'Sale' }, at(10))

    const visit = visitOf(state, visitId)
    expect(visit.status).toBe('Completed')
    expect(visit.departedAt).toBeNull() // Completed but still Inside
    expect(visit.outcome).toBe('Sale')
    const assignment = snap(state).assignments.find((a) => a.assignmentId === assignmentId)
    expect(assignment?.completionReason).toBe('OutcomeRecorded')
    expect(assignment?.phase).toBe('Completed')

    const released = snap(state).associates[0]
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
      { sessionId: state.sessionId, assignmentId: assignmentIdOf(state, saleVisit), outcome: 'Sale' },
      at(5),
    )
    engine.recordOutcome(
      state,
      { sessionId: state.sessionId, assignmentId: assignmentIdOf(state, noSaleVisit), outcome: 'NoSale' },
      at(6),
    )

    expect(snap(state).metrics).toEqual({
      visitors: 2,
      assignedTurns: 2,
      acceptedTurns: 2,
      closedSales: 1,
      conversionRate: 50,
    })
  })

  it('ignores a repeated acceptance and rejects a conflicting outcome', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const assignmentId = assignmentIdOf(state, visitId)
    accept(state, visitId, 4)

    engine.acceptAssignment(state, { sessionId: state.sessionId, assignmentId }, at(5))
    expect(snap(state).associates[0].acceptedTurns).toBe(1)

    engine.recordOutcome(state, { sessionId: state.sessionId, assignmentId, outcome: 'Sale' }, at(6))
    // Same outcome again is a no-op...
    engine.recordOutcome(state, { sessionId: state.sessionId, assignmentId, outcome: 'Sale' }, at(7))
    expect(visitOf(state, visitId).outcomeRecordedAt).toBe(at(6))
    // ...a different one is rejected.
    expect(() =>
      engine.recordOutcome(state, { sessionId: state.sessionId, assignmentId, outcome: 'NoSale' }, at(8)),
    ).toThrow(BoardError)
  })

  it('refuses an outcome on a turn that was never accepted', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const assignmentId = assignmentIdOf(state, visitId)
    expect(() =>
      engine.recordOutcome(state, { sessionId: state.sessionId, assignmentId, outcome: 'Sale' }, at(3)),
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
    expect([a, b, c].every((id) => visitOf(state, id).status === 'Assigned')).toBe(true)
    expect(visitOf(state, waiting).status).toBe('Waiting')
    expect(visitOf(state, waiting).assignmentId).toBeNull()
    expect(visitOf(state, waiting).waitingPosition).toBe(1)

    engine.markDeparture(state, { sessionId: state.sessionId, visitId: waiting, outcome: 'NoSale' }, at(6))

    const visit = visitOf(state, waiting)
    expect(visit.departedAt).toBe(at(6))
    expect(visit.status).toBe('Completed')
    expect(visit.outcome).toBe('NoSale')
    expect(visit.assignmentId).toBeNull()
    expect(visit.waitingPosition).toBeNull()
    expect(snap(state).metrics.assignedTurns).toBe(3)
  })

  it('requires an explicit result when none is recorded yet', () => {
    const state = session()
    const visitId = arrive(state, 2)
    expect(() =>
      engine.markDeparture(state, { sessionId: state.sessionId, visitId, outcome: null }, at(5)),
    ).toThrow(BoardError)
  })

  it('closes a pending assignment with reason Departure and no acceptedAt', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const assignmentId = assignmentIdOf(state, visitId)
    engine.markDeparture(state, { sessionId: state.sessionId, visitId, outcome: 'NoSale' }, at(5))

    const assignment = snap(state).assignments.find((a) => a.assignmentId === assignmentId)
    expect(assignment?.completionReason).toBe('Departure')
    expect(assignment?.acceptedAt).toBeNull()
    // The reserved participant is released exactly once, to the bottom.
    const associates = snap(state).associates
    expect(associates[0].state).toBe('Available')
    expect(associates[0].queuePosition).toBe(4)
  })

  it('closes an accepted assignment with reason Departure while keeping acceptedAt', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const assignmentId = assignmentIdOf(state, visitId)
    accept(state, visitId, 4)
    engine.markDeparture(state, { sessionId: state.sessionId, visitId, outcome: 'Sale' }, at(9))

    const assignment = snap(state).assignments.find((a) => a.assignmentId === assignmentId)
    expect(assignment?.acceptedAt).toBe(at(4))
    expect(assignment?.completionReason).toBe('Departure')
    expect(visitOf(state, visitId).outcome).toBe('Sale')
  })

  it('does not touch the queue when the turn was already completed', () => {
    const state = session()
    const first = arrive(state, 1, 'evt_1')
    accept(state, first, 2)
    engine.recordOutcome(
      state,
      { sessionId: state.sessionId, assignmentId: assignmentIdOf(state, first), outcome: 'Sale' },
      at(5),
    )
    const queueAfterOutcome = snap(state).associates.map((p) => p.queuePosition)

    engine.markDeparture(state, { sessionId: state.sessionId, visitId: first, outcome: null }, at(8))

    expect(snap(state).associates.map((p) => p.queuePosition)).toEqual(queueAfterOutcome)
    expect(visitOf(state, first).outcome).toBe('Sale')
    expect(visitOf(state, first).departedAt).toBe(at(8))
  })

  it('preserves the original exit on a duplicate and rejects a conflicting result', () => {
    const state = session()
    const visitId = arrive(state, 2)
    engine.markDeparture(state, { sessionId: state.sessionId, visitId, outcome: 'Sale' }, at(5))
    engine.markDeparture(state, { sessionId: state.sessionId, visitId, outcome: 'Sale' }, at(7))
    expect(visitOf(state, visitId).departedAt).toBe(at(5))

    expect(() =>
      engine.markDeparture(state, { sessionId: state.sessionId, visitId, outcome: 'NoSale' }, at(8)),
    ).toThrow(BoardError)
  })

  it('refuses to accept a departed visit again', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const assignmentId = assignmentIdOf(state, visitId)
    engine.markDeparture(state, { sessionId: state.sessionId, visitId, outcome: 'NoSale' }, at(5))
    expect(() => engine.acceptAssignment(state, { sessionId: state.sessionId, assignmentId }, at(6))).toThrow(
      BoardError,
    )
  })
})

describe('US-05 availability and waiting visitors', () => {
  it('refuses availability changes for a busy participant', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const reserved = snap(state).associates[0]
    expect(() =>
      engine.setAvailability(
        state,
        { sessionId: state.sessionId, participantId: reserved.participantId, commandId: 'cmd_a', state: 'OffFloor' },
        at(3),
      ),
    ).toThrow(BoardError)

    accept(state, visitId, 4)
    expect(() =>
      engine.setAvailability(
        state,
        { sessionId: state.sessionId, participantId: reserved.participantId, commandId: 'cmd_b', state: 'OffFloor' },
        at(5),
      ),
    ).toThrow(BoardError)
  })

  it('keeps a visit Waiting while everyone is Off Floor, then assigns on return', () => {
    const state = session()
    for (const participant of snap(state).associates) {
      engine.setAvailability(
        state,
        {
          sessionId: state.sessionId,
          participantId: participant.participantId,
          commandId: `cmd_off_${participant.participantId}`,
          state: 'OffFloor',
        },
        at(1),
      )
    }

    const visitId = arrive(state, 2)
    expect(visitOf(state, visitId).status).toBe('Waiting')
    expect(snap(state).metrics.assignedTurns).toBe(0)

    const returning = snap(state).associates[1]
    engine.setAvailability(
      state,
      { sessionId: state.sessionId, participantId: returning.participantId, commandId: 'cmd_back', state: 'Available' },
      at(5),
    )

    expect(visitOf(state, visitId).status).toBe('Assigned')
    const assignment = snap(state).assignments.find((a) => a.visitId === visitId)
    expect(assignment?.participantId).toBe(returning.participantId)
  })

  it('assigns waiting visits in registration order when capacity returns', () => {
    const state = session()
    const ids = [1, 2, 3, 4, 5].map((minute) => arrive(state, minute, `evt_${minute}`))
    const [first, , , fourth, fifth] = ids
    expect(visitOf(state, fourth).status).toBe('Waiting')
    expect(visitOf(state, fifth).status).toBe('Waiting')

    const firstAssignmentId = assignmentIdOf(state, first)
    accept(state, first, 6)
    engine.recordOutcome(state, { sessionId: state.sessionId, assignmentId: firstAssignmentId, outcome: 'Sale' }, at(7))

    // The released participant takes the oldest waiting visit, not the newest.
    expect(visitOf(state, fourth).status).toBe('Assigned')
    expect(visitOf(state, fifth).status).toBe('Waiting')
    expect(visitOf(state, ids[1]).status).toBe('Assigned')
    expect(visitOf(state, ids[2]).status).toBe('Assigned')
  })

  it('appends a returning participant to the bottom of the rotation', () => {
    const state = session()
    const target = snap(state).associates[0]
    engine.setAvailability(
      state,
      { sessionId: state.sessionId, participantId: target.participantId, commandId: 'cmd_off', state: 'OffFloor' },
      at(1),
    )
    expect(snap(state).associates[0].queuePosition).toBeNull()

    engine.setAvailability(
      state,
      { sessionId: state.sessionId, participantId: target.participantId, commandId: 'cmd_on', state: 'Available' },
      at(2),
    )
    expect(snap(state).associates[0].queuePosition).toBe(4)
    expect(nextUpParticipantId(snap(state).associates)).toBe(snap(state).associates[1].participantId)
  })

  it('treats a delayed replay of the original commandId as a no-op', () => {
    const state = session()
    const target = snap(state).associates[0]
    engine.setAvailability(
      state,
      { sessionId: state.sessionId, participantId: target.participantId, commandId: 'cmd_retry', state: 'OffFloor' },
      at(1),
    )
    engine.setAvailability(
      state,
      { sessionId: state.sessionId, participantId: target.participantId, commandId: 'cmd_later', state: 'Available' },
      at(2),
    )
    const positions = snap(state).associates.map((p) => p.queuePosition)

    // The replay must not undo the later change or append a second time.
    engine.setAvailability(
      state,
      { sessionId: state.sessionId, participantId: target.participantId, commandId: 'cmd_retry', state: 'OffFloor' },
      at(3),
    )
    expect(snap(state).associates.map((p) => p.queuePosition)).toEqual(positions)
    expect(snap(state).associates[0].state).toBe('Available')
  })

  it('never reserves one participant twice under rapid arrivals', () => {
    const state = session()
    const ids = [1, 2, 3, 4].map((minute) => arrive(state, minute, `evt_${minute}`))
    const assigned = ids
      .map((id) => visitOf(state, id).assignmentId)
      .filter((value): value is string => value !== null)
    const participantIds = assigned.map(
      (assignmentId) => snap(state).assignments.find((a) => a.assignmentId === assignmentId)?.participantId,
    )

    expect(assigned).toHaveLength(3)
    expect(new Set(participantIds).size).toBe(3)
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
    expect(board.associates.map((p) => p.state)).toEqual(['Available', 'Available', 'Available'])
    expect(board.associates.map((p) => p.queuePosition)).toEqual([1, 2, 3])
    expect(board.associates.map((p) => p.associateId)).toEqual(['as_1', 'as_2', 'as_3'])
  })

  it('rejects an in-flight command carrying the old sessionId', () => {
    const state = session()
    expect(() =>
      engine.registerVisitor(state, { eventId: 'evt_stale', sessionId: 'ses_old', attributes }, at(3)),
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

    expect(entries.map((entry) => entry.kind)).toEqual(['AssignmentAccepted', 'AssignmentCreated', 'ArrivalRecorded'])
    expect(entries[0].occurredAt).toBe(at(4))
  })
})
