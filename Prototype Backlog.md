# Prototype Backlog - Stage 1

Current execution scope: stories US-01 through US-06 only. CV detection, image analysis, image upload/storage, and automatic demographic extraction are deferred as a separate workstream. No CV experiment, model installation, provider selection or CV service deployment is required now. Full future scope remains documented; this stage implements the manual path, including visitor attributes, purchase outcome and departure.

## US-01 - Open the operational board

As Receptionist, I can see the predefined associates and current demo session so I know who is next.

Acceptance criteria:

- A seeded active session has startedAt and at least one predefined associate; no Open Shift or check-in UI.
- Initial participants are Available in deterministic initial order. Next UP is the first eligible queuePosition.
- Board displays roster/states, visits/turns, metrics and newest-first activity. Empty run shows zero counts and 0% conversion.
- Initial loading, empty data, temporary failure and reconnection are visible. Poll every 2 seconds with no overlapping reads or stale-response overwrite.
- BoardService supports mock and HTTP adapters with the same DTOs. Production state is server-authoritative.

Dependencies: none. Covers UC-02, UC-07/08/09.

## US-02 - Register a visitor manually

As Receptionist, I can enter a visitor's appearance and demographics and receive an automatic associate assignment.

Acceptance criteria:

- Add Visitor form includes upper description, lower description, optional accessory, age group and gender. Unknown is explicitly available for demographics; use Unknown when the receptionist cannot determine a value.
- Age options: <20, 20-39, 40-59, 60+, Unknown; machine values match API. Description can be empty when unknown; show a readable fallback rather than fabricated text.
- Successful submit creates exactly one Visit with source Manual, attributesSource Manual and enrichmentStatus NotRequested. Server sets arrivedAt and FIFO registration order; user does not enter entry time.
- First Available participant is reserved immediately; the visit becomes Assigned and participant Pending Acceptance. If no eligible participant exists, visit stays Waiting.
- Submitting the same eventId again creates no duplicate visit, assignment or activity. Distinct intentional visits use distinct eventIds.
- Visit view displays combined appearance, demographics, registration time, assignment and separate service/presence/purchase state.
- Receptionist can correct only profile fields; this does not change outcome, timestamps, assignment or queue.

Dependencies: US-01. Covers UC-03/04/07/11.

## US-03 - Accept and complete a turn

As Receptionist acting for an associate, I can accept an UP and record Sale / No-Sale.

Acceptance criteria:

- Accept UP is enabled only for a current pending assignment whose visitor has not departed.
- Acceptance sets acceptedAt, Visit Accepted and participant OnUP; participant remains ineligible.
- Sale / No-Sale is available for an accepted unfinished turn. Recording it stores outcome/time on Visit and completes Assignment with reason OutcomeRecorded.
- Participant returns once to the bottom of rotation. Completion does not set departedAt; visitor may still be inside.
- Metrics use all current-run visits as denominator and Sale visits as numerator; outcome NoSale does not increment sales.
- Repeated acceptance/same outcome has no repeated effect. Conflicting outcome or invalid transition is rejected; UI refreshes current state.

Dependencies: US-02. Covers UC-05/06/08.

## US-04 - Register visitor departure

As Receptionist, I can mark a visitor's exit and ensure a purchase result is recorded.

Acceptance criteria:

- Mark Exit is available for visits with no departedAt, including Waiting, Assigned, Accepted and Completed service status.
- If outcome is missing, require explicit Sale / No-Sale before committing; otherwise display/preserve the existing result.
- Server sets departedAt to registration time and Visit service status Completed.
- Waiting visitor can depart with zero assignments, with either selected purchase result; never create a fictitious assignment or acceptance.
- Pending assignment closes with reason Departure and no acceptedAt. Active assignment closes with reason Departure retaining acceptedAt. Release participant once and dispatch waiting visitors.
- If service already completed, departure does not touch participant/queue, even if that participant now serves another visitor.
- Duplicate exit preserves original time/result; conflicting purchase result is rejected. Departed visits cannot be assigned/accepted again.

Dependencies: US-02, US-03. Covers UC-12/04/08.

## US-05 - Manage availability and waiting visitors

As Receptionist, I can mark idle associates Off Floor / Available and see Waiting visits handled fairly.

Acceptance criteria:

- Availability controls affect only idle participants. Pending Acceptance and OnUP cannot be marked Off Floor.
- Off Floor removes eligibility; returning Available appends to queue bottom.
- Waiting visits are assigned in server registration order whenever capacity returns, including after outcome/departure.
- All Off Floor and all busy cases retain Waiting visits; UI explains why no assignment occurred.
- Rapid arrivals cannot reserve one participant twice. Partial unique index and command transactions protect one unfinished assignment per participant.
- Availability retry uses original commandId; a delayed replay does not undo a later change or append again.

Dependencies: US-02 through US-04. Covers UC-01/04.

## US-06 - Reset the demonstration

As Receptionist, I can restart the demo with a clean board and initial roster/order.

Acceptance criteria:

- Reset action includes a clear destructive-action confirmation in the product UI; it clears the current demo, not the persistent associate roster.
- One transaction creates a fresh session identity/start time, removes old visits/assignments/activity/receipts, and reseeds participants Available in initial order.
- Browser blocks actions during reset, discards old snapshots, then loads the new board with zero metrics.
- In-flight commands with old sessionId are rejected. Failed reset rolls back; uncertain response is resolved by fetching current session.
- No history/archive UI, attendance workflow or CV controls are added. Future CV callers will need fresh run context, but there is no running CV now.

Dependencies: US-01 through US-05. Covers UC-10.

## Stage 1 definition of done

All six stories work through the real React -> Vercel API -> Supabase path with deterministic seed data. Mock UI alone is frontend review readiness, not end-to-end completion. Run targeted checks for normal path, Waiting/OffFloor, retries/concurrency, all departure states, sale without assignment and reset/stale writes. Provide setup instructions, environment variable names without secrets, migrations and a short demo script. Manual entry is the actual stage feature, not a claim of working CV.

## Deferred workstream

US-07 CV arrival integration and US-08 automatic attributes are deferred without an implementation commitment. Keep stable API/source enums and profile fields for compatibility. Do not create disabled CV panels, fake detections, image-analysis mocks shown as real output, message bus, or extra services. Existing CV interfaces may remain documentation-only until that workstream starts.
