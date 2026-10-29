# API contract changes

`CONTRACT_VERSION` in [`src/contracts/dto.ts`](../src/contracts/dto.ts).

## Version6 - CV arrival without initial attributes (additive)

- `POST /api/arrivals` also accepts `{sessionId,eventId,source:"CV",detectedAt}`.
- CV detectedAt is required, valid ISO8601 UTC (Z or+00:00), normalized to
  millisecond UTC. CV registration does not accept attributes yet; no analyzer
  is being claimed. Attributes default to blank descriptions, null accessory
  and Unknown age/gender; attributesSource=Unknown, enrichmentStatus=NotRequested.
- Existing Manual bodies and board DTO shapes are unchanged. CV events use
  the same eventId receipts, session lock, dispatcher, metrics and replay rules.
- Timestamp changes under the same eventId conflict. Server registered time
  remains separate from local detection time. Stale-session commands still stop.
- Migration `20261028000400_cv_arrivals.sql` replaces only the arrival function,
  retaining service_role-only execution. Apply it before starting the updated API.

Frontend already understands the CV source and unknown values; no board schema
change is required. The local Python runner sends an event as soon as it is
observed, while the web board continues its existing2-second polling.

## Version 5 - no re-offer to the last rejecter (additive)

User-confirmed correction of Reject UP; agreed with the frontend session.

- A visit is never offered to the associate who rejected it **last** (the
  participant of its most recent `Rejected` assignment). Per visit, derived
  from history, lasting until someone else rejects it; the rejecter remains
  eligible for every other visitor.
- Dispatch serves the oldest Waiting visit that has a non-excluded eligible
  associate; a rejected visit keeps its FIFO position.
- `RejectionResult.status` is `Waiting` when only the rejecter would be
  eligible - never `Assigned` back to them.
- New field `VisitView.waitingReason: 'NoAvailableAssociates' |
  'AwaitingConfirmation' | 'AwaitingOtherAssociate' | null` (server-computed,
  non-null only while Waiting and inside). Replaces client-side derivation.

Migration `supabase/migrations/20261028000300_skip_last_rejecter.sql`
replaces the dispatcher and the board function. No schema change.

## Version 4 - Reject UP (additive)

Source: `Assignment Rotation Revision.md` rules 9-10 and "Reject UP" section;
user-confirmed decision to keep rejected offers as history.

- New endpoint `POST /api/assignments/{assignmentId}/reject`, body
  `{ sessionId }` (same shape as accept, no idempotency key), result
  `RejectionResult { sessionId, assignmentId, visitId, status, replayed }`.
- `completionReason` adds `'Rejected'`; `ActivityKind` adds `'AssignmentRejected'`.
- Reject is valid only for a pending offer. Accepted -> 409 INVALID_TRANSITION;
  already closed -> `replayed: true` with the current visit status.
- The visit returns to `Waiting` at its original registration order; the
  rejecting associate is not moved; dispatch runs at once. Because the
  rejecting associate is eligible again, the visit is normally re-offered
  immediately (`status: 'Assigned'`), possibly to the same associate.
- A visit can now have several assignments: any number with
  `completionReason: 'Rejected'` and at most one other. `BoardSnapshot.assignments`
  lists them all; `VisitView.assignmentId` is the non-rejected one and is
  `null` while the visit is Waiting.
- `assignedTurns` counts rejected offers too; `acceptedTurns` does not.

Migration `supabase/migrations/20261028000200_reject_up.sql`: adds the enum
values, replaces `UNIQUE(visit_id)` with a partial unique index on non-rejected
assignments, adds `upb_reject_assignment` and updates board, departure and
accept accordingly.

## Version 3 - per-associate offers (behavior change, same fields)

Source: corrected `Assignment Rotation Revision.md` (same day). Version 2 had a
single pending-offer gate for the whole run and moved the queue on acceptance;
both were wrong.

| v2 | v3 |
|---|---|
| At most one pending offer per **run** | At most one pending offer per **associate**; several associates may hold one at once |
| Later arrivals waited behind the single offer | A new arrival goes to the front-of-queue eligible associate (Available, no own pending offer) |
| Offer kept the associate's queue position | **Offer** moves the associate to the queue bottom |
| **Accept** moved the associate to the bottom | Accept never moves the queue; it re-dispatches because the associate is eligible again |
| Pending-offer departure cleared the run-wide gate | Pending-offer departure frees only that associate; queue unchanged |
| OffFloor rejected for the run's offer owner | OffFloor rejected for any associate holding their own pending offer |

Unchanged: all request bodies and DTO fields (including `pendingAssignmentId`,
`activeAssignmentIds`, `activeTurns`), outcome rules, accepted-work rules,
CORS, errors.

Waiting reason (derived, no new field): no associate Available -> "No
available associates"; else every Available associate has
`pendingAssignmentId !== null` -> "Awaiting confirmation".

Example: A, B, C Available; V1-V4 arrive -> V1->A, V2->B, V3->C in parallel,
V4 waits; accept V1 -> V4 offered to A (A now at the bottom); Sale on V1 and
further accepts do not move the queue; V4 departing before acceptance frees
only A.

Migration `supabase/migrations/20261028000100_per_associate_offers.sql`:
stops with a report if one participant has several pending offers; replaces
`assignments_one_pending_offer_per_session` with
`assignments_one_pending_offer_per_participant`; replaces the dispatcher and
accept function; moves existing pending-offer owners to the queue bottom and
offers Waiting visitors to the associates now eligible.

## Version 2 - Advance on Acceptance (breaking)

Source: `Assignment Rotation Revision.md`; `Backend Requirements.md`, section
"Confirmation-gated rotation migration and separate hosting".

### Business behavior

| Before (v1) | Now (v2) |
|---|---|
| Associate was exclusive until outcome/exit (`PendingAcceptance`, `OnUP`) | Associate availability is only `Available` / `OffFloor` |
| One unfinished assignment per associate | Any number of accepted unfinished assignments per associate |
| Dispatch filled every Available associate | At most **one** pending offer (PendingAcceptance) per run; later arrivals wait behind it |
| Reservation removed the associate from the queue | Offer keeps the associate's availability and queue position |
| Outcome / exit released the associate to the queue bottom | **Acceptance** moves the associate to the bottom exactly once, then offers the next oldest Waiting visitor |
| - | Outcome never changes rotation or availability |
| Exit of a pending/accepted visitor released the associate | Exit never moves rotation. Exit of a pending offer closes it (reason Departure) **without consuming the turn** and offers the next visitor |
| Busy associates could not change availability | Only the owner of the pending offer cannot go `OffFloor` (409 INVALID_TRANSITION); accepted work does not block it and is kept |

### DTO changes

`AssociateView`:

- `state`: now `'Available' | 'OffFloor'` only.
- removed: `currentAssignmentId`.
- added: `pendingAssignmentId: string | null` - the run's single pending offer, when it belongs to this associate.
- added: `activeAssignmentIds: string[]` - accepted, unfinished assignments (visit registration order).
- added: `activeTurns: number` - `activeAssignmentIds.length`.
- `assignedTurns` counts all offers, including ones closed by early departure.

Unchanged: request bodies of all eight endpoints, `VisitView`, `AssignmentView`
(phase is still PendingAcceptance/Accepted/Completed), `MetricsView`,
`ActivityView`, all result DTOs.

Waiting explanation (derived by the UI from the snapshot; no new field):

- a pending offer exists (some `assignments[].phase === 'PendingAcceptance'`)
  -> "Awaiting confirmation";
- otherwise no associate has `state === 'Available'` -> "No available associates".

### Separate hosting / CORS

- The API no longer assumes same-origin. The frontend calls `API_BASE_URL`.
- Backend env `CORS_ALLOWED_ORIGINS`: comma-separated exact origins.
- `OPTIONS` preflight is answered for every route without a token
  (`Access-Control-Allow-Methods` = route methods + OPTIONS,
  `Access-Control-Allow-Headers: Authorization, Content-Type`, max-age 600).
- Responses to allowed origins carry `Access-Control-Allow-Origin: <origin>`
  and `Vary: Origin`, including error responses.
- New error: **403 `ORIGIN_NOT_ALLOWED`** for a browser `Origin` outside the
  allowlist (checked before auth). Requests without `Origin` are unaffected.
- `405` `Allow` headers now include `OPTIONS` (e.g. `GET, OPTIONS`).

### Database migration

`supabase/migrations/20261027000900_advance_on_acceptance.sql`:

1. Stops with a report if any run has more than one pending offer
   (needs business reconciliation - accept or record departure - first).
2. Replaces index `assignments_one_unfinished_per_participant` with
   `assignments_one_pending_offer_per_session`.
3. Converts `PendingAcceptance` / `OnUP` participants to `Available`, appended
   to the queue bottom in roster order. Assignment milestones are untouched.
4. Restricts the state CHECK to Available/OffFloor and replaces the dispatcher,
   accept, outcome, departure, availability and board functions.
