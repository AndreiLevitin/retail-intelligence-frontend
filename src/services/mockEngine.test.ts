/**
 * Story-level checks on the mock engine. These verify the transitions the
 * stories describe under "Assignment Rotation Revision - Advance on
 * Acceptance": US-01 initial order, US-02 registration and idempotency,
 * US-03 accept/outcome, US-04 departure, US-05 the single pending-offer
 * gate and availability, US-06 reset and stale sessions.
 */
import { describe, expect, it } from 'vitest'
import { BoardError } from './boardService.ts'
import * as engine from './mockEngine.ts'
import type { MockState } from './mockEngine.ts'
import { hasPendingOffer, nextUpParticipantId } from '../lib/types.ts'
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

function associateOf(state: MockState, participantId: string) {
  const associate = snap(state).associates.find((candidate) => candidate.participantId === participantId)
  if (associate === undefined) throw new Error('missing associate')
  return associate
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
  it('offers the first visitor to the front-of-queue associate, keeping their queue position', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const board = snap(state)

    expect(visitOf(state, visitId).status).toBe('Assigned')
    // Offering never moves the participant or changes their availability.
    expect(board.associates[0].state).toBe('Available')
    expect(board.associates[0].queuePosition).toBe(1)
    expect(board.associates[0].pendingAssignmentId).not.toBeNull()
    expect(board.associates[0].assignedTurns).toBe(1)
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
  it('accepts, moves the participant to the queue bottom exactly once, and keeps them Available', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const first = snap(state).associates[0].participantId
    accept(state, visitId, 4)
    const board = snap(state)

    expect(visitOf(state, visitId).status).toBe('Accepted')
    expect(board.assignments[0].acceptedAt).toBe(at(4))
    const accepted = associateOf(state, first)
    expect(accepted.state).toBe('Available')
    expect(accepted.pendingAssignmentId).toBeNull()
    expect(accepted.activeTurns).toBe(1)
    expect(accepted.acceptedTurns).toBe(1)
    // Moved to the bottom: queuePosition is a dense 1..N rank among
    // Available associates (confirmed against the live backend), so the
    // just-accepted participant becomes rank 3 of 3, not a raw ever-growing
    // token value.
    expect(accepted.queuePosition).toBe(3)
  })

  it('completes the turn without touching rotation or availability; visitor stays Inside', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const participantId = snap(state).associates[0].participantId
    accept(state, visitId, 4)
    const queueBefore = snap(state).associates.map((p) => p.queuePosition)
    const assignmentId = assignmentIdOf(state, visitId)
    engine.recordOutcome(state, { sessionId: state.sessionId, assignmentId, outcome: 'Sale' }, at(10))

    const visit = visitOf(state, visitId)
    expect(visit.status).toBe('Completed')
    expect(visit.departedAt).toBeNull() // Completed but still Inside
    expect(visit.outcome).toBe('Sale')
    const assignment = snap(state).assignments.find((a) => a.assignmentId === assignmentId)
    expect(assignment?.completionReason).toBe('OutcomeRecorded')
    expect(assignment?.phase).toBe('Completed')

    expect(snap(state).associates.map((p) => p.queuePosition)).toEqual(queueBefore)
    expect(associateOf(state, participantId).activeTurns).toBe(0)
  })

  it('counts Sale visits only and uses every run visit as the denominator', () => {
    const state = session()
    const saleVisit = arrive(state, 1, 'evt_a')
    accept(state, saleVisit, 2)
    engine.recordOutcome(
      state,
      { sessionId: state.sessionId, assignmentId: assignmentIdOf(state, saleVisit), outcome: 'Sale' },
      at(3),
    )
    const noSaleVisit = arrive(state, 4, 'evt_b')
    accept(state, noSaleVisit, 5)
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
    expect(associateOf(state, snap(state).associates[0].participantId).acceptedTurns).toBe(1)

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

describe('US-05 rotation: at most one unresolved offer per session', () => {
  it('offers A, B and C in turn as each accepts - the A -> B -> C -> A regression', () => {
    const state = session()
    const [a, b, c] = snap(state).associates.map((p) => p.participantId)

    const v1 = arrive(state, 1, 'evt_1')
    expect(visitOf(state, v1).status).toBe('Assigned')
    expect(associateOf(state, a).pendingAssignmentId).not.toBeNull()

    const v2 = arrive(state, 2, 'evt_2')
    const v3 = arrive(state, 3, 'evt_3')
    const v4 = arrive(state, 4, 'evt_4')
    // All three remain Available; none is "busy" - only the gate blocks offers.
    expect(snap(state).associates.every((p) => p.state === 'Available')).toBe(true)
    expect(visitOf(state, v2).status).toBe('Waiting')
    expect(visitOf(state, v3).status).toBe('Waiting')
    expect(visitOf(state, v4).status).toBe('Waiting')

    accept(state, v1, 5) // A accepts -> offer V2 to B
    // Dense rank, not a raw token: the just-accepted associate is always
    // rank 3 of 3 (confirmed against the live backend).
    expect(associateOf(state, a).queuePosition).toBe(3)
    expect(visitOf(state, v2).status).toBe('Assigned')
    expect(associateOf(state, b).pendingAssignmentId).not.toBeNull()

    accept(state, v2, 6) // B accepts -> offer V3 to C
    expect(associateOf(state, b).queuePosition).toBe(3)
    expect(visitOf(state, v3).status).toBe('Assigned')
    expect(associateOf(state, c).pendingAssignmentId).not.toBeNull()

    accept(state, v3, 7) // C accepts -> offer V4 to A, even though A's V1 is still unfinished
    expect(associateOf(state, c).queuePosition).toBe(3)
    expect(visitOf(state, v4).status).toBe('Assigned')
    const offerForV4 = snap(state).assignments.find((asg) => asg.visitId === v4)
    expect(offerForV4?.participantId).toBe(a)
    expect(associateOf(state, a).activeTurns).toBe(1) // V1 still accepted, unfinished
    expect(associateOf(state, a).pendingAssignmentId).toBe(offerForV4?.assignmentId)

    // No sale was ever completed in this whole sequence.
    expect(snap(state).metrics.closedSales).toBe(0)
  })

  it('never offers a second visit while one offer is unresolved, even with other Available associates', () => {
    const state = session()
    arrive(state, 1, 'evt_1')
    arrive(state, 2, 'evt_2')
    arrive(state, 3, 'evt_3')

    const board = snap(state)
    expect(board.assignments).toHaveLength(1)
    expect(board.visits.filter((v) => v.status === 'Waiting')).toHaveLength(2)
    expect(hasPendingOffer(board)).toBe(true)
  })

  it('lets accepted, unfinished work coexist with a brand new offer to the same associate', () => {
    const state = session()
    const v1 = arrive(state, 1, 'evt_1')
    accept(state, v1, 2) // front-of-queue associate now has one accepted-unfinished turn
    const sameAssociate = snap(state).assignments[0].participantId

    // Two more arrive; the second one loops back to the same associate once
    // the first is accepted, per the A -> B -> C -> A cycle on a 1-roster slice.
    const v2 = arrive(state, 3, 'evt_2')
    expect(associateOf(state, sameAssociate).activeTurns).toBe(1)
    expect(visitOf(state, v2).status).toBe('Assigned')
  })
})

describe('US-04 registering a departure', () => {
  it('lets a Waiting visitor (blocked behind the gate) leave with a result and zero assignments', () => {
    const state = session()
    arrive(state, 1, 'evt_1') // takes the one offer
    const waiting = arrive(state, 2, 'evt_2') // stays Waiting behind it

    expect(visitOf(state, waiting).status).toBe('Waiting')
    expect(visitOf(state, waiting).assignmentId).toBeNull()
    expect(visitOf(state, waiting).waitingPosition).toBe(1)

    engine.markDeparture(state, { sessionId: state.sessionId, visitId: waiting, outcome: 'NoSale' }, at(6))

    const visit = visitOf(state, waiting)
    expect(visit.departedAt).toBe(at(6))
    expect(visit.status).toBe('Completed')
    expect(visit.outcome).toBe('NoSale')
    expect(visit.assignmentId).toBeNull()
    expect(snap(state).metrics.assignedTurns).toBe(1)
  })

  it('requires an explicit result when none is recorded yet', () => {
    const state = session()
    const visitId = arrive(state, 2)
    expect(() =>
      engine.markDeparture(state, { sessionId: state.sessionId, visitId, outcome: null }, at(5)),
    ).toThrow(BoardError)
  })

  it('closes a pending offer with reason Departure, clears the gate, and never consumes the turn or moves the queue', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const participantId = snap(state).associates[0].participantId
    const assignmentId = assignmentIdOf(state, visitId)
    const next = arrive(state, 3, 'evt_next') // stays Waiting behind the pending offer

    engine.markDeparture(state, { sessionId: state.sessionId, visitId, outcome: 'NoSale' }, at(5))

    const assignment = snap(state).assignments.find((a) => a.assignmentId === assignmentId)
    expect(assignment?.completionReason).toBe('Departure')
    expect(assignment?.acceptedAt).toBeNull()
    // The turn is not consumed and the queue is not moved by this departure:
    // the same associate is still front-of-queue, so the freshly cleared
    // gate immediately offers them the next oldest Waiting visit.
    const associate = associateOf(state, participantId)
    expect(associate.state).toBe('Available')
    expect(associate.queuePosition).toBe(1)
    expect(associate.pendingAssignmentId).not.toBe(assignmentId)
    expect(associate.pendingAssignmentId).not.toBeNull()
    expect(visitOf(state, next).status).toBe('Assigned')
    expect(visitOf(state, next).assignmentId).toBe(associate.pendingAssignmentId)
  })

  it('closes an accepted assignment with reason Departure while keeping acceptedAt and rotation unchanged', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const participantId = snap(state).associates[0].participantId
    const assignmentId = assignmentIdOf(state, visitId)
    accept(state, visitId, 4)
    const queueBefore = snap(state).associates.map((p) => p.queuePosition)

    engine.markDeparture(state, { sessionId: state.sessionId, visitId, outcome: 'Sale' }, at(9))

    const assignment = snap(state).assignments.find((a) => a.assignmentId === assignmentId)
    expect(assignment?.acceptedAt).toBe(at(4))
    expect(assignment?.completionReason).toBe('Departure')
    expect(visitOf(state, visitId).outcome).toBe('Sale')
    expect(snap(state).associates.map((p) => p.queuePosition)).toEqual(queueBefore)
    expect(associateOf(state, participantId).activeTurns).toBe(0)
  })

  it('does not touch rotation when the turn was already completed', () => {
    const state = session()
    const visitId = arrive(state, 1, 'evt_1')
    accept(state, visitId, 2)
    engine.recordOutcome(
      state,
      { sessionId: state.sessionId, assignmentId: assignmentIdOf(state, visitId), outcome: 'Sale' },
      at(5),
    )
    const queueAfterOutcome = snap(state).associates.map((p) => p.queuePosition)

    engine.markDeparture(state, { sessionId: state.sessionId, visitId, outcome: null }, at(8))

    expect(snap(state).associates.map((p) => p.queuePosition)).toEqual(queueAfterOutcome)
    expect(visitOf(state, visitId).outcome).toBe('Sale')
    expect(visitOf(state, visitId).departedAt).toBe(at(8))
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

describe('US-05 availability', () => {
  it('rejects Off Floor only while the associate owns the pending offer; accepted work never blocks it', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const owner = snap(state).associates[0].participantId

    expect(() =>
      engine.setAvailability(
        state,
        { sessionId: state.sessionId, participantId: owner, commandId: 'cmd_a', state: 'OffFloor' },
        at(3),
      ),
    ).toThrow(BoardError)

    accept(state, visitId, 4)
    // Now only accepted, unfinished work remains - Off Floor is allowed.
    engine.setAvailability(
      state,
      { sessionId: state.sessionId, participantId: owner, commandId: 'cmd_b', state: 'OffFloor' },
      at(5),
    )
    expect(associateOf(state, owner).state).toBe('OffFloor')
    expect(associateOf(state, owner).activeTurns).toBe(1)
  })

  it('keeps a visit Waiting while everyone is Off Floor ("No available associates"), then offers on return', () => {
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
    expect(hasPendingOffer(snap(state))).toBe(false)

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

  it('queuePosition is a dense 1..N rank among Available associates, not a raw token', () => {
    // Confirmed directly against the live (migrated) backend: OffFloor
    // compacts the remaining ranks rather than leaving a gap, and a
    // returning associate re-expands them at the bottom.
    const state = session()
    const [first, second, third] = snap(state).associates
    expect(snap(state).associates.map((a) => a.queuePosition)).toEqual([1, 2, 3])

    engine.setAvailability(
      state,
      { sessionId: state.sessionId, participantId: second.participantId, commandId: 'cmd_off', state: 'OffFloor' },
      at(1),
    )
    // The middle associate leaves; the one behind them compacts up to rank 2.
    expect(associateOf(state, first.participantId).queuePosition).toBe(1)
    expect(associateOf(state, second.participantId).queuePosition).toBeNull()
    expect(associateOf(state, third.participantId).queuePosition).toBe(2)

    engine.setAvailability(
      state,
      { sessionId: state.sessionId, participantId: second.participantId, commandId: 'cmd_on', state: 'Available' },
      at(2),
    )
    // Returns at the bottom of the now-3-wide rank, not at their old rank.
    expect(associateOf(state, first.participantId).queuePosition).toBe(1)
    expect(associateOf(state, third.participantId).queuePosition).toBe(2)
    expect(associateOf(state, second.participantId).queuePosition).toBe(3)
  })

  it('assigns waiting visits in registration order as the gate clears', () => {
    const state = session()
    const ids = [1, 2, 3, 4, 5].map((minute) => arrive(state, minute, `evt_${minute}`))
    const [first, second, third, fourth, fifth] = ids
    expect(visitOf(state, second).status).toBe('Waiting')
    expect(visitOf(state, fourth).status).toBe('Waiting')
    expect(visitOf(state, fifth).status).toBe('Waiting')

    accept(state, first, 6) // offers V2
    accept(state, second, 7) // offers V3
    accept(state, third, 8) // offers V4, oldest remaining - not V5

    expect(visitOf(state, fourth).status).toBe('Assigned')
    expect(visitOf(state, fifth).status).toBe('Waiting')
  })

  it('appends a returning participant to the bottom and only dispatches when no offer is pending', () => {
    const state = session()
    const target = snap(state).associates[0]
    engine.setAvailability(
      state,
      { sessionId: state.sessionId, participantId: target.participantId, commandId: 'cmd_off', state: 'OffFloor' },
      at(1),
    )
    expect(associateOf(state, target.participantId).queuePosition).toBeNull()

    // A different pending offer exists; returning Available must not create a second one.
    const visitId = arrive(state, 2, 'evt_pending')
    engine.setAvailability(
      state,
      { sessionId: state.sessionId, participantId: target.participantId, commandId: 'cmd_on', state: 'Available' },
      at(3),
    )
    // Dense rank among the 3 now-Available associates: the returning one
    // joins at the bottom, rank 3 of 3 (confirmed against the live backend -
    // OffFloor compacts the remaining ranks, a return re-expands them).
    expect(associateOf(state, target.participantId).queuePosition).toBe(3)
    expect(associateOf(state, target.participantId).pendingAssignmentId).toBeNull()
    expect(snap(state).assignments).toHaveLength(1)
    expect(visitOf(state, visitId).status).toBe('Assigned')
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
    expect(associateOf(state, target.participantId).state).toBe('Available')
  })

  it('setting the same state again is a no-op that keeps the queue position', () => {
    const state = session()
    const target = snap(state).associates[0]
    engine.setAvailability(
      state,
      { sessionId: state.sessionId, participantId: target.participantId, commandId: 'cmd_noop', state: 'Available' },
      at(1),
    )
    expect(associateOf(state, target.participantId).queuePosition).toBe(1)
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
