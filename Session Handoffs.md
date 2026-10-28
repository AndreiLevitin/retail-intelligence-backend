# Session Handoffs - Stage 1

Current user instruction: implement only manual stories 1-6. CV is a separate later workstream; do not spend time on inference research, technical spikes, model setup or image processing now. Start here in each new session. [Prototype Backlog](Prototype%20Backlog.md) is the acceptance checklist and current execution scope; older full-scope CV implementation-order suggestions are deferred.

## Frontend / Claude session

Read [Frontend and UI Requirements](Frontend%20and%20UI%20Requirements.md), [Prototype Backlog](Prototype%20Backlog.md), DTOs in [Prototype Design](Prototype%20Design.md) and [Use Cases](Use%20Cases.md). Use the included Claude implementation task and [UI Design System](UI%20Design%20System.md). Portal shell: sidebar/top bar, shift metrics, primary Visitors table, secondary Associates table; navigation/search/user placeholders are nonfunctional. Build the React UI and an isolated mock adapter, then connect it to the real API when available. Create the frontend directly from requirements and reuse existing tooling where suitable; no mandatory Next.js. Do not connect to Supabase directly or scatter mock state through components. First review the board, manual arrival, outcome/exit forms and all state combinations.

Suggested starting instruction:

> Implement Stage 1 frontend stories US-01 through US-06 using Analysis and Design/Frontend and UI Requirements.md and Prototype Backlog.md. Read the API DTOs and state rules before editing. You are creating the React.js + TypeScript app directly from requirements; no UI mockups or design-tool exports will be supplied. Inspect the workspace first, then implement a minimal project if no app exists. Start with a replaceable mock BoardService, keep API integration explicit, and do not implement CV or Next.js.

## Backend session

Read [Backend Requirements](Backend%20Requirements.md), [Database Design](Database%20Design.md), [Prototype Design](Prototype%20Design.md), [Domain Model](Domain%20Model.md), [Use Cases](Use%20Cases.md) and [State Transition Consistency](State%20Transition%20Consistency.md). Build migrations/RPCs and the Vercel API for manual stories. Purchase outcome belongs to Visit, never Assignment. Match DTOs rather than exposing raw rows. Backend Requirements section 6 contains the reviewed request, replay and error contracts; read it before implementation. No account system, broker or CV work.

Suggested starting instruction:

> Implement Stage 1 backend for US-01 through US-06 from Analysis and Design/Backend Requirements.md and Prototype Backlog.md. Inspect the workspace and existing app structure first. Implement Supabase migrations/seed/atomic RPCs and separate Vercel Functions with explicit DTOs; verify concurrency, retries, departure and reset. No Next.js, CV inference, image upload or extra services. Use Backend Requirements section 6 for concrete payloads, error codes, replay precedence and ownership. Do not change React UI or overwrite frontend package work; report shared/root configuration changes. Report any contract change before allowing frontend/backend to diverge.

## Manual end-to-end integration

Once both parts exist, connect HttpBoardClient, verify real API failures never silently switch to mocks, and run all six stories against seeded data. Suggested demo: open board -> add visitor -> Accept -> Sale -> mark exit -> mark associates Off Floor -> add Waiting visitor -> restore capacity -> reset. Also explicitly test departure without assignment and departure after an associate has started another turn.

## Later CV session - not started

Retain EntranceDetector, VisitorAttributeAnalyzer and ArrivalSink design contracts only. The image-retention and enrichment-timing assumptions are not separately confirmed; resolve them when this workstream starts. No current milestone depends on automatic arrival or attribute inference.

## Handoff discipline

Record actual files changed, commands/checks and results, open failures, API changes and next concrete step in each implementation session. Read the workspace's current source before assuming this planning document reflects completed code. These documents are specifications; no application code or cloud provisioning has been performed in this planning session.

Backend task preflight: [Backend Task Review](Backend%20Task%20Review.md) records resolved ambiguities and remaining environment inputs. This is a specification review, not a claim that backend code or integration tests already exist.
