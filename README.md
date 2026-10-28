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
| `VITE_API_PROXY_TARGET` | URL | Dev-only: where the Vite dev server forwards `/api`. Deployments use same-origin `/api`. |

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

`MockBoardClient` wraps `mockEngine.ts`, which implements the same transitions
the backend owns — FIFO registration, one unfinished assignment per
participant, release to the bottom of rotation, waiting dispatch when capacity
returns, idempotent commands, rejected conflicts. Mock behaviour exists only
there, not spread through components.

Roster: Avery Collins, Jordan Reyes, Morgan Patel — Available in that order.

Switch scenarios from the mock-mode panel at the top of the dashboard:

| Scenario | What it shows |
|---|---|
| Empty run | Seeded session, no visits, zero counts and 0% conversion |
| Pending turn | Visit Assigned, associate Pending Acceptance, Accept UP offered |
| Accepted turn | Visit Accepted, associate On UP, Sale / No-Sale offered |
| Completed but Inside | Sale recorded, service Completed, presence still Inside |
| Waiting, no capacity | One On UP, one Pending Acceptance, one Off Floor, newest visit Waiting with a stated reason |
| Departed without assignment | Waiting visitor left with No-Sale and zero assignments |
| Departed after completion | Exit after a Sale: result preserved read-only, queue untouched |
| Temporary API failure | First two reads fail, then the board recovers |

**Fail the next read** forces a single read failure at any time, to see the
offline state and recovery. **Reset Demo** works in every scenario.

## Story coverage

| Story | Where it lives |
|---|---|
| US-01 Open the board | Seeded session, deterministic order, Next UP, metrics, 2 s poll, loading/empty/failure/reconnect states — `useBoard`, `DashboardPage`, `AssociatesTable` |
| US-02 Register manually | `VisitorForm` create mode, `eventId` idempotency, server-set `arrivedAt`/order, Manual + NotRequested, profile-only correction via edit mode |
| US-03 Accept and complete | `Accept UP` for a pending assignment only; `Sale` / `No-Sale` for an accepted unfinished turn; release to rotation bottom; Completed stays Inside |
| US-04 Register departure | `ExitDialog`: requires a missing result, preserves an existing one read-only; Waiting visitors can leave unassigned |
| US-05 Availability and waiting | `AssociatesTable` idle-only availability, bottom-of-queue return, stated reason when nothing can be assigned |
| US-06 Reset | `ResetDialog` destructive confirmation, mutations blocked, old snapshots discarded, new board loads at zero |

`npm test` covers these transitions directly against the mock engine
plus a render smoke check of the app tree.

## Remaining API integration work

The contract below is confirmed against the backend's own canonical,
dependency-free source — `retail-intelligence-backend/src/contracts/dto.ts`
and `errors.ts` — not guessed. `src/lib/types.ts`, `httpBoardClient.ts` and
`boardService.ts` already match it. What is **not yet verified** is running
the HTTP adapter against a live server:

1. **Local dev server.** The backend's local dev server (port 3000, matching
   `VITE_API_PROXY_TARGET`'s default and the Vite proxy in `vite.config.ts`)
   was still pending as of this check. Once it exists, set
   `VITE_BOARD_CLIENT=http` and run both `npm run dev` processes side by side.
2. **Re-run the story checks against the real path** — normal flow,
   Waiting/Off Floor, retries and concurrency, all departure states, a sale
   without an assignment, and reset with stale writes — the same scenarios
   `npm test` already covers against the mock engine.
3. **Watch for contract drift.** If the backend's contract changes, update
   `src/lib/types.ts`, `src/lib/labels.ts`, `src/lib/selectors.ts`,
   `mockEngine.ts` and `httpBoardClient.ts` together; they currently agree
   field-for-field, including:
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
   * error bodies are `{code, message}`; `BoardError.fromApi` maps every code
     in `Backend Requirements.md` §6
4. **Confirm auth.** The operator token is sent as
   `Authorization: Bearer <token>`; confirm the real header name and whether
   a token is required at all in the deployed environment.

## Deliberately not built

Sidebar entries Analytics / Company / Support, the top-bar search and the
user placeholder are visibly unavailable and have no destination. There are no
charts, no video or image panels, no upload control, no CV start button or
camera settings, no roster CRUD, no store or shift administration, no visitor
deletion, no account or settings screens, and no history or archive view.
