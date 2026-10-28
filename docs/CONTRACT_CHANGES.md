# API contract changes

`CONTRACT_VERSION` in [`src/contracts/dto.ts`](../src/contracts/dto.ts).

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
