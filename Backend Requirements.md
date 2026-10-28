# Backend Requirements - Stage 1

Implement manual-operation [US-01 through US-06](Prototype%20Backlog.md). [Prototype Design](Prototype%20Design.md), [Database Design](Database%20Design.md), and [State Transition Consistency](State%20Transition%20Consistency.md) define contracts and rules. Full documents contain future CV design; the stage boundary below takes precedence over implementation order suggestions to experiment with CV.

## 1. Execution boundary

Vercel HTTP Functions validate request/access, invoke typed WorkflowStore operations and map results/errors. SupabaseGateway implements WorkflowStore using PostgreSQL RPC. SQL command functions own transitions, one stable demo_control lock, linked state changes, activity and dispatch in one transaction. No Next.js, direct browser database access, message broker or CV dependency.

## 2. Required endpoints

| Endpoint | Stage behavior |
|---|---|
| GET /api/board | Current-run complete snapshot and derived metrics; no-store |
| POST /api/arrivals | Manual form with immutable eventId and attributes; server entry time/order; reserve or retain Waiting |
| POST /api/availability | Idle Available/OffFloor with commandId replay protection; dispatch on return |
| POST /api/assignments/{id}/accept | Accept once if visit still inside; no release |
| POST /api/assignments/{id}/outcome | Set Visit outcome/time; complete accepted turn, release once, dispatch |
| PATCH /api/visits/{id}/attributes | Manual profile correction only for this stage; no edits to lifecycle/result/time |
| POST /api/visits/{id}/departure | Exit registration; preserve/result selection; close unfinished assignment only; dispatch if released |
| POST /api/demo/reset | Atomic clear/reseed with new run identity and stale-request protection |

Preserve source CV, detectedAt, provenance and enrichment fields in schema/types for later compatibility, but do not build a CV producer, analyzer, upload endpoint or automatic inference. GET /api/session and CV-scoped authorization can remain deferred; the stage UI obtains session context from board. Keep unimplemented future paths explicitly unavailable, not successful simulated CV results. Manual visits use source/attributesSource Manual and enrichmentStatus NotRequested.

## 3. Data and consistency requirements

Implement the six domain tables plus demo_control and command_receipts, constraints/indexes, deterministic predefined roster, active-run setup, SQL RPCs and restricted execution grants in versioned supabase/migrations. Business rules are not duplicated in TypeScript. Gateway exposes named methods, with SQL function names private. Derive metrics from facts: visitors from Visit; assigned/accepted turns from Assignment; closed sales from Visit.outcome Sale; conversion sales/visits * 100 or 0%.

Manual arrival attributes: upper/lower text may be empty when unknown, accessory nullable, age and gender explicit enums with Unknown. Server sets arrivedAt; detectedAt normally null. Attribute corrections are profile replacements and cannot alter result/time/queue. Preserve exact immutable original arrival payload in receipts for retry comparison after profile correction.

Departure handles Waiting, pending, accepted and completed service. Pending completion uses reason Departure without acceptedAt. Completed service exit never releases the participant again; that participant may have a new assignment. Preserve an existing outcome; missing result requires explicit Sale/NoSale, including unassigned visits. Update Visit status Completed and departedAt once. Duplicate exits do not create extra activity or rewrite timestamps.

Single demo control lock serializes mutations including reset; current session is checked only after taking it. Read snapshots are one consistent SQL projection. Queue append order remains above all seeded/current tokens; FIFO visitor order is server registration. Do not expose tokens, receipts or SQL errors in DTOs. Use composite FKs and partial uniqueness to enforce same-session links and at most one unfinished assignment per participant.

## 4. Access and validation

Use the agreed operator shared token, kept server-side and entered once in the browser; no user/role management. Reject unauthorized routes before invoking RPC. Grant direct table/API permissions only as required for trusted backend execution; deny anonymous table writes and public helper execution. Never return/store credentials in activity or receipts. Provide environment variable names and example placeholders only. CV token and inference configuration are not needed for Stage 1.

Follow documented 200/201, 400, 401, 404, 409 and 503 responses. Validate enums, UUIDs, nullable fields and presence/result conditions. Result acknowledgements are followed by client snapshot refresh; they are not an alternative source of board state.

## 5. Required verification and delivery

Database/API integration checks must exercise: manual arrival/assignment/accept/outcome; simultaneous distinct arrivals; duplicate arrival and changed-payload conflict; late availability retry; profile correction; all four departure states; duplicate/conflicting departure; sale without assignment; exit after associate reassigned; concurrent outcome/exit; empty eligibility; reset rollback/stale commands. These verify business invariants, not getters or SQL text shape.

Deliver migrations/functions/seed, Vercel API source, typed gateway/contracts, setup instructions, environment template and verification results. Do not provision or deploy to an external project unless authorized in that implementation session. Frontend integration consumes the same DTOs; explicitly identify unimplemented paths rather than inventing successful responses.

## 6. Contract refinements from pre-implementation review

These details resolve ambiguities in Stage 1; they do not introduce new user stories. Use the DTO field list in Prototype Design and the rules below together. Stage 1 takes precedence over full-scope CV examples.

### Requests and authentication

Every implemented endpoint requires `Authorization: Bearer <operator-token>`. The token is never a body field, query parameter, receipt field or log entry. Mutations use Content-Type application/json. Use SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and DEMO_OPERATOR_TOKEN as server environment names. The browser supplies the operator token at runtime; no production token is baked into the bundle.

| Endpoint | Complete Stage 1 JSON body | Success |
|---|---|---|
| GET /api/board | No body | 200 BoardSnapshot |
| POST /api/arrivals | sessionId, eventId, source: Manual, detectedAt: null (or omitted), attributes: VisitorAttributes | 201 ArrivalResult for creation; 200 with duplicate true for identical replay |
| POST /api/availability | sessionId, participantId, commandId, state: Available or OffFloor | 200 AvailabilityResult |
| POST /api/assignments/{id}/accept | sessionId | 200 AcceptanceResult |
| POST /api/assignments/{id}/outcome | sessionId, outcome: Sale or NoSale | 200 OutcomeResult |
| PATCH /api/visits/{id}/attributes | sessionId, source: Manual, attributes: VisitorAttributes, enrichmentStatus: NotRequested | 200 AttributesResult, ignored false |
| POST /api/visits/{id}/departure | sessionId; optional outcome: Sale or NoSale | 200 DepartureResult |
| POST /api/demo/reset | sessionId | 200 ResetResult |

VisitorAttributes is a full object: upperDescription string, lowerDescription string, accessoryDescription string or null, ageGroup enum, gender enum. Full profile replacement is intentional; PATCH here updates the profile portion, not arbitrary Visit columns. Preserve manual values and mark attributesSource Manual/enrichmentStatus NotRequested. Same unchanged replacement returns the profile without another activity entry.

Normalize descriptions by trimming surrounding whitespace, permit empty upper/lower, normalize empty accessory to null. Limit each description field to 200 characters. Require explicit ageGroup and gender (Unknown allowed); reject invalid enum values, malformed IDs, unexpected writable fields, non-null detectedAt or source CV for this stage. Normalize missing detectedAt to null before storing/comparing the original receipt. Validate semantic values again inside SQL functions so RPC cannot bypass invariants. Do not accept source/provenance fields that claim a different caller role.

### Transition and replay decisions

- Validate current session under the control lock before looking up current-run targets or receipts. Old session returns 409 STALE_SESSION, even if its records have been deleted. Unknown target in current session returns 404 NOT_FOUND. Every target query is scoped by session.
- Arrival receipt key uses eventId as command_id and kind Arrival. Availability receipt uses commandId and kind Availability. Same key with different normalized content or kind returns 409 REPLAY_CONFLICT. Replay comparison uses immutable request receipt, never edited Visit attributes. Arrival replay returns current Visit status and original visitId; availability replay returns saved acknowledgement without reapplying state.
- Request to set an idle participant to their existing state is a no-op: keep queue position, append no activity, but save the command receipt. A busy participant rejects availability changes with 409 INVALID_TRANSITION. Replay receipt lookup happens before current participant-state validation.
- Acceptance: if acceptedAt exists, return replayed true and current phase, including Completed. If completedAt exists but acceptedAt is null (early departure), reject INVALID_TRANSITION; never fabricate acceptance.
- Outcome: same recorded result on an accepted assignment is a replay even after subsequent exit; a different result returns OUTCOME_CONFLICT. An assignment closed by departure before acceptance cannot receive normal turn outcome, even if its Visit has a result. New normal completion requires acceptedAt, unfinished assignment and no departure/result.
- Departure: if Visit has an outcome, an omitted or matching outcome is accepted; a conflicting provided outcome returns OUTCOME_CONFLICT. Without stored outcome, require the explicit selection or return OUTCOME_REQUIRED. Repeated exit returns original departedAt and replayed true, with no new effects.
- Profile correction is permitted after departure within the same run. Last successfully committed manual profile replacement wins; collaborative edit conflict detection is outside the single-operator PoC. Stale-run writes always fail.
- Reset serialization and new session ID are the retry boundary; no generic command receipt is needed for reset. After an uncertain response fetch board: old session means not yet observed completed; new session means reset committed. An old reset replay returns STALE_SESSION rather than resetting again.

### Error codes and presentation

| HTTP | Stable code | Meaning |
|---|---|---|
| 400 | VALIDATION_ERROR | Malformed body/ID/enum, unsupported source or extra writable field |
| 400 | OUTCOME_REQUIRED | Departure requires an explicit missing purchase result |
| 401 | UNAUTHORIZED | Missing/invalid operator token |
| 404 | NOT_FOUND | Target absent from validated current run |
| 409 | STALE_SESSION | Run has changed; fetch board |
| 409 | INVALID_TRANSITION | Action incompatible with current lifecycle |
| 409 | REPLAY_CONFLICT | Same command identity has different normalized content/kind |
| 409 | OUTCOME_CONFLICT | Attempt to replace existing purchase result |
| 503 | DATABASE_UNAVAILABLE | Temporary database connectivity/availability failure |
| 500 | INTERNAL_ERROR | Unexpected failure, with sanitized message; do not label all bugs temporary outages |

Return `{code, message}`; no raw SQL detail. Unsupported HTTP method returns 405 with Allow header. Use generic valid failure for unknown routes (404). Browser receives machine codes without SQLSTATE; gateway maps known SQL/domain failures explicitly. All board, command and error responses use Cache-Control: no-store.

### Metrics, activity, and snapshots

Return counts as JSON numbers, not PostgreSQL bigint strings. conversionRate is a JSON number calculated from Visit sales/all visits * 100; round for display in UI, not separately stored. One joined aggregate must not multiply visit/assignment/activity counts: aggregate each collection independently before building the snapshot. Empty arrays are [], optional values null, session is SessionContext with sessionId (not a second id alias). Current-run snapshot must be consistent as one statement/read projection.

Activity kinds are ArrivalRecorded, AssignmentCreated, AssignmentAccepted, TurnCompleted, AvailabilityChanged, VisitorAttributesUpdated, VisitorDeparted. Normal outcome emits TurnCompleted; departure emits VisitorDeparted plus TurnCompleted only when closing an unfinished assignment. Exit after normal completion emits only VisitorDeparted. Entry to Waiting and then automatic reservation may emit two activities. Same-operation replays and no-ops emit none. Do not create a new activity kind merely to duplicate a metric.

### Setup, package boundaries, and verification evidence

Inspect existing source first. Frontend is implemented by Claude directly from requirements; no design-tool export is expected. Backend agent owns Vercel API functions, server modules, migrations, verification and backend setup notes. Do not rewrite React screens or frontend package tooling while another session edits them. Reuse a suitable existing TypeScript project; if no app exists, establish only minimal backend TypeScript/package configuration and record any root-package changes for the frontend handoff. Keep public DTO definitions in a dependency-free shared module, or publish an exact contract fixture if sessions use separate checkouts. Do not add runtime database/security imports to shared client types.

Use deterministic seed associates (for example Alex, Jamie, Morgan with fixed UUIDs/order). Setup must initialize one control row/session/roster reproducibly; rerunning setup must not silently erase an active demo. Reset is the explicit destructive operation. Deliver an environment template without values, local run instructions, migration/seed instructions, API examples, and a scriptable acceptance run.

Use a disposable local/test database for destructive reset/concurrency checks; do not run them against an unrelated project. If no database/runtime access is available, finish reviewable code/migrations/tests and state exactly which integration checks could not run; mocked RPC success is not evidence of transaction correctness. No cloud project creation or deployment is implied by this task review.

Queue append implementation: under the shared control lock, allocate COALESCE(MAX(queue_order) among current-session Available participants, 0) + 1. Reset seeds initial order from associates. Raw queue tokens may be reused after the queue empties; only current relative order matters. Visit/activity sequences remain independent stable registration/history order. No second queue counter or sequence is needed.
