# Backend Task Review - Stage 1

Result: task is sufficiently specified to start implementation of manual stories US-01 through US-06. No backend source, SQL migrations, cloud provisioning or database test execution is claimed by this review. Read [Backend Requirements](Backend%20Requirements.md), particularly section 6, as the implementation task.

## Findings resolved in the specification

| Gap / ambiguity | Resolution |
|---|---|
| Frontend assumed a generated design export | Claude builds React directly from written requirements; no export blocker |
| Future CV examples could leak into Stage 1 | Reject CV source/non-null detectedAt; no inference/image work or CV credentials needed |
| Endpoint request bodies were scattered | Exact eight implemented endpoint bodies/results listed in Backend Requirements |
| Token transport unspecified | Authorization Bearer, operator token only for Stage 1 |
| Replay after lifecycle changes ambiguous | Receipt lookup precedes availability-state validation; acceptance/outcome replay rules distinguish accepted vs early-departure completion |
| Exit result omission/conflict | Preserve stored result, require missing selection, reject conflicting replacement, never release twice |
| Editable profile fields/limits unclear | Full profile replacement, explicit enums, trim, 200-character fields, manual provenance; no lifecycle writes |
| Manual payload could claim CV provenance | API/SQL reject unsupported Stage 1 source/provenance |
| No-op availability could rotate queue | No queue/activity change; save receipt |
| Seed and queue sequence could disagree | Allocate max eligible queue_order + 1 under the common lock; no separate queue sequence |
| Session ID naming could diverge | SessionContext consistently uses sessionId |
| Error responses lacked stable codes | HTTP/code table including 405 and sanitized unexpected 500 |
| Aggregate join could inflate metrics | Independent aggregation of visits, assignments and activity before snapshot |
| Bigint/numeric serialization unspecified | Counts and conversion are JSON numbers |
| Activity double-counting | Exact seven kinds and completion/exit/no-op behavior specified |
| Concurrent sessions could overwrite setup | Backend/frontend ownership and root/shared contract handoff defined |
| Testing without real DB could be misreported | Require real disposable-db integration evidence; report unavailable checks explicitly |

## Scope and domain correspondence

Eight Stage 1 HTTP endpoints cover all twelve modeled use cases. UC-04 is internal automatic dispatch; read endpoints combine UC-02/07/08/09. UC-11 is manual profile editing only in this stage. UC-12 includes result selection and early departure. No public assign/reassign endpoint is introduced.

Six domain entities map to the six business tables. demo_control and command_receipts are technical implementation records, not new user stories. Purchase outcome remains only on Visit. Assignment records timestamps and completionReason; Departure can close pending service without acceptance. Inside/Left remains derived independently from departedAt.

## Environment inputs deferred to implementation

- Actual repository/app/package structure: inspect workspace rather than assume a generated frontend.
- Supabase local CLI/container availability or explicitly provided disposable test project/credentials.
- Runtime/package versions and lockfile: choose compatible supported versions during scaffolding.
- Deployment target/project credentials: not needed for this requirements review and not implicitly provisioned.

These are implementation setup inputs, not unresolved business rules. Do not block writing reviewable source on missing production credentials; distinguish completed static checks from integration evidence. No further product-choice question is required for Stage 1.
