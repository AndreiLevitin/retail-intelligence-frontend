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

```ts
interface BoardService {
  readonly mode: 'mock' | 'http'
  getBoard(options?: { signal?: AbortSignal }): Promise<BoardSnapshot>
  registerVisitor(command: RegisterVisitorCommand): Promise<void>
  updateVisitorProfile(command: UpdateProfileCommand): Promise<void>
  acceptAssignment(command: AcceptAssignmentCommand): Promise<void>
  recordOutcome(command: RecordOutcomeCommand): Promise<void>
  markExit(command: MarkExitCommand): Promise<void>
  setAvailability(command: SetAvailabilityCommand): Promise<void>
  resetDemo(command: ResetDemoCommand): Promise<void>
}
```

`BoardSnapshot` (see `src/lib/types.ts`) carries `session`, `participants`,
`visits`, `metrics`, newest-first `activity`, `serverTime` and a monotonic
`revision`. Mutations return nothing: `useBoard` refetches instead of rotating
the queue or incrementing a counter locally.

Every mutation carries the `sessionId` it was composed against, plus an
idempotency key — `eventId` for an intentional registration, `commandId` for
everything else. A retry reuses the original key.

### Separate state, never inferred

Service status, physical presence and purchase result are three independent
columns:

* `serviceStatus` — Waiting / Assigned / Accepted / Completed
* presence — derived only from `departedAt`: Inside / Left
* `purchaseResult` — Sale / No-Sale / **Not recorded** when `null`

`Completed + Inside` is valid; a departed visitor can hold a result with no
associate and no turn; `null` is displayed as *Not recorded* and never as a
No-Sale. Appearance joins only the known non-empty parts and falls back to
*Description not provided*; `Unknown` demographics stay `Unknown`.

### Polling and failure behaviour

`useBoard` polls `GET /api/board` every 2 s with one request in flight, skips
a tick while a read is outstanding, and discards any snapshot that started
before a newer mutation or reset. Within a session an older `revision` can
never overwrite a newer one. On a read failure the last known board stays
visible with an offline indicator and the poll keeps retrying; the indicator
returns to Connected on the next success. Only the affected control is
disabled while its command is pending, and a reset blocks every mutation until
the new board has loaded.

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

The HTTP adapter is written but has never run against a live backend. The
route and field names below are this frontend's **assumption** and must be
reconciled with the Vercel API — `Prototype Design.md` and
`Design Class Diagram.md` were not available when this was built.

1. **Confirm the DTO contract.** `src/lib/types.ts` defines `BoardSnapshot`,
   `VisitDto`, `ParticipantDto`, `AssignmentDto`, `MetricsDto` and
   `ActivityEntryDto`. Align field names, and confirm `revision` and
   `serverTime` exist (they drive stale-snapshot rejection and the
   last-updated label). If `revision` is absent, replace the guard in
   `useBoard.applySnapshot`.
2. **Confirm the machine enum values**, which the UI sends verbatim:
   * age group — `Under20`, `From20To39`, `From40To59`, `Over60`, `Unknown`
   * gender — `Female`, `Male`, `Unknown`
   * purchase result — `Sale`, `NoSale`
   * service status — `Waiting`, `Assigned`, `Accepted`, `Completed`
   * participant state — `Available`, `OffFloor`, `PendingAcceptance`, `OnUP`
   * completion reason — `OutcomeRecorded`, `Departure`
   * source / attributesSource — `Manual`; enrichmentStatus — `NotRequested`
3. **Confirm the routes** in `BOARD_ROUTES` (`src/services/httpBoardClient.ts`):
   `GET /api/board`, `POST /api/visits`, `PATCH /api/visits/:id/profile`,
   `POST /api/assignments/:id/accept`, `POST /api/visits/:id/outcome`,
   `POST /api/visits/:id/exit`, `POST /api/participants/:id/availability`,
   `POST /api/demo/reset`.
4. **Confirm the command envelope.** Each request body is the command object:
   `sessionId` plus `eventId` or `commandId`. Verify the server treats a
   replayed key as a no-op and rejects a stale `sessionId`.
5. **Confirm auth.** The operator token is sent as
   `Authorization: Bearer <token>`. Agree the real header and whether the
   token is required at all.
6. **Confirm the error contract.** `toBoardError` maps 401/403 → Unauthorized,
   400/409/422 → Conflict, 5xx → Server, and reads a short `message` from the
   body. The UI shows nothing longer than 160 characters and never shows SQL.
7. **Switch the adapter.** Set `VITE_BOARD_CLIENT=http`, point
   `VITE_API_PROXY_TARGET` at the backend for local work, and deploy behind
   the same origin as `/api`. No screen needs redesigning.
8. **Then re-run the story checks** against the real path — normal flow,
   Waiting/Off Floor, retries and concurrency, all departure states, a sale
   without an assignment, and reset with stale writes.

## Deliberately not built

Sidebar entries Analytics / Company / Support, the top-bar search and the
user placeholder are visibly unavailable and have no destination. There are no
charts, no video or image panels, no upload control, no CV start button or
camera settings, no roster CRUD, no store or shift administration, no visitor
deletion, no account or settings screens, and no history or archive view.
