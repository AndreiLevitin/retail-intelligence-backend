# State Transition Consistency

Aligned with [Use Cases](Use%20Cases.md) and [Domain Model](Domain%20Model.md). See [Visit](Visit%20State%20Machine%20Diagram.md), [AssociateSession](AssociateSession%20State%20Machine%20Diagram.md), [Assignment](Assignment%20State%20Machine%20Diagram.md).

| Event | Visit | Assignment | AssociateSession | Side effects |
|---|---|---|---|---|
| UC-03 Arrival | Create Waiting, registered entry time and attributes | None | No change | Log arrival; attempt FIFO assignment |
| UC-04 Reserve | Waiting -> Assigned; must have no departedAt | Create Pending Acceptance | Available -> Pending Acceptance | Remove eligibility; log assignment |
| UC-05 Accept | Assigned -> Accepted; inside | Set acceptedAt | Pending Acceptance -> On UP | Log acceptance once |
| UC-06 Outcome | Accepted -> Completed; save outcome/time on Visit; still inside | Complete with reason OutcomeRecorded | On UP -> Available | Append to bottom; log completion; dispatch; derive sales from visits |
| UC-11 Attributes | Update descriptions/demographics/provenance | No change | No change | Preserve manual override; log actual changes |
| UC-12 Exit while Waiting | Waiting -> Completed; set departedAt and selected outcome | None; do not create | No change | Log exit; no assigned/accepted increment |
| UC-12 Exit while Assigned | Assigned -> Completed; set exit/outcome | Complete pending with reason Departure, no acceptedAt | Pending Acceptance -> Available | Release once; log completion/exit; dispatch |
| UC-12 Exit while Accepted | Accepted -> Completed; set exit/outcome | Complete accepted with reason Departure | On UP -> Available | Release once; log completion/exit; dispatch |
| UC-12 Exit after Completed | Preserve outcome; set departedAt only | Preserve completed record | No change | Never release participant again; log exit once |
| UC-01 Availability | No visit change | No unfinished assignment allowed | Available <-> Off Floor | Update FIFO eligibility; dispatch on return |
| UC-10 Reset | Delete old-run visits | Delete old assignments | Reseed new run | Clear activity/receipts; pause CV and reject stale writes |

Outcome is required on departure, but may already exist from UC-06; preserve it. A visitor can purchase without an assignment, so conversion uses Visit.outcome. Service and presence are independent. Every mutation uses one transaction; duplicate writes do not repeat milestones/activity/release. Early departure does not count as acceptance. Attribute processing is independent of queue and physical presence; late old-run writes are rejected.

Associate and ActivityEntry need no changing lifecycle model. DemoSession remains replaced on reset without historical close workflow. Profile processing status is a small technical attribute, not a new business entity/state machine for the sprint. Analysis drafts require stakeholder validation; SSDs remain deferred.
