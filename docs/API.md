# Digital UP Board API - Stage 1

Contract version **5** (per-associate offers, Reject UP, no re-offer to the last rejecter) - see
[CONTRACT_CHANGES.md](CONTRACT_CHANGES.md) for the changes from earlier versions.

Canonical types: [`src/contracts/dto.ts`](../src/contracts/dto.ts) and
[`src/contracts/errors.ts`](../src/contracts/errors.ts) (dependency-free; the
frontend may copy them). Source of the rules: `Backend Requirements.md`
section 6, `Assignment Rotation Revision.md` and `Prototype Design.md`.

## Rotation model

- Associate availability is `Available` or `OffFloor` only; accepted work never
  makes an associate ineligible.
- Each associate holds at most one **pending offer** of their own; several
  associates may hold one at the same time. The oldest Waiting visitor still
  inside is offered to the front-of-queue **eligible** associate (Available
  and without a pending offer), repeatedly, so three free associates receive
  three visitors in parallel.
- Creating an offer moves that associate to the queue bottom immediately
  (optimistically assuming they confirm).
- **Accept** records acceptance only - no queue movement - and, since the
  associate is eligible again, offers them (or whoever is next eligible) the
  oldest Waiting visitor.
- Outcome and departure never change the queue. Departure of a pending offer
  closes it and frees only that associate for a new offer.
- **Reject** closes a pending offer (`Rejected`) without moving the queue and
  returns the visit to Waiting at its original registration order; dispatch
  runs immediately.
- A visit is **never offered to the associate who rejected it last**. The
  exclusion is per visit and lasts until someone else rejects it; the
  rejecter still receives other visitors. Dispatch serves the oldest Waiting
  visit that has a non-excluded eligible associate.
- A visitor waits only when no associate is eligible: nobody Available ("No
  available associates") or every Available associate already holds an offer
  ("Awaiting confirmation").

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
- `waitingReason` (server-computed, non-null only while Waiting and inside):
  `NoAvailableAssociates` (nobody Available), `AwaitingConfirmation` (every
  Available associate holds their own pending offer) or
  `AwaitingOtherAssociate` (the only eligible associate(s) rejected this
  visit last).
- `assignmentId` on a visit: its current non-rejected assignment, null while
  Waiting. `assignments` lists every offer, rejected ones included (a visit
  can have several `Rejected` entries and at most one other).
- `pendingAssignmentId`: this associate's own pending offer (at most one).
  `activeAssignmentIds` / `activeTurns`: accepted unfinished work.
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
- Manual still requires attributes and null/omitted detectedAt.
- CV (contract6) accepts `{sessionId,eventId,source:"CV",detectedAt}` with no
  attributes field. detectedAt must be a valid ISO8601 UTC timestamp (Z or+00:00).
  Initial descriptions are blank, accessory null, age/gender Unknown,
  attributesSource Unknown, enrichmentStatus NotRequested. No image inference
  is performed by this endpoint. The same assignment and retry rules apply.
- `status` is the visit status after automatic dispatch (`Assigned` or `Waiting`).

### POST /api/availability -> 200 AvailabilityResult

```json
{ "sessionId": "8b6f…", "participantId": "c2…", "commandId": "<uuid per intent>", "state": "OffFloor" }
```

`{ "sessionId": "8b6f…", "participantId": "c2…", "replayed": false }`

`OffFloor` is rejected (409 INVALID_TRANSITION) only for an associate who holds
their own pending offer - resolve it first. Accepted unfinished work does not
block it and is kept. Same state = no-op. Returning Available appends to the
queue bottom and offers Waiting visitors to eligible associates. A replay
returns the saved acknowledgement and never reapplies.

### POST /api/assignments/{assignmentId}/accept -> 200 AcceptanceResult

`{ "sessionId": "8b6f…" }` -> `{ "sessionId": "…", "assignmentId": "d4…", "phase": "Accepted", "replayed": false }`

Records acceptance; the queue does not move (it moved when the offer was
created). The associate becomes eligible again and Waiting visitors are
offered. Already accepted -> `replayed: true` with current phase (may be
`Completed`). Closed by departure before acceptance -> 409 INVALID_TRANSITION.

### POST /api/assignments/{assignmentId}/reject -> 200 RejectionResult

`{ "sessionId": "8b6f…" }` -> `{ "sessionId": "…", "assignmentId": "d4…", "visitId": "v1…", "status": "Assigned", "replayed": false }`

Only for a pending offer. Sets `completedAt` and `completionReason: "Rejected"`
(no `acceptedAt`), logs `AssignmentRejected`, returns the visit to Waiting at
its original order and dispatches immediately; `status` is the visit status
after that dispatch: `Assigned` to another eligible associate or `Waiting` -
never re-offered to the rejecter. The rejecting associate is not moved (they
moved when offered) and is immediately eligible for other visitors. Already closed (rejected or
departed) -> `replayed: true` with the current status. Accepted -> 409
INVALID_TRANSITION. Accepting a rejected offer -> 409 INVALID_TRANSITION.

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
  the queue does not move (it already moved at offer time); only that
  associate becomes eligible again and may be offered the next Waiting visitor.
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
