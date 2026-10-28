/**
 * Story-level checks on the mock engine. These verify the transitions the
 * stories describe under the corrected rotation rule - each associate may
 * hold at most one unconfirmed offer of their own, the queue moves at offer
 * time not accept time, and there is no session-wide gate: US-01 initial
 * order, US-02 registration and idempotency, US-03 accept/outcome, US-04
 * departure, US-05 per-associate offer exclusivity and availability, US-06
 * reset and stale sessions.
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
  it('offers the first visitor to the front-of-queue associate and moves them to the back immediately', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const board = snap(state)

    expect(visitOf(state, visitId).status).toBe('Assigned')
    // The queue moves at offer time, not at Accept: the offered associate
    // is reserved and immediately pushed to the back (rank 3 of 3), on the
    // optimistic assumption they will confirm.
    expect(board.associates[0].state).toBe('Available')
    expect(board.associates[0].queuePosition).toBe(3)
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
  it('accepting does not move the queue again - it already moved when offered', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const first = snap(state).associates[0].participantId
    const rankAfterOffer = associateOf(state, first).queuePosition
    accept(state, visitId, 4)
    const board = snap(state)

    expect(visitOf(state, visitId).status).toBe('Accepted')
    expect(board.assignments[0].acceptedAt).toBe(at(4))
    const accepted = associateOf(state, first)
    expect(accepted.state).toBe('Available')
    expect(accepted.pendingAssignmentId).toBeNull()
    expect(accepted.activeTurns).toBe(1)
    expect(accepted.acceptedTurns).toBe(1)
    expect(accepted.queuePosition).toBe(rankAfterOffer)
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

describe('US-03 rejecting an offer', () => {
  it('closes the rejected assignment with reason Rejected and does not move the rejecting associate\'s queue', () => {
    const state = session()
    const visitId = arrive(state, 2)
    const participantId = snap(state).associates[0].participantId
    const assignmentId = assignmentIdOf(state, visitId)

    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId }, at(4))

    const assignment = snap(state).assignments.find((a) => a.assignmentId === assignmentId)
    expect(assignment?.completionReason).toBe('Rejected')
    expect(assignment?.acceptedAt).toBeNull()
    // Rejecting itself does not move this associate - the immediate re-offer
    // to a *different* associate afterward is what reshuffles the dense
    // rank around it; that is covered by the dedicated queue-rank tests.
    expect(associateOf(state, participantId).pendingAssignmentId).toBeNull()

    // The other two associates were never touched and rank ahead of the
    // one who just rejected, so the visit is immediately re-offered to one
    // of them instead - never the stale closed assignment leaking through.
    const visit = visitOf(state, visitId)
    expect(visit.status).toBe('Assigned')
    expect(visit.assignmentId).not.toBe(assignmentId)
    const newAssignment = snap(state).assignments.find((a) => a.assignmentId === visit.assignmentId)
    expect(newAssignment?.participantId).not.toBe(participantId)
  })

  it('immediately re-offers the rejected visit to a different eligible associate', () => {
    const state = session()
    const v1 = arrive(state, 1, 'evt_1') // -> A
    const assignmentId = assignmentIdOf(state, v1)
    const a = snap(state).assignments[0].participantId

    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId }, at(2))

    const visit = visitOf(state, v1)
    expect(visit.status).toBe('Assigned')
    expect(visit.assignmentId).not.toBeNull()
    const newAssignment = snap(state).assignments.find((asg) => asg.assignmentId === visit.assignmentId)
    expect(newAssignment?.participantId).not.toBe(a) // offered to B, not back to A
  })

  it('counts a rejected offer toward assignedTurns but never acceptedTurns', () => {
    const state = session()
    const v1 = arrive(state, 1, 'evt_1')
    const assignmentId = assignmentIdOf(state, v1)
    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId }, at(2))

    // The reject triggered a re-offer (assignedTurns 2: the rejected one
    // plus the new one), and nothing has been accepted.
    expect(snap(state).metrics.assignedTurns).toBe(2)
    expect(snap(state).metrics.acceptedTurns).toBe(0)
  })

  it('rejects an already-accepted assignment and is a no-op replay on an already-closed one', () => {
    const state = session()
    const v1 = arrive(state, 1, 'evt_1')
    const assignmentId = assignmentIdOf(state, v1)
    accept(state, v1, 2)

    expect(() =>
      engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId }, at(3)),
    ).toThrow(BoardError)

    const v2 = arrive(state, 4, 'evt_2')
    const secondAssignmentId = assignmentIdOf(state, v2)
    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId: secondAssignmentId }, at(5))
    const closedAt = snap(state).assignments.find((a) => a.assignmentId === secondAssignmentId)?.completedAt
    // Replaying the same reject is a no-op, not a second effect.
    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId: secondAssignmentId }, at(6))
    expect(snap(state).assignments.find((a) => a.assignmentId === secondAssignmentId)?.completedAt).toBe(closedAt)
  })

  it('stays Waiting - never back to the same associate - when nobody else is eligible either', () => {
    // Confirmed with the user: looping the same offer back to the associate
    // who just rejected it is not acceptable UX. When they are the only
    // technically-eligible one, the visit is treated exactly as if it had
    // just arrived while everyone was busy - it waits for someone else.
    const state = session()
    const v1 = arrive(state, 1, 'evt_1') // -> A
    const v2 = arrive(state, 2, 'evt_2') // -> B
    const v3 = arrive(state, 3, 'evt_3') // -> C
    const assignmentId = assignmentIdOf(state, v1)

    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId }, at(4))

    const visit = visitOf(state, v1)
    expect(visit.status).toBe('Waiting')
    expect(visit.assignmentId).toBeNull() // never leaks the rejected assignment
    expect(visit.waitingPosition).toBe(1)
    // B and C are completely unaffected by A's rejection.
    expect(visitOf(state, v2).status).toBe('Assigned')
    expect(visitOf(state, v3).status).toBe('Assigned')
  })

  it('contract v5: an unrelated later event never bounces the visit back to its own last rejecter', () => {
    // This supersedes an earlier (wrong) assumption that a one-shot
    // exclusion was enough: it is not - the very next unrelated dispatch
    // could still have hit this same associate. The exclusion must be a
    // property of the visit itself, checked by every dispatch the same way.
    const state = session()
    const v1 = arrive(state, 1, 'evt_1') // -> A
    const v2 = arrive(state, 2, 'evt_2') // -> B
    arrive(state, 3, 'evt_3') // -> C
    const a = snap(state).assignments[0].participantId
    const assignmentId = assignmentIdOf(state, v1)

    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId }, at(4))
    expect(visitOf(state, v1).status).toBe('Waiting')

    // B's own, unrelated acceptance frees B for new work ("Second UP") -
    // a completely separate dispatch trigger from A's earlier reject.
    accept(state, v2, 5)

    // v1 goes to B, never back to A - A is excluded for *this visit*
    // specifically, no matter what later event triggers the dispatch.
    const visit = visitOf(state, v1)
    expect(visit.status).toBe('Assigned')
    const newAssignment = snap(state).assignments.find((asg) => asg.assignmentId === visit.assignmentId)
    expect(newAssignment?.participantId).not.toBe(a)
  })

  it('a newer arrival with no rejection history can be served while the rejected visit keeps waiting for someone else', () => {
    // The exclusion is scoped to the rejected visit, not global: A remains
    // a completely normal candidate for every *other* visitor right away.
    const state = session()
    const v1 = arrive(state, 1, 'evt_1') // -> A
    arrive(state, 2, 'evt_2') // -> B
    arrive(state, 3, 'evt_3') // -> C
    const a = snap(state).assignments[0].participantId
    const assignmentId = assignmentIdOf(state, v1)

    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId }, at(4))
    expect(visitOf(state, v1).status).toBe('Waiting')

    // B and C are still mid-offer; A is free again but excluded for v1
    // specifically - so a brand new arrival (no history with A) goes to A,
    // while v1 keeps waiting for B or C to resolve instead.
    const v4 = arrive(state, 5, 'evt_4')

    expect(visitOf(state, v4).status).toBe('Assigned')
    const v4Assignment = snap(state).assignments.find((asg) => asg.visitId === v4)
    expect(v4Assignment?.participantId).toBe(a)
    expect(visitOf(state, v1).status).toBe('Waiting')
    // A took v4, so every associate now holds a pending offer again - from
    // v1's perspective that is indistinguishable from the ordinary
    // everyone's-busy case, not "only my rejecter is in the way".
    expect(visitOf(state, v1).waitingReason).toBe('AwaitingConfirmation')
  })

  it('settles every offer a single reject makes possible, not just one - confirmed live against the backend', () => {
    // A single mutation can free one associate directly, but under the
    // per-visit exclusion rule that alone can also reveal a *second*,
    // independently-idle-but-excluded associate as newly eligible for a
    // different Waiting visit - so one dispatch call per command is not
    // enough; settleDispatch must loop. This exact cascade (one reject
    // producing two new offers) was observed against the live backend
    // (contract v5, 20261028000300_skip_last_rejecter.sql) before being
    // reproduced here.
    const state = session()
    arrive(state, 1, 'evt_1') // -> A
    const v2 = arrive(state, 2, 'evt_2') // -> B
    const v3 = arrive(state, 3, 'evt_3') // -> C
    const v4 = arrive(state, 4, 'evt_4') // Waiting: everyone already offered

    // B rejects V2: only B is free, so V4 (the only visit not excluding B)
    // is the one offer this produces.
    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId: assignmentIdOf(state, v2) }, at(5))
    expect(visitOf(state, v4).status).toBe('Assigned')
    const bId = snap(state).assignments.find((asg) => asg.visitId === v4)?.participantId
    expect(visitOf(state, v2).status).toBe('Waiting') // V2 excludes B itself; nobody else is free

    // B (now holding V4) rejects it too: B is free again but excluded from
    // both V2 and V4, so neither can be offered to B - no dispatch happens.
    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId: assignmentIdOf(state, v4) }, at(6))
    expect(visitOf(state, v2).status).toBe('Waiting')
    expect(visitOf(state, v4).status).toBe('Waiting')

    // C rejects V3: this frees C directly, who takes the older Waiting
    // visit (V2). But that single reject *also* leaves B newly eligible
    // for V3 (B was already idle, just excluded from V2 and V4, not V3) -
    // a second offer the same settle pass must also make.
    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId: assignmentIdOf(state, v3) }, at(7))
    expect(visitOf(state, v2).status).toBe('Assigned')
    const cId = snap(state).assignments.find((asg) => asg.assignmentId === visitOf(state, v2).assignmentId)?.participantId
    expect(cId).not.toBe(bId)
    expect(visitOf(state, v3).status).toBe('Assigned')
    expect(snap(state).assignments.find((asg) => asg.assignmentId === visitOf(state, v3).assignmentId)?.participantId).toBe(bId)

    // V4 is left exactly where the live sweep found it: Waiting, but now
    // for the ordinary reason - every associate is busy again.
    expect(visitOf(state, v4).status).toBe('Waiting')
    expect(visitOf(state, v4).waitingReason).toBe('AwaitingConfirmation')
  })

  it('the exclusion moves to whoever rejects next, freeing the first rejecter for this same visit', () => {
    // Backend contract v5 example: after A rejects V1 and it is later
    // re-offered to and rejected by B, A must be eligible for V1 again -
    // the exclusion names only the most recent rejecter, not everyone who
    // has ever rejected it. C is taken off the floor and there is only
    // ever one visit, so the only two candidates (A, B) trade this single
    // offer back and forth with nothing else for either of them to do.
    const state = session()
    const cId = snap(state).associates[2].participantId
    engine.setAvailability(state, { sessionId: state.sessionId, participantId: cId, commandId: 'cmd_off', state: 'OffFloor' }, at(1))
    const v1 = arrive(state, 2, 'evt_1') // -> A (B is idle, off-floor C is not a candidate)
    const aId = snap(state).assignments[0].participantId

    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId: assignmentIdOf(state, v1) }, at(3))
    const afterFirstReject = visitOf(state, v1)
    expect(afterFirstReject.status).toBe('Assigned') // B was idle and not excluded, so it goes straight to B
    const bId = snap(state).assignments.find((asg) => asg.assignmentId === afterFirstReject.assignmentId)?.participantId
    expect(bId).not.toBe(aId)

    // B now rejects this same visit - the exclusion moves to B, and A
    // (excluded no more, and still idle) becomes eligible for it again.
    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId: assignmentIdOf(state, v1) }, at(4))
    const visit = visitOf(state, v1)
    expect(visit.status).toBe('Assigned')
    const newAssignment = snap(state).assignments.find((asg) => asg.assignmentId === visit.assignmentId)
    expect(newAssignment?.participantId).toBe(aId)
  })
  it('keeps the full history across repeated rejects; assignmentId always points at the live one', () => {
    // Confirmed against the backend's own implementation: a visit may carry
    // any number of Rejected assignments plus at most one other - the DTO
    // must always resolve to the live (non-rejected) one, never a past one.
    const state = session()
    const visitId = arrive(state, 1)

    const a1 = assignmentIdOf(state, visitId)
    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId: a1 }, at(2))

    const a2 = assignmentIdOf(state, visitId)
    expect(a2).not.toBe(a1)
    engine.rejectAssignment(state, { sessionId: state.sessionId, assignmentId: a2 }, at(3))

    const a3 = assignmentIdOf(state, visitId)
    expect(a3).not.toBe(a1)
    expect(a3).not.toBe(a2)

    const board = snap(state)
    const visit = board.visits.find((v) => v.visitId === visitId)!
    expect(visit.assignmentId).toBe(a3)
    expect(visit.status).toBe('Assigned')

    const own = board.assignments.filter((a) => a.visitId === visitId)
    expect(own).toHaveLength(3)
    expect(own.filter((a) => a.completionReason === 'Rejected')).toHaveLength(2)
    expect(own.find((a) => a.assignmentId === a3)?.phase).toBe('PendingAcceptance')
    expect(board.metrics.assignedTurns).toBe(3)
    expect(board.metrics.acceptedTurns).toBe(0)
  })
})

describe('US-05 rotation: at most one unresolved offer per associate', () => {
  it('offers three simultaneous arrivals to three different associates - no session-wide gate', () => {
    const state = session()
    const [a, b, c] = snap(state).associates.map((p) => p.participantId)

    const v1 = arrive(state, 1, 'evt_1')
    const v2 = arrive(state, 2, 'evt_2')
    const v3 = arrive(state, 3, 'evt_3')

    // Each gets its own associate, in queue order - none is left Waiting
    // behind someone else's unconfirmed offer.
    expect(visitOf(state, v1).status).toBe('Assigned')
    expect(visitOf(state, v2).status).toBe('Assigned')
    expect(visitOf(state, v3).status).toBe('Assigned')

    const assignmentFor = (visitId: string) => snap(state).assignments.find((asg) => asg.visitId === visitId)
    expect(assignmentFor(v1)?.participantId).toBe(a)
    expect(assignmentFor(v2)?.participantId).toBe(b)
    expect(assignmentFor(v3)?.participantId).toBe(c)
    expect(snap(state).associates.every((p) => p.state === 'Available')).toBe(true)
    expect(snap(state).associates.every((p) => p.pendingAssignmentId !== null)).toBe(true)

    // Now every associate already holds their own unconfirmed offer: a
    // fourth arrival has nobody eligible and must wait.
    const v4 = arrive(state, 4, 'evt_4')
    expect(visitOf(state, v4).status).toBe('Waiting')
    expect(hasPendingOffer(snap(state))).toBe(true)

    // Accepting clears that one offer, making its associate eligible again
    // for the queued visitor - this is the "Second UP" case.
    accept(state, v1, 5)
    expect(visitOf(state, v4).status).toBe('Assigned')
    const v4Assignment = snap(state).assignments.find((asg) => asg.visitId === v4)
    expect(v4Assignment?.participantId).toBe(a)
    expect(associateOf(state, a).activeTurns).toBe(1) // v1, accepted-unfinished
    expect(associateOf(state, a).pendingAssignmentId).toBe(v4Assignment?.assignmentId)

    // No sale was ever completed in this whole sequence.
    expect(snap(state).metrics.closedSales).toBe(0)
  })

  it('offers a new arrival to a different, not-yet-offered associate while one offer is unresolved elsewhere', () => {
    const state = session()
    const v1 = arrive(state, 1, 'evt_1')
    const v2 = arrive(state, 2, 'evt_2')

    expect(visitOf(state, v1).status).toBe('Assigned')
    expect(visitOf(state, v2).status).toBe('Assigned')
    const assignmentFor = (visitId: string) => snap(state).assignments.find((asg) => asg.visitId === visitId)
    expect(assignmentFor(v1)?.participantId).not.toBe(assignmentFor(v2)?.participantId)
  })

  it('an associate with accepted-unfinished work can still take on new offers ("Second UP")', () => {
    const state = session()
    const v1 = arrive(state, 1, 'evt_1') // -> A
    arrive(state, 2, 'evt_2') // -> B
    arrive(state, 3, 'evt_3') // -> C
    const a = snap(state).assignments.find((asg) => asg.visitId === v1)!.participantId

    accept(state, v1, 4) // A is now accepted-unfinished, not pending
    expect(associateOf(state, a).activeTurns).toBe(1)
    expect(associateOf(state, a).pendingAssignmentId).toBeNull()

    // A is the only eligible associate now (B, C each still hold their own
    // pending offer), so a new arrival goes to A despite the unfinished work.
    const v4 = arrive(state, 5, 'evt_4')
    expect(visitOf(state, v4).status).toBe('Assigned')
    const v4Assignment = snap(state).assignments.find((asg) => asg.visitId === v4)
    expect(v4Assignment?.participantId).toBe(a)
    expect(associateOf(state, a).activeTurns).toBe(1) // unchanged
  })
})

describe('US-04 registering a departure', () => {
  it('lets a Waiting visitor (every associate already offered) leave with a result and zero assignments', () => {
    const state = session()
    arrive(state, 1, 'evt_1') // -> A
    arrive(state, 2, 'evt_2') // -> B
    arrive(state, 3, 'evt_3') // -> C
    const waiting = arrive(state, 4, 'evt_4') // everyone already has a pending offer

    expect(visitOf(state, waiting).status).toBe('Waiting')
    expect(visitOf(state, waiting).assignmentId).toBeNull()
    expect(visitOf(state, waiting).waitingPosition).toBe(1)

    engine.markDeparture(state, { sessionId: state.sessionId, visitId: waiting, outcome: 'NoSale' }, at(6))

    const visit = visitOf(state, waiting)
    expect(visit.departedAt).toBe(at(6))
    expect(visit.status).toBe('Completed')
    expect(visit.outcome).toBe('NoSale')
    expect(visit.assignmentId).toBeNull()
    expect(snap(state).metrics.assignedTurns).toBe(3)
  })

  it('requires an explicit result when none is recorded yet', () => {
    const state = session()
    const visitId = arrive(state, 2)
    expect(() =>
      engine.markDeparture(state, { sessionId: state.sessionId, visitId, outcome: null }, at(5)),
    ).toThrow(BoardError)
  })

  it('departing a pending offer frees that associate and offers the oldest Waiting visit next', () => {
    const state = session()
    const v1 = arrive(state, 1, 'evt_1') // -> A
    arrive(state, 2, 'evt_2') // -> B
    arrive(state, 3, 'evt_3') // -> C
    const next = arrive(state, 4, 'evt_4') // Waiting: everyone already has a pending offer

    const participantId = snap(state).assignments.find((asg) => asg.visitId === v1)!.participantId
    const assignmentId = assignmentIdOf(state, v1)

    engine.markDeparture(state, { sessionId: state.sessionId, visitId: v1, outcome: 'NoSale' }, at(5))

    const assignment = snap(state).assignments.find((a) => a.assignmentId === assignmentId)
    expect(assignment?.completionReason).toBe('Departure')
    expect(assignment?.acceptedAt).toBeNull()
    // The queue already moved when this offer was made, so departure moves
    // nothing further - but clearing it does make the associate eligible
    // again, and the only Waiting visit goes to them.
    expect(visitOf(state, next).status).toBe('Assigned')
    const nextAssignment = snap(state).assignments.find((a) => a.visitId === next)
    expect(nextAssignment?.participantId).toBe(participantId)
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

  it('assigns waiting visits in registration order as associates become eligible again', () => {
    const state = session()
    const ids = [1, 2, 3, 4, 5].map((minute) => arrive(state, minute, `evt_${minute}`))
    const [first, second, , fourth, fifth] = ids
    // All three associates already hold their own offer after the first
    // three arrivals, so the 4th and 5th wait.
    expect(visitOf(state, fourth).status).toBe('Waiting')
    expect(visitOf(state, fifth).status).toBe('Waiting')

    accept(state, first, 6) // frees that associate -> offers V4 (oldest Waiting)
    expect(visitOf(state, fourth).status).toBe('Assigned')
    expect(visitOf(state, fifth).status).toBe('Waiting')

    accept(state, second, 7) // frees the next -> offers V5
    expect(visitOf(state, fifth).status).toBe('Assigned')
  })

  it('a returning associate joins at the bottom and can immediately take a Waiting visit', () => {
    const state = session()
    const target = snap(state).associates[0]
    engine.setAvailability(
      state,
      { sessionId: state.sessionId, participantId: target.participantId, commandId: 'cmd_off', state: 'OffFloor' },
      at(1),
    )
    expect(associateOf(state, target.participantId).queuePosition).toBeNull()

    // The remaining two each pick up their own offer, leaving nobody eligible.
    arrive(state, 2, 'evt_b')
    arrive(state, 3, 'evt_c')
    const visitId = arrive(state, 4, 'evt_waiting')
    expect(visitOf(state, visitId).status).toBe('Waiting')

    engine.setAvailability(
      state,
      { sessionId: state.sessionId, participantId: target.participantId, commandId: 'cmd_on', state: 'Available' },
      at(5),
    )

    // Dense rank among the 3 now-Available associates: the returning one
    // joins at the bottom, rank 3 of 3, and is the only eligible associate.
    expect(visitOf(state, visitId).status).toBe('Assigned')
    const assignment = snap(state).assignments.find((a) => a.visitId === visitId)
    expect(assignment?.participantId).toBe(target.participantId)
    expect(associateOf(state, target.participantId).pendingAssignmentId).toBe(assignment?.assignmentId)
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
