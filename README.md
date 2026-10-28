# Digital UP Board - Stage 1 backend

Proof of concept for registering store visitors and distributing them between
sales associates: manual stories US-01 through US-06. Computer vision, image
analysis and automatic arrivals are a separate, later workstream and are not
implemented (CV source / non-null `detectedAt` are rejected).

Workspace layout (sibling folders under `RetailIntelligence/`):

- `../*.md` - shared analysis and design specifications (not tracked here).
  Start with `Session Handoffs.md` and `Backend Requirements.md` section 6.
- `../retail-intelligence-frontend/` - React + TypeScript UI (separate repository).
- `./` - this backend repository.

## Architecture

```
Browser (React) --HTTPS JSON + Bearer token--> Vercel Functions (api/*.ts)
   src/http      method/405, operator token (401), body validation (400), error mapping, no-store
   src/store     WorkflowStore  ->  SupabaseGateway  ->  RpcClient (Supabase PostgREST | node-postgres)
Supabase PostgreSQL
   public.upb_* command functions (one transaction each, demo_control row lock first)
   upb_private.* helpers (FIFO dispatch, queue append, activity), tables + constraints + RLS
```

- Every transition rule lives in exactly one place: the SQL command function.
  TypeScript validates request shape, never duplicates the queue algorithm.
- Every mutation locks the single `demo_control` row, then checks `sessionId`,
  so writes (including reset) are serialized and stale runs are rejected.
- The board is one `STABLE` SQL statement: always one committed run.
- Rotation (contract v4): at most one pending offer per associate, offers to
  several associates in parallel; the queue moves when an offer is created;
  accept/reject/outcome/exit never move it. Reject returns the visit to
  Waiting at its original order and re-dispatches; rejected offers are kept
  as history. See `docs/CONTRACT_CHANGES.md`.
- Purchase result lives only on `visits.outcome`; assignments store
  milestones and `completion_reason` (OutcomeRecorded | Departure).
- Tables: RLS enabled, no access for `anon`/`authenticated`; functions
  executable only by `service_role`; helpers live in the unexposed
  `upb_private` schema.

| Path | Contents |
|---|---|
| `api/` | Vercel Functions, one file per endpoint (Web `Request`/`Response` signature) |
| `src/contracts/` | Public DTOs, enum values, error codes - dependency-free, shareable with the frontend |
| `src/http/` | Route pipeline, auth, validation, command parsers, route table |
| `src/store/` | `WorkflowStore`, `SupabaseGateway`, RPC transports |
| `supabase/migrations/` | Versioned schema, constraints, grants, roster, command functions |
| `supabase/seed.sql` | Idempotent setup (never erases an active demo) |
| `scripts/` | Local PostgreSQL, local dev server, acceptance run |
| `tests/` | Integration tests (real PostgreSQL) and transport unit tests |
| `docs/API.md`, `docs/api.http` | Request/response contract and examples |
| `docs/CONTRACT_CHANGES.md` | Versioned breaking-change notes for the frontend |

## Requirements

- Node.js 22+ (developed on 24.12) and npm.
- Nothing else for local work: `embedded-postgres` downloads a real
  PostgreSQL 18 binary as a dev dependency. Docker/Supabase CLI are optional.

```sh
npm install
```

## Environment

Copy `.env.example` to `.env.local` (git-ignored) and fill in values. All are
server-side only; never expose them to the browser bundle.

| Variable | Purpose |
|---|---|
| `DEMO_OPERATOR_TOKEN` | Shared operator token expected as `Authorization: Bearer <token>` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase project used by the gateway (deployment) |
| `CORS_ALLOWED_ORIGINS` | Comma-separated exact frontend origins allowed from a browser (e.g. `http://localhost:5173`) |
| `DATABASE_URL` | Optional, local/test only: direct PostgreSQL; takes precedence over Supabase |
| `PORT` | Optional port of the local dev server (default 3000) |

## Run locally

Two terminals:

```sh
# 1. Local PostgreSQL on :54322 (data in .local-db/), migrations + seed applied
npm run db:local
#    prints DATABASE_URL=postgres://upb_backend:upb_backend_local@127.0.0.1:54322/upboard

# 2. API on http://localhost:3000 (same route code as the Vercel Functions)
#    with DATABASE_URL and DEMO_OPERATOR_TOKEN in .env.local, or inline:
DATABASE_URL=postgres://upb_backend:upb_backend_local@127.0.0.1:54322/upboard \
DEMO_OPERATOR_TOKEN=local-dev-token \
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5181 npm run dev
```

The frontend is a separate project calling `API_BASE_URL`
(`http://localhost:3000` locally); its origin must be listed in
`CORS_ALLOWED_ORIGINS`. Enter the same operator token in the board UI.

Scripted end-to-end check over real HTTP (**resets the demo**):

```sh
API_BASE_URL=http://localhost:3000 DEMO_OPERATOR_TOKEN=local-dev-token npm run acceptance
```

The local database connects as login role `upb_backend`, which switches to
`service_role`, so grants are exercised as in Supabase. It is a disposable
development database; delete `.local-db/` to start over.

## Supabase setup (not performed - requires authorization and a project)

```sh
supabase link --project-ref <ref>
supabase db push            # applies supabase/migrations in order
psql "$SUPABASE_DB_URL" -f supabase/seed.sql   # optional, idempotent
```

Migration `20261027000300_roster_setup.sql` already creates the roster (Alex,
Jamie, Morgan with fixed IDs) and the first run, so a pushed database is
ready. Migrations `20261027000900_advance_on_acceptance.sql` and
`20261028000100_per_associate_offers.sql` convert data from earlier rotation
models; each stops with a report when existing pending offers conflict with
its new uniqueness rule (reconcile them first). Running setup again never erases an active demo; `POST /api/demo/reset`
is the only destructive operation. For `supabase db reset` locally, `seed.sql`
runs automatically. Set the three server variables in Vercel project
settings; leave `DATABASE_URL` unset there.

## Tests

```sh
npm run typecheck
npm test                    # all tests: starts a throwaway PostgreSQL 18 cluster
npm run test:integration
npm run test:unit
```

Each integration test file gets its own freshly migrated database, which is
dropped afterwards. Tests go through the real HTTP pipeline, real
`SupabaseGateway` and node-postgres transport, real SQL functions and real
concurrent connections. No store or RPC is mocked.

## API

See [docs/API.md](docs/API.md) for the full contract with JSON examples and
curl commands, and [docs/api.http](docs/api.http) for an HTTP-client file.

| Endpoint | Success |
|---|---|
| `GET /api/board` | 200 BoardSnapshot |
| `POST /api/arrivals` | 201 new / 200 identical replay (`duplicate: true`) |
| `POST /api/availability` | 200 |
| `POST /api/assignments/{id}/accept` | 200 |
| `POST /api/assignments/{id}/reject` | 200 |
| `POST /api/assignments/{id}/outcome` | 200 |
| `PATCH /api/visits/{id}/attributes` | 200 |
| `POST /api/visits/{id}/departure` | 200 |
| `POST /api/demo/reset` | 200 |

## Verification status

Verified locally (PostgreSQL 18.4 via embedded-postgres, Windows 11, Node 24):

- `npm run typecheck`: passes.
- `npm test`: 81 tests (72 integration + 9 unit).
  Includes Reject UP: re-offer to the next eligible associate, re-offer to
  the same associate when alone, original FIFO order, replay/accept/reject
  conflicts, departure after rejection, concurrent accept vs. reject, and
  the one-live-assignment-per-visit constraint.
  Includes parallel per-associate offers (V1->A, V2->B, V3->C, V4 waits,
  accepting V1 offers V4 to A), queue movement at offer time only, several
  accepted turns per associate, pending-offer departure freeing only that
  associate, offer-owner Off Floor rejection, both data migrations (stop on
  conflicting pending offers, conversion after reconciliation) and CORS
  (unit, store stubbed to prove preflight/rejection never reach it).
  Covers seed determinism and idempotent setup; constraints and grants;
  manual arrival, assignment, accept and outcome; 12 simultaneous distinct
  arrivals; concurrent same-eventId retries; changed-payload conflict;
  late availability retry; no-op availability; busy rejection vs. replay
  precedence; profile correction vs. arrival receipts; all four departure
  states; duplicate/conflicting departure; sale without assignment; exit
  after the associate was reassigned; concurrent outcome/exit; concurrent
  accepts/outcomes; all Off Floor / empty eligibility; concurrent capacity
  returns; reset atomicity, injected mid-reset failure rollback, concurrent
  resets, in-flight stale commands; snapshot consistency during resets;
  503 mapping for an unreachable database.
- `npm run acceptance` against `npm run dev` with a disposable database: 51/51 checks.
- Migration 0900 applied to the live local database with v1 data
  (9 visits, 2 OnUP, 1 pending offer) without data loss. Migration 1000 is
  covered by tests; it is applied to the live local database at the next
  `npm run db:local`.

Not verified (no environment or authorization available in this session):

- Real Supabase PostgREST/`supabase-js` calls. The transport's request
  building and error parsing are unit-tested against PostgREST-format
  responses, but not against a live project. The SQL itself runs on vanilla
  PostgreSQL 18; Supabase hosts PostgreSQL 15/17, and no PG18-only features
  are used.
- Supabase's actual default privileges and `service_role` setup. These are
  emulated locally (roles, BYPASSRLS, default grants on public).
- Vercel runtime packaging, routing of `api/**/[id]/*.ts` and named-method
  exports (`vercel dev` / deployment not run). The local dev server uses the
  same route definitions but its own Node HTTP adapter. On Vercel, unknown
  `/api/*` paths get the platform 404, not the JSON body, and preflight for
  them has no CORS headers.
- Cross-origin calls from a real browser (CORS verified with curl and unit
  tests only).
- Real browser integration with the frontend.

## Implementation decisions to note

- Outcome on an assignment closed by departure always returns 409
  `INVALID_TRANSITION`, also when the turn had been accepted before the
  exit, even if the result matches. The spec states this explicitly only for
  pending assignments. Applying it to accepted ones follows "new normal
  completion requires ... no departure/result".
- `405` responses use the error body code `METHOD_NOT_ALLOWED`, and rejected
  browser origins use `403 ORIGIN_NOT_ALLOWED` (the spec defines neither code).
- The data migration puts associates that were PendingAcceptance/OnUP under
  v1 at the queue bottom in roster order (the spec does not prescribe an
  order).
- Activity descriptions use per-run ordinals ("Visitor #3"), never raw
  order tokens.
