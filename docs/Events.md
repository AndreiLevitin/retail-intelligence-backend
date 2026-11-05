# Event Decomposition - 2-Day Prototype

Scope authority: [Prototype Scope Decision](Prototype%20Scope%20Decision.md). Use-case references match [Use Cases](Use%20Cases.md).

## Scope notes

- Apply the Perfect Technology Assumption (PTA): CV failures, occlusion, and duplicate detection are not separate business events here. Implementation verification still tests deduplication and recovery.
- The Receptionist operates the prototype; Associate denotes the future business role for acceptance and outcome logging.
- One predefined active demo session and roster replace shift/check-in management.
- No temporal business events are required. Timeout reassignment is deferred.
- The System is the source of internal state events, not an external UML actor.

## Event table

| ID | Event | Type | Source | Resulting Use Case | Brief Description |
|---|---|---|---|---|---|
| E-01 | Receptionist changes idle associate availability | External | Receptionist | UC-01 Set Associate Availability | Switch Available / Off Floor; a return joins the queue bottom |
| E-02 | Receptionist requests the rotation board | External | Receptionist | UC-02 View Rotation Queue | Display states, order, and Next UP |
| E-03 | CV detects an inward entrance crossing | External | Computer Vision System | UC-03 Record Visitor Arrival | Record a visit and attempt assignment |
| E-04 | Receptionist submits a manual arrival form | External | Receptionist | UC-03 Record Visitor Arrival | Record the same visit attributes as CV through a manual form |
| E-05 | A waiting visitor and an Available associate coexist | State | System | UC-04 Assign Associate Automatically | Offer the first Available associate without moving queue order; only when no pending offer exists for the oldest waiting visit; increment assigned count once |
| E-06 | Associate accepts a pending assignment | External | Associate (Receptionist in prototype) | UC-05 Accept Assignment | Mark visit Accepted and retain availability, advance rotation once and attempt next offer |
| E-07 | Associate records Sale or No-Sale | External | Associate (Receptionist in prototype) | UC-06 Log Turn Outcome | Record purchase result on Visit; complete accepted turn; keep rotation unchanged |
| E-08 | Receptionist requests visits and turns | External | Receptionist | UC-07 View Visits and Turns | Display waiting, assigned, accepted, and completed visits |
| E-09 | Receptionist requests demo metrics | External | Receptionist | UC-08 View Demo Metrics | Display counts and visit conversion |
| E-10 | Receptionist requests activity history | External | Receptionist | UC-09 View Activity Log | Display timestamped operational events |
| E-11 | Receptionist resets the demonstration | External | Receptionist | UC-10 Reset Demo | Clear demo activity and restore predefined roster/order with CV paused |
| E-12 | Visitor attributes are provided or corrected | External | CV System / Receptionist | UC-11 Update Visitor Attributes | Apply image analysis or manual profile correction; manual values take precedence |
| E-13 | Receptionist marks visitor exit | External | Receptionist | UC-12 Record Visitor Departure | Register exit and missing purchase result; close unfinished assignment if any |

Manual arrival is a form including visitor attributes, not only a simulation button. Entry and exit are server registration times. Capacity conditions exclude departed visits. Conversion counts Visit.outcome = Sale; sales without assignments are included. SSDs remain deferred.

## State-event interpretation

UC-03 includes an automatic assignment attempt. E-05 describes the internal condition enabling successful assignment, including after availability changes and turn completion; it does not create a second assignment for the arrival. When no associate is Available, retain the visit as Waiting. Reevaluate after acceptance, explicit availability return, or pending departure. Create one offer, then stop until that offer is resolved.

## Deferred events

Shift opening/closing; associate check-in/check-out; manual assignment; assignment decline/cancellation/timeout/reassignment; Open Floor threshold; general visitor administration/removal; automatic exit detection; group detection; journey/zone tracking; authentication administration. Sale / No-Sale is included as E-07.

## Validation status and next step

The original use-case list was reviewed through Gemini Notebook. This revision applies the agreed scope trimming and restores outcome tracking from the sprint plan. It has not yet received a second Notebook review. Continue with fully developed use-case descriptions, activity diagrams, and SSDs, then validate those models before Domain Modeling.

Current rotation condition: the dispatcher creates at most one unresolved offer per session, not a batch. Acceptance advances rotation and triggers the next offer; accepted unfinished assignments do not block future rounds. Outcome/departure do not rotate; pending departure only clears the gate. This supersedes the earlier dispatch-until-capacity-exhausted interpretation.
