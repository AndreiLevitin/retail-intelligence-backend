# Digital UP Board API - Stage 1

Contract version **2** (Advance on Acceptance) - see
[CONTRACT_CHANGES.md](CONTRACT_CHANGES.md) for the breaking change from v1.

Canonical types: [`src/contracts/dto.ts`](../src/contracts/dto.ts) and
[`src/contracts/errors.ts`](../src/contracts/errors.ts) (dependency-free; the
frontend may copy them). Source of the rules: `Backend Requirements.md`
section 6, `Assignment Rotation Revision.md` and `Prototype Design.md`.

## Rotation model

- Associate availability is `Available` or `OffFloor` only; accepted work never
  makes an associate ineligible.
- At most one **pending offer** exists per run: the oldest Waiting visitor
  still inside is offered to the first Available associate. The associate's
  queue position does not change. Later visitors wait ("Awaiting
  confirmation") until the offer is resolved.
- **Accept** moves the associate to the queue bottom exactly once and offers
  the next oldest Waiting visitor.
- Outcome and departure never change rotation. Departure of a pending offer
  closes it without consuming the associate's turn and offers the next visitor.

## Conventions

- Every endpoint requires `Authorization: Bearer <operator-token>`.
  Missing or wrong token -> `401 UNAUTHORIZED`, checked before any database call.
- Mutations require `Content-Type: application/json` and a JSON object body
  containing exactly the listed fields; unknown fields -> `400 VALIDATION_ERROR`.
- All IDs are UUID strings; all times are ISO 8601 UTC with milliseconds
  (`2026-10-27T18:02:11.123Z`); optional values are explicit `null`.
- Every response (success or error) has `Cache-Control: no-store`.
- Unsupported method -> `405` with an `Allow` header (route methods + `OPTIONS`).
  Unknown path -> `404 NOT_FOUND`.
- Cross-origin browsers: only origins in `CORS_ALLOWED_ORIGINS` (exact match).
  `OPTIONS` preflight needs no token; other origins get `403 ORIGIN_NOT_ALLOWED`.
  CORS is not authentication: real requests still need the operator token.
- Command results only acknowledge the operation. Refresh `GET /api/board`
  after every successful (or uncertain) command.
- Retries: reuse the **same** `eventId` (arrivals) or `commandId`
  (availability) for the same intent; never generate a new one for a retry.
  Accept/outcome/departure are naturally idempotent by state.

## Errors

Body: `{ "code": "<CODE>", "message": "<short public text>" }`. No SQL details.

| HTTP | code | When |
|---|---|---|
| 400 | VALIDATION_ERROR | Malformed body/ID/enum, unsupported source, extra field |
| 400 | OUTCOME_REQUIRED | Departure of a visit without a result and without `outcome` |
| 401 | UNAUTHORIZED | Missing/invalid operator token |
| 403 | ORIGIN_NOT_ALLOWED | Browser `Origin` not in the CORS allowlist |
| 404 | NOT_FOUND | Target not in the current run (or unknown route) |
| 405 | METHOD_NOT_ALLOWED | Method not supported by the route (`Allow` header) |
| 409 | STALE_SESSION | `sessionId` is not the current run -> fetch the board |
| 409 | INVALID_TRANSITION | Action incompatible with the current lifecycle |
| 409 | REPLAY_CONFLICT | Same `eventId`/`commandId` with different content or kind |
| 409 | OUTCOME_CONFLICT | Attempt to replace an existing purchase result |
| 500 | INTERNAL_ERROR | Unexpected failure (sanitized; not necessarily retryable) |
| 503 | DATABASE_UNAVAILABLE | Temporary database unavailability (retry with same identity) |

## Endpoints

### GET /api/board -> 200 BoardSnapshot

```json
{
  "session": { "sessionId": "8b6f…", "startedAt": "2026-10-27T18:00:00.000Z" },
  "associates": [
    { "participantId": "c1…", "associateId": "a55c0000-0000-4000-8000-000000000001",
      "displayName": "Alex", "state": "Available", "queuePosition": 1,
      "pendingAssignmentId": "d4…", "activeAssignmentIds": [], "activeTurns": 0,
      "assignedTurns": 1, "acceptedTurns": 0 },
    { "participantId": "c2…", "associateId": "a55c0000-0000-4000-8000-000000000002",
      "displayName": "Jamie", "state": "Available", "queuePosition": 2,
      "pendingAssignmentId": null, "activeAssignmentIds": [], "activeTurns": 0,
      "assignedTurns": 0, "acceptedTurns": 0 }
  ],
  "visits": [
    { "visitId": "v1…", "arrivedAt": "2026-10-27T18:02:11.123Z", "detectedAt": null,
      "departedAt": null, "source": "Manual", "status": "Assigned",
      "attributes": { "upperDescription": "Red coat", "lowerDescription": "Jeans",
                      "accessoryDescription": null, "ageGroup": "From20To39", "gender": "Unknown" },
      "attributesSource": "Manual", "enrichmentStatus": "NotRequested",
      "outcome": null, "outcomeRecordedAt": null, "waitingPosition": null, "assignmentId": "d4…" }
  ],
  "assignments": [
    { "assignmentId": "d4…", "visitId": "v1…", "participantId": "c1…",
      "phase": "PendingAcceptance", "assignedAt": "2026-10-27T18:02:11.123Z",
      "acceptedAt": null, "completedAt": null, "completionReason": null }
  ],
  "metrics": { "visitors": 1, "assignedTurns": 1, "acceptedTurns": 0, "closedSales": 0, "conversionRate": 0 },
  "activity": [
    { "activityId": "e2…", "occurredAt": "2026-10-27T18:02:11.123Z", "kind": "AssignmentCreated",
      "description": "Visitor #1 offered to Alex", "visitId": "v1…", "participantId": "c1…", "assignmentId": "d4…" },
    { "activityId": "e1…", "occurredAt": "2026-10-27T18:02:11.123Z", "kind": "ArrivalRecorded",
      "description": "Visitor #1 registered (manual entry)", "visitId": "v1…", "participantId": null, "assignmentId": null }
  ],
  "serverTime": "2026-10-27T18:02:12.000Z"
}
```

- `associates`: stable initial roster order; Next UP = `queuePosition === 1`.
- `visits` / `assignments`: server registration order of the visit (FIFO).
- `waitingPosition`: 1-based rank among Waiting visitors still inside.
- Waiting reason (derived): a `PendingAcceptance` assignment exists ->
  "Awaiting confirmation"; else no `Available` associate -> "No available associates".
- `pendingAssignmentId`: the run's single pending offer, if it is this
  associate's. `activeAssignmentIds` / `activeTurns`: accepted unfinished work.
- Presence is derived: `departedAt === null` -> Inside, otherwise Left.
- `activity`: newest first, at most 100; metrics cover the whole run.
- `conversionRate`: `closedSales / visitors * 100` (0 for no visits), unrounded.

### POST /api/arrivals -> 201 (new) / 200 (identical replay) ArrivalResult

```json
{ "sessionId": "8b6f…", "eventId": "<uuid generated once per submission>",
  "source": "Manual", "detectedAt": null,
  "attributes": { "upperDescription": "Red coat", "lowerDescription": "",
                  "accessoryDescription": null, "ageGroup": "Unknown", "gender": "Unknown" } }
```

`{ "sessionId": "8b6f…", "visitId": "v1…", "duplicate": false, "status": "Assigned" }`

- `attributes` is a full object (all five keys). Descriptions are trimmed,
  max 200 characters; empty upper/lower allowed; empty accessory -> `null`.
- `ageGroup`: Under20 | From20To39 | From40To59 | Age60Plus | Unknown.
  `gender`: Female | Male | Unknown.
- `source: "CV"` or non-null `detectedAt` -> 400 (CV is not part of Stage 1).
- `status` is the visit status after automatic dispatch (`Assigned` or `Waiting`).

### POST /api/availability -> 200 AvailabilityResult

```json
{ "sessionId": "8b6f…", "participantId": "c2…", "commandId": "<uuid per intent>", "state": "OffFloor" }
```

`{ "sessionId": "8b6f…", "participantId": "c2…", "replayed": false }`

`OffFloor` is rejected (409 INVALID_TRANSITION) only for the associate who owns
the pending offer - resolve it first. Accepted unfinished work does not block
it and is kept. Same state = no-op. Returning Available appends to the queue
bottom and creates an offer if none is pending. A replay returns the saved
acknowledgement and never reapplies.

### POST /api/assignments/{assignmentId}/accept -> 200 AcceptanceResult

`{ "sessionId": "8b6f…" }` -> `{ "sessionId": "…", "assignmentId": "d4…", "phase": "Accepted", "replayed": false }`

Moves the associate to the queue bottom exactly once (they stay Available),
then offers the oldest Waiting visitor. Already accepted -> `replayed: true`
with current phase (may be `Completed`), no movement. Closed by departure
before acceptance -> 409 INVALID_TRANSITION.

### POST /api/assignments/{assignmentId}/outcome -> 200 OutcomeResult

`{ "sessionId": "8b6f…", "outcome": "Sale" }` ->
`{ "sessionId": "…", "visitId": "v1…", "assignmentId": "d4…", "outcome": "Sale", "replayed": false }`

Requires an accepted, unfinished turn (else 409 INVALID_TRANSITION). Stores the
result on the Visit (status Completed, visitor remains inside) and completes
the assignment (OutcomeRecorded). Rotation and availability are unchanged.
Same result again -> replay; different -> 409 OUTCOME_CONFLICT.
A turn closed by departure -> 409 INVALID_TRANSITION.

### PATCH /api/visits/{visitId}/attributes -> 200 AttributesResult

```json
{ "sessionId": "8b6f…", "source": "Manual", "enrichmentStatus": "NotRequested",
  "attributes": { "upperDescription": "Green coat", "lowerDescription": "Jeans",
                  "accessoryDescription": "Backpack", "ageGroup": "Age60Plus", "gender": "Female" } }
```

`{ "sessionId": "…", "visitId": "v1…", "attributes": { … }, "attributesSource": "Manual", "enrichmentStatus": "NotRequested", "ignored": false }`

Full profile replacement; never changes status, result, times, assignment or
queue. Allowed after departure. Unchanged profile -> no activity entry.

### POST /api/visits/{visitId}/departure -> 200 DepartureResult

`{ "sessionId": "8b6f…", "outcome": "NoSale" }` (`outcome` optional / null) ->
`{ "sessionId": "…", "visitId": "v1…", "departedAt": "2026-10-27T18:10:00.000Z", "outcome": "NoSale", "replayed": false }`

- Visit without result: `outcome` required (else 400 OUTCOME_REQUIRED).
- Visit with result: omitted/matching `outcome` accepted; different -> 409 OUTCOME_CONFLICT.
- Waiting: no assignment is created.
- Pending offer: closes with `completionReason: "Departure"`, no acceptance;
  the associate keeps their queue position (turn not consumed) and the next
  oldest Waiting visitor is offered.
- Accepted: closes with `completionReason: "Departure"`, `acceptedAt` kept;
  rotation unchanged. Completed service: nothing but the exit is recorded.
- Repeated exit -> `replayed: true` with the original `departedAt`.

### POST /api/demo/reset -> 200 ResetResult

`{ "sessionId": "8b6f…" }` -> `{ "sessionId": "<new run>", "startedAt": "2026-10-27T18:30:00.000Z" }`

Atomically clears visits, assignments, activity and receipts, and reseeds the
roster Available in initial order under a new session identity. A reset (or
any command) with the old `sessionId` -> 409 STALE_SESSION. After an uncertain
response, fetch the board: a new `sessionId` means the reset committed.

## curl examples (local dev server)

```sh
TOKEN=local-dev-token
API=http://localhost:3000
SID=$(curl -s -H "Authorization: Bearer $TOKEN" $API/api/board | node -pe 'JSON.parse(require("fs").readFileSync(0)).session.sessionId')

curl -s -H "Authorization: Bearer $TOKEN" $API/api/board

curl -s -X POST $API/api/arrivals -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SID\",\"eventId\":\"$(node -pe 'crypto.randomUUID()')\",\"source\":\"Manual\",\"detectedAt\":null,
       \"attributes\":{\"upperDescription\":\"Red coat\",\"lowerDescription\":\"Jeans\",\"accessoryDescription\":null,\"ageGroup\":\"From20To39\",\"gender\":\"Unknown\"}}"

curl -s -X POST $API/api/assignments/<assignmentId>/accept -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\"}"

curl -s -X POST $API/api/assignments/<assignmentId>/outcome -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\",\"outcome\":\"Sale\"}"

curl -s -X POST $API/api/visits/<visitId>/departure -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\"}"

curl -s -X POST $API/api/availability -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SID\",\"participantId\":\"<participantId>\",\"commandId\":\"$(node -pe 'crypto.randomUUID()')\",\"state\":\"OffFloor\"}"

curl -s -X POST $API/api/demo/reset -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\"}"
```

`docs/api.http` contains the same requests for VS Code REST Client / JetBrains HTTP client.
