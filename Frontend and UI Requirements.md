# Frontend and UI Requirements - Stage 1

Build manual-operation stories US-01 through US-06 in [Prototype Backlog](Prototype%20Backlog.md). Use React from Figma Make; inspect its exported structure before choosing build tooling. No Next.js requirement. Backend is a separate Vercel API; never place SQL, Supabase service credentials or authoritative queue rules inside React.

## 1. Layout and interaction

One responsive operational dashboard for Receptionist, primarily laptop/tablet. Use a readable, compact layout with clear actions and text state labels; do not rely only on color. English UI labels align with current use-case names; wording can be localized later. No multi-page admin/settings/authentication feature set.

Use a conventional enterprise portal shell. Dashboard is the only implemented page. The main content prioritizes visitors; associates are a secondary table, not a separate application section.

| Area | Contents / actions |
|---|---|
| Left sidebar | Dashboard active; Analytics, Company, Support visibly marked Coming soon; no implemented destination or fake navigation |
| Global top bar | Text logo/wordmark, disabled search placeholder and disabled user/avatar placeholder; no search or account functionality |
| Dashboard header | Dashboard title, current demo session start and connection state; Add Visitor primary action, Reset Demo secondary/destructive action |
| Shift summary | Five metric cards: Visitors, Assigned Turns, Accepted Turns, Closed Sales, Conversion Rate; operational label Shift summary refers to the current demo session, not a new shift-management entity |
| Main Visitors table | Appearance (combined upper/lower/accessory), age group, gender, registered entry/exit, assigned associate, service state, presence, purchase outcome and contextual actions; source/secondary details can be in row details |
| Secondary Associates table | Name, state, queuePosition/Next UP, assigned/accepted counts, idle Available / Off Floor actions |
| Activity | Compact collapsible section below both tables, newest first; secondary to operational tables |
| Filters | Visitors: service status and Inside / Left; filters do not change metrics or underlying data |

Desktop default: sidebar left, top bar above workspace; dashboard header then metric strip then full-width Visitors table, Associates table below. Tablet: sidebar collapses, metric cards wrap, tables scroll horizontally within their own containers. Keep the two tables readable instead of squeezing them into equal-width columns. Core actions must remain discoverable without hover.

Use standard table, form, select, dialog, badge and button patterns from the existing Figma Make React export. Do not add another component library when the export already supplies suitable primitives. [UI Design System](UI%20Design%20System.md) specifies a minimal shared visual vocabulary.

No charts, video/image panels, upload controls, CV start button, camera settings, roster CRUD, store/shift administration, or general visitor deletion. Sidebar/search/user placeholders do not add product workflows.

## 2. Forms and controls

| Interaction | Requirements |
|---|---|
| Add Visitor | Upper description, lower description, optional accessory; age select <20 / 20-39 / 40-59 / 60+ / Unknown; gender Female / Male / Unknown; Submit / Cancel. Unknown and empty descriptions are allowed; do not invent attributes. Manual path sets Manual/NotRequested. |
| Edit Attributes | Same profile fields, prefilled. Cannot edit registration times, purchase result or assignment. Manual values are authoritative over future CV estimates. |
| Accept UP | Pending assignment + visitor Inside only; request identifies assignment, not a manually selected associate. |
| Sale / No-Sale | Accepted unfinished turn only. Purchase result belongs to Visit. Completion releases associate but visitor remains Inside. |
| Mark Exit | If result absent, select Sale / No-Sale; if present show it read-only. Commit records server exit time and closes unfinished service where applicable. |
| Availability | Idle participants only. Returning Available joins bottom; no local manual queue sorting. |
| Reset Demo | Confirm that current demo visits/turns/activity will be cleared. Disable mutations until response reconciled and new snapshot loaded. |

Visit service status and physical presence must be shown separately: Completed + Inside is valid. A departed unassigned visitor has purchase result but no associate/turn. Unknown result is displayed as Not recorded, never as No-Sale. Do not infer purchase from presence or status.

## 3. State management and API boundary

BoardService is the frontend contract; see [Design Class Diagram](Design%20Class%20Diagram.md). Use a replaceable MockBoardClient for initial Figma interaction and HttpBoardClient for integration. Both return [Prototype Design](Prototype%20Design.md) DTOs. UI components depend on BoardService, not Supabase SDK or database rows.

Poll GET /api/board every 2 seconds with one request in flight. Refresh after mutation; do not rotate/increment authoritative state optimistically. Disable the affected action while pending; after timeout reconcile and retain original eventId/commandId for retries. Discard stale snapshots after newer actions/reset. Display last known board with an offline/stale indicator during network failures, then recover on successful refresh. Display API errors as short messages with a retry path, not SQL details.

Operator token can be supplied once through a small connect prompt and held in memory; it is not a new account/login system. Use same-origin /api paths. Never hardcode production secrets in Figma output or frontend build variables.

## 4. Mock scenarios for frontend review

Use a predefined roster of three associates and deterministic scenarios: empty run; normal pending turn; accepted turn; Completed but Inside; Waiting with all Off Floor/busy; departed without assignment; departed after completion; temporary API failure; reset. Mock state follows the same transitions as the real backend but is isolated in MockBoardClient, not scattered through components. Mark mock mode visibly during review; deployment must not silently fall back to mock data after a real API error.

## 5. Figma Make starting prompt

Copy the following prompt and provide this requirements document plus the DTO table from Prototype Design when available:

> Build a React.js + TypeScript prototype called Digital UP Board for a retail receptionist. Use a conventional enterprise portal shell, standard UI primitives, and the supplied minimal UI Design System. Sidebar: Dashboard active, Analytics/Company/Support disabled with Coming soon labels. Global top bar: text logo, disabled search placeholder, disabled user/avatar placeholder. Dashboard workspace: title, current demo session start, connection state, Add Visitor primary action and Reset Demo secondary action; five Shift summary cards (Visitors, Assigned Turns, Accepted Turns, Closed Sales, Conversion Rate); primary full-width Visitors table; secondary Associates table below; compact collapsible activity log last. Shift summary is only a display label for the demo session. Visitors show appearance, age/gender, entry/exit registration times, assigned associate, separate service/presence/purchase state and contextual actions. Associates show Next UP/queue order, state and turn counts. Add Visitor/Edit Attributes forms use upper/lower clothing, optional accessory, age (<20, 20-39, 40-59, 60+, Unknown), gender (Female/Male/Unknown). Support Accept UP, Sale/No-Sale, Mark Exit, idle availability changes, and reset confirmation. Completed service can still be Inside. Exit asks for a missing outcome or preserves an existing one; a Waiting visitor can leave without assignment. Build only manual stories US-01 through US-06. Use reusable shell, tables, forms and status badges; a typed BoardService with an isolated MockBoardClient; no business rules in row components. Include loading, empty, mutation-pending, error and offline states. Keep standard React export structure; no mandatory Next.js. Reuse existing primitives rather than add a second library. No Supabase credentials, CV/image/video features, working search/accounts/sidebar pages, charts or additional CRUD. Mark mock mode explicitly. Use responsive laptop/tablet layout with collapsible sidebar and locally scrollable tables. Make row actions visible and keyboard accessible.

## 6. Frontend delivery

React source plus startup instructions, service boundary/types, mock scenarios, explicit list of remaining API integration work. Then replace the mock adapter with HTTP without redesigning screens. Cross-check US-01 through US-06 acceptance criteria; appearance polish must not replace missing action/state behavior.

## 7. React development principles

- React.js with TypeScript; functional components and hooks. Preserve Figma Make export tooling and dependencies where reasonable; do not introduce Next.js or another framework by default.
- Keep AppShell, Sidebar, TopBar, DashboardPage, MetricCard, VisitorsTable, AssociatesTable, ActivityLog and shared forms small and focused. One VisitorForm serves creation/edit profile with explicit modes; do not expose lifecycle fields as editable profile inputs.
- Put DTOs, enum/label maps, API clients and mock implementation outside presentation components. Use one board hook for fetching/polling/mutation state and call BoardService through it. Avoid a global state library unless an actual need appears.
- Reuse common Button, Field, Select, Dialog, StatusBadge and table primitives. Define visual tokens once; do not repeat hardcoded colors and spacing throughout rows.
- Use stable IDs as React keys; do not derive authoritative counters/rotation from mutable UI state. No direct Supabase dependency in the UI.
- Distinguish internal code values from labels through shared maps. Unknown demographic/result values remain explicit. Provide labels, visible focus, keyboard dialog behavior and accessible button names.
- Build working manual flows before polish. Verify meaningful story scenarios; no snapshot-only test suite or extra architecture scaffolding for this reversible prototype UI.
