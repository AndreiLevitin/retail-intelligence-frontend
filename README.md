# Digital UP Board — frontend prototype

Stage 1 operational dashboard for a retail receptionist. One responsive page
that shows the current demo session, registers visitors manually, drives UP
assignment/acceptance, records purchase outcomes and departures, manages
associate availability and resets the demonstration.

Scope is stories **US-01 … US-06** of [Prototype Backlog](../Prototype%20Backlog.md),
built to [Frontend and UI Requirements](../Frontend%20and%20UI%20Requirements.md)
and [UI Design System](../UI%20Design%20System.md). No CV, image, upload or camera
feature exists here, and none is stubbed as a disabled panel.

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173, starts in mock mode
```

| Script | Purpose |
|---|---|
| `npm run dev` | Dev server with HMR. Defaults to `MockBoardClient`. |
| `npm run build` | Type-check (`tsc -b`) then production bundle. |
| `npm run preview` | Serve the production bundle locally. |
| `npm test` | Vitest: board transition rules plus an app render smoke check. |
| `npm run lint` | Oxlint. |

### Environment

Copy `.env.example` to `.env.local`. Nothing secret belongs in it.

| Variable | Values | Effect |
|---|---|---|
| `VITE_BOARD_CLIENT` | `mock` \| `http` | Which adapter starts. Unset = `mock` in dev, `http` in a build. |
| `VITE_API_BASE_URL` | absolute origin, e.g. `http://localhost:3000` | Where `HttpBoardClient` sends requests. Frontend and backend are two independent deployments; this is the supported way to point at the backend - not a same-origin assumption. |
| `VITE_API_PROXY_TARGET` | URL | Dev-only convenience: where the Vite dev server forwards relative `/api/...` paths if `VITE_API_BASE_URL` is left unset. Not used in a production build. |

There is no Supabase URL, anon key or service role key in this project, and no
database access from the browser. In `http` mode a small connect prompt asks
once for an operator token; it is held in memory for that tab and is never
written to storage or baked into the build.

Mock mode is labelled on screen. The app chooses its adapter once at startup
and **never falls back to mock data after a real API error** — a failing HTTP
client keeps failing visibly.

## Architecture

```
src/
  lib/           DTOs, enum→label maps, formatting, idempotency keys
  services/      BoardService contract + Mock and HTTP adapters, mock engine
  hooks/         useBoard — fetching, 2s polling, mutation state
  components/
    ui/          Button FormField Select TextInput Dialog StatusBadge
                 DataTable MetricCard ConnectionIndicator Notice
    shell/       AppShell Sidebar TopBar
    dashboard/   DashboardPage + header, summary, tables, forms, dialogs
  styles/        globals.css — the single definition of the design tokens
```

Build tooling is Vite + React 19 + TypeScript, styling is Tailwind v4 with the
design-system tokens declared once in `@theme`. No second component library:
the primitives above are small and local. The folder layout matches a typical
Figma Make export (`src/components`, `src/components/ui`), so an export can be
merged later without restructuring.

### Service boundary

`src/services/boardService.ts` is the only contract the UI depends on. No
component imports a client, touches SQL, or knows whether the board is real.
Its shapes mirror `retail-intelligence-backend/src/contracts/{dto,errors}.ts`
exactly — the two repos are separate deployments, so the contract is copied
into `src/lib/types.ts` rather than imported; keep the two in sync by hand if
either side changes it.

```ts
interface BoardService {
  readonly mode: 'mock' | 'http'
  getBoard(options?: { signal?: AbortSignal }): Promise<BoardSnapshot>
  registerVisitor(command: RegisterVisitorCommand): Promise<void>
  updateAttributes(command: UpdateAttributesCommand): Promise<void>
  acceptAssignment(command: AcceptAssignmentCommand): Promise<void>
  recordOutcome(command: RecordOutcomeCommand): Promise<void>
  markDeparture(command: MarkDepartureCommand): Promise<void>
  setAvailability(command: SetAvailabilityCommand): Promise<void>
  resetDemo(command: ResetDemoCommand): Promise<void>
}
```

`BoardSnapshot` (see `src/lib/types.ts`) carries `session`, `associates`,
`visits`, `assignments`, `metrics`, newest-first `activity` and `serverTime`.
A visit only carries an `assignmentId`; `src/lib/selectors.ts` joins it against
`assignments`/`associates` once, so no row component does that lookup itself.
Mutations return nothing: `useBoard` refetches instead of rotating the queue
or incrementing a counter locally.

Only two commands carry a client idempotency key, matching the backend:
`eventId` on arrival (register) and `commandId` on an availability change. The
other commands — accept, outcome, departure, attributes — have none; the
backend's own current-state check makes a blind retry of those safe and
reports it back as `replayed`/`duplicate`, so a retry just resends the same
body.

### Rotation model: advance on acceptance

Per the **corrected** [Assignment Rotation Revision](../Assignment%20Rotation%20Revision.md)
(a breaking change over the original "exclusive until outcome" model). The
revision's first version generalized its own rule into a single
store-wide pending-offer gate; the user corrected this directly against the
real process the same day, and the document, this frontend and the
backend all needed a second pass. The rule that actually held:

* An associate's own availability is only `Available`/`OffFloor`
  (`AssociateView.state`). Accepted, unfinished work never makes an
  associate ineligible — `activeTurns`/`activeAssignmentIds` track that
  separately, and any number of accepted-unfinished turns per associate is
  valid ("Second UP" and beyond).
* Each associate may hold at most **one** unresolved offer of their own at
  a time (`AssociateView.pendingAssignmentId`) — **not a session-wide
  limit**. Different associates can each hold their own pending offer
  simultaneously; a new arrival goes to whichever eligible associate
  (Available, no pending offer of their own) is next in queue order, not
  to a single bottleneck.
* The queue position moves at **offer** time, not at Accept time: creating
  an offer immediately reserves that associate and moves them to the back
  of the queue, on the optimistic assumption they will confirm — this is
  exactly what lets the next arrival go to a *different* associate instead
  of queuing up behind an unconfirmed one. Accepting does not move the
  queue again; it already moved when offered. Clearing a pending offer
  (by accepting, or by the visitor departing before confirming) makes that
  one associate eligible again for a new offer. A normal outcome
  (Sale/No-Sale) never touches rotation or availability.
* Departure of a still-pending offer closes it (`completionReason:
  "Departure"`); the queue already moved when that offer was made, so
  nothing moves again and nothing is "returned" — it just frees that one
  associate. Departure of an accepted or completed turn doesn't touch
  rotation either.
* Off Floor is rejected only while that associate owns their **own**
  unresolved pending offer (`canMarkOffFloor` in `src/lib/types.ts`) — a
  per-associate check, never because of accepted-unfinished work and never
  because of a *different* associate's offer.
* A Waiting visit's "no assignment" reason is exactly one of two things,
  computed in `DashboardPage.explainWaiting`: *No available associates*
  (nobody is Available) or *Every available associate already has an
  offer pending confirmation* (each one is individually, simultaneously
  mid-offer). "All associates busy" is never shown — accepted-unfinished
  work is not a reason, and there is no single global bottleneck to name.

`mockEngine.test.ts` includes the backlog's required A → B → C → A
regression: with four simultaneous arrivals, the first three are offered
to A, B and C **in parallel** (not queued behind each other), and the
fourth cycles back to whichever of them accepts first — all without ever
completing a sale.

### Reject UP

If Accept exists, Reject must too — the real store process confirms
associates can decline a UP (BR-06), and the frontend was missing it until
the user flagged it. Reject sits next to Accept UP in the Visitors table
wherever a visit is `Assigned` and not yet accepted (`canRejectUp` has the
identical precondition to `canAcceptUp`).

* Closes the assignment with `completionReason: "Rejected"` — the same
  shape as a pending-offer departure (no `acceptedAt`), except the Visit
  returns to **`Waiting`** instead of `Completed`: the visitor is still
  here and still needs service. Its original `arrivedAt` and registration
  order are untouched, so it keeps FIFO priority over any newer arrival
  that was already Waiting.
* Rejecting never moves the rejecting associate's queue itself — that
  already happened at offer time, same as Accept — but it does clear
  their `pendingAssignmentId`, making them eligible again. **Correction,
  same day:** the one dispatch this triggers excludes the rejecting
  associate for that single attempt. If someone *else* is eligible, the
  visit is re-offered to them right away; if the rejecter was the only
  technically-eligible one, the visit stays `Waiting` — treated exactly as
  if it had arrived at a moment when everyone was busy, never looped
  straight back to the person who just declined it. This was flagged by
  the user as bad UX after the first version shipped (which, like a
  pending-offer departure, *did* hand it right back) and is now a
  one-shot exclusion in `tryCreateOffer`'s `excludeParticipantId`, not a
  lasting block — any later, separately-triggered dispatch (a new
  arrival, someone else's accept/reject/departure, an availability
  change) considers that associate normally again.
* `VisitView.assignmentId` is `null` whenever `status` is `Waiting`. This
  was always true before Reject existed (a Waiting visit never had any
  assignment history), but Reject introduces the first path *back* to
  Waiting from `Assigned`, so a visit can now carry closed/rejected
  history while Waiting — `toVisitView` special-cases this so a stale
  assignment id never makes a Waiting row look assigned.
* Rejecting an already-accepted assignment is rejected itself
  (409 `INVALID_TRANSITION`); rejecting an already-closed one is a replay
  no-op. A rejected offer counts toward `assignedTurns` (it was a created
  offer) but never `acceptedTurns`.

### Separate state, never inferred

Visit status, physical presence and purchase outcome are three independent
fields:

* `status` — Waiting / Assigned / Accepted / Completed
* presence — derived only from `departedAt`: Inside / Left
* `outcome` — Sale / No-Sale / **Not recorded** when `null`

`Completed + Inside` is valid; a departed visitor can hold an outcome with no
associate and no turn; `null` is displayed as *Not recorded* and never as a
No-Sale. Appearance joins only the known non-empty parts and falls back to
*Description not provided*; `Unknown` demographics stay `Unknown`.

### Polling and failure behaviour

`useBoard` polls `GET /api/board` every 2 s with one request in flight, skips
a tick while a read is outstanding, and discards any snapshot that started
before a newer mutation or reset (tracked by a local generation counter, since
the DTO itself carries no revision number). On a read failure the last known
board stays visible with an offline indicator and the poll keeps retrying; the
indicator returns to Connected on the next success. Only the affected control
is disabled while its command is pending, and a reset blocks every mutation
until the new board has loaded.

## Mock scenarios

`MockBoardClient` wraps `mockEngine.ts`, which implements the same
per-associate-offer transitions the backend owns — FIFO registration, the
queue moving at offer time rather than accept time, each associate's own
one-pending-offer limit (not a session-wide gate), Reject re-offering
immediately, idempotent commands, rejected conflicts. Mock behaviour exists
only there, not spread through components.

Roster: Avery Collins, Jordan Reyes, Morgan Patel — Available in that order.

Switch scenarios from the mock-mode panel at the top of the dashboard:

| Scenario | What it shows |
|---|---|
| Empty run | Seeded session, no visits, zero counts and 0% conversion |
| Pending turn | Visit Assigned, the offer is Pending Acceptance, Accept UP and Reject both offered |
| Rejected, re-offered | The first associate rejected; the visit was immediately re-offered to the next eligible associate instead of sitting idle |
| Accepted turn | Visit Accepted; the associate stays Available and keeps its new queue position - accepting never makes it ineligible |
| Completed but Inside | Sale recorded, turn Completed, presence still Inside, rotation unaffected |
| Awaiting confirmation | Each associate may hold at most one unconfirmed offer; the first three visitors take all three **in parallel**, and a fourth has nobody eligible and waits |
| Departed without assignment | A Waiting visitor (every associate already holding their own offer) left with No-Sale and zero assignments |
| Departed after completion | Exit after a Sale: result preserved read-only, rotation untouched |
| Temporary API failure | First two reads fail, then the board recovers |

**Fail the next read** forces a single read failure at any time, to see the
offline state and recovery. **Reset Demo** works in every scenario.

## Story coverage

| Story | Where it lives |
|---|---|
| US-01 Open the board | Seeded session, deterministic order, Next UP, metrics, 2 s poll, loading/empty/failure/reconnect states — `useBoard`, `DashboardPage`, `AssociatesTable` |
| US-02 Register manually | `VisitorForm` create mode, `eventId` idempotency, server-set `arrivedAt`/order, Manual + NotRequested, profile-only correction via edit mode |
| US-03 Accept, reject and complete | `Accept UP` and `Reject UP` side by side for a pending assignment only; `Sale` / `No-Sale` for an accepted unfinished turn; Reject returns the Visit to Waiting at its original order and re-dispatches excluding the rejecter (never loops back to them); Completed stays Inside |
| US-04 Register departure | `ExitDialog`: requires a missing result, preserves an existing one read-only; Waiting visitors can leave unassigned |
| US-05 Availability and waiting | `AssociatesTable` Off Floor blocked only for the pending-offer owner, bottom-of-queue return, the two-reason Waiting explanation, the one-offer gate itself |
| US-06 Reset | `ResetDialog` destructive confirmation, mutations blocked, old snapshots discarded, new board loads at zero |

`npm test` covers these transitions directly against the mock engine
plus a render smoke check of the app tree.

## Remaining API integration work

**Reject UP's dispatch fallback was corrected again after going live - the
sweep below is now stale for one specific case and needs redoing once the
backend applies the same fix.** `POST /api/assignments/{id}/reject`
(contract v4, `20261028000200_reject_up.sql`) matched this frontend's
design and was verified live, including the exact case the user then
flagged as bad UX: when the rejecting associate was the only
technically-eligible one, the dispatch handed the same visit right back to
them. The user asked for the visit to stay `Waiting` instead (treated as a
fresh arrival while everyone was busy) - see `tryCreateOffer`'s
`excludeParticipantId` and the corrected `Assignment Rotation
Revision.md` rule 11. Of the four invariants confirmed below, only #3
changed:

1. A visit can carry any number of `Rejected` assignments plus at most one
   other (pending/accepted/completed-via-outcome). `BoardSnapshot.assignments`
   lists all of them; `VisitView.assignmentId` always resolves to the live
   (non-rejected) one and is `null` while `Waiting`. **Unaffected.**
2. `assignedTurns` counts rejected offers; `acceptedTurns` does not.
   **Unaffected.**
3. ~~The rejecting associate is immediately eligible again... re-offered
   right back to the same associate~~ **superseded:** the immediate
   dispatch excludes the rejecter for that one attempt. If someone else is
   eligible, re-offer proceeds as before; if the rejecter was the only
   one, the visit now stays `Waiting` instead.
4. A departure after a rejection closes only the live assignment; rejected
   history is untouched. **Unaffected.**

**Verified live before this correction** (needs re-running case 2 below
once the backend has the matching fix): `POST .../reject` with other
associates untouched correctly re-offered to the next eligible one in
queue order (unaffected by this correction, still valid); 409
`INVALID_TRANSITION` both ways (rejecting an already-accepted assignment,
accepting an already-rejected one, both unaffected); a replay on an
already-closed assignment returned the Visit's current status
(unaffected); CORS preflight, stale-session and not-found shapes on
`/reject` (unaffected). **Case 2 - all three simultaneously holding their
own offer, then one rejects - was verified against the *old* fallback
behavior** (it came back `Assigned` to the same associate) and must be
re-verified to confirm it now stays `Waiting` instead, once the backend
ships the matching change.

Demo reset to clean afterward; `.env.local` stayed on `http` throughout
(nothing to revert - `/reject` just stopped 404ing once the backend
deployed it).

**Verified end-to-end against the per-associate rotation fix (contract
v3)**, locally, after the backend's second migration pass
(`20261028000100_per_associate_offers.sql`):

* Three simultaneous arrivals went to three different associates in
  parallel (confirmed on data the live migration had itself converted:
  Alex/Jamie/Morgan each held their own `PendingAcceptance` offer
  simultaneously, all three `Available`).
* A fourth arrival stayed `Waiting` until one offer was accepted; accepting
  Alex's immediately re-offered the Waiting visitor to Alex (the "Second
  UP" case), with the new assignment's id matching exactly.
* `queuePosition` moves at **offer** time, not accept time - proved both
  ways: Alex's rank changed as part of the *same* accept call only because
  a new offer followed; a second accept (Jamie's, with no Waiting visitor
  left to offer) left every associate's `queuePosition` completely
  unchanged.
* Off Floor 409s `INVALID_TRANSITION` precisely for whichever associate
  currently holds *their own* pending offer (checked for two different
  associates in turn, including Alex immediately after his re-offer) and
  would succeed for one with only accepted-unfinished work.
* CORS preflight + an allowed-origin GET for `http://localhost:5181`, and
  401/404/405 error shapes, are unchanged from the contract-v2 sweep.

The demo was reset to a clean run afterward and `.env.local` is back to
`VITE_BOARD_CLIENT=http`. What is still open before a real deployment:

1. **`VITE_API_BASE_URL` / CORS allowlist for the actual deployed origins**,
   not just `localhost:5173/5181`. The backend's `CORS_ALLOWED_ORIGINS` needs
   every real frontend origin added.
2. **Confirm auth for the deployed environment.** The operator token is sent
   as `Authorization: Bearer <token>`; confirm the real header name and
   whether a token is required at all outside local dev.
3. **Re-run the full story checks against the real path** end to end —
   normal flow, Waiting/Off Floor, retries and concurrency, all departure
   states, a sale without an assignment, and reset with stale writes — once
   deployed, the same scenarios `npm test` already covers against the mock
   engine.
4. **Watch for further contract drift** (backend is on
   `src/contracts/dto.ts`'s `CONTRACT_VERSION = 3`; bump this note if that
   changes again). If it does, update `src/lib/types.ts`,
   `src/lib/labels.ts`, `src/lib/selectors.ts`, `mockEngine.ts` and
   `httpBoardClient.ts` together; they currently agree field-for-field,
   including:
   * routes — `POST /api/arrivals`, `PATCH /api/visits/{id}/attributes`,
     `POST /api/assignments/{id}/accept`, `POST /api/assignments/{id}/outcome`
     (keyed by **assignment**, not visit), `POST /api/visits/{id}/departure`,
     `POST /api/availability` (participantId travels in the body, not the URL),
     `POST /api/demo/reset`
   * enum values — age group includes `Age60Plus` (not `Over60`); enrichment
     status is `Complete` (not `Completed`); `attributesSource` also allows
     `Unknown`
   * `BoardSnapshot` has `associates` and a sibling `assignments` array, no
     `participants` key and no `revision`; a `VisitView` carries `status`,
     `attributes`, `accessoryDescription: string | null`, `outcome`,
     `outcomeRecordedAt`, `waitingPosition` and a flat `assignmentId` — order
     is the array position, there is no `registrationOrder` field
   * `metrics.conversionRate` is already a percentage (0..100), not a 0..1
     fraction
   * `AssociateView.state` is `Available | OffFloor` only; `pendingAssignmentId`
     (nullable), `activeAssignmentIds` (array) and `activeTurns` replace the
     old singular `currentAssignmentId`
   * **`queuePosition` is a dense 1-based rank among currently-Available
     associates, recomputed on every read - not a raw stored ordering
     token.** Confirmed directly against the live backend (marking an
     associate Off Floor compacts the remaining ranks; returning re-expands
     them at the bottom). `mockEngine.ts` got this wrong on the first pass
     (it exposed an ever-growing counter) until this was caught by this very
     verification sweep - see `queueRanks()` and the dedicated test "`queuePosition`
     is a dense 1..N rank..." in `mockEngine.test.ts`.
   * error bodies are `{code, message}`, including `ORIGIN_NOT_ALLOWED` (403,
     disallowed browser `Origin`); `BoardError.fromApi` maps every code in
     `Backend Requirements.md` §6

## Deliberately not built

Sidebar entries Analytics / Company / Support, the top-bar search and the
user placeholder are visibly unavailable and have no destination. There are no
charts, no video or image panels, no upload control, no CV start button or
camera settings, no roster CRUD, no store or shift administration, no visitor
deletion, no account or settings screens, and no history or archive view.
