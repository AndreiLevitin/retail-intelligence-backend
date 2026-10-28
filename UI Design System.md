# Minimal UI Design System - Stage 1

A small implementation guide, not a separate design-system project. Use shared tokens and primitives in the existing React export. No custom illustration/icon library, dark theme, multi-brand system, or separate package is needed.

## 1. Visual tokens

| Token | Initial value / rule |
|---|---|
| Font | System sans-serif; one family |
| Text | Body/table 14px; labels 12px; section titles 18px; page title 24px; metrics 24px |
| Spacing | 4px base; use 4, 8, 12, 16, 24, 32px |
| Page background | #F8FAFC |
| Surface | #FFFFFF |
| Main text / muted text | #0F172A / #475569 |
| Border | #E2E8F0; 1px |
| Primary action / focus | #1D4ED8; white action text; visible focus outline |
| Success / warning / danger text | #166534 / #92400E / #B91C1C with light tinted backgrounds |
| Radius | 6px controls; 8px panels/dialogs |
| Controls | About 40px tall; touch targets at least 44px where used on tablet |
| Table rows | About 48px minimum; allow wrapped appearance text |
| Sidebar | About 224px desktop; collapsed/drawer on tablet |
| Workspace | 24px desktop padding; 16px tablet; flexible width |

Treat these as coherent starting values. Reuse accessible variants from existing primitives; verify text/focus contrast in the actual generated UI instead of assuming token choices guarantee accessibility.

## 2. Primitives

| Component | Variants / behavior |
|---|---|
| Button | Primary, Secondary, Destructive, Text; focus/disabled/pending states; text labels on key actions |
| FormField | Label, optional hint, inline error; required/optional semantics explicit |
| Select | Standard control; explicit Unknown option for demographics |
| Dialog | Create/edit profile, record exit, reset confirmation; labeled title, keyboard close, focus management |
| StatusBadge | Text plus semantic tint; never color-only |
| DataTable | Header, stable rows, empty/loading/error state, visible action cell, local horizontal overflow |
| MetricCard | Label, formatted numeric value; display-only |
| ConnectionIndicator | Connected / Updating / Offline; last known data remains visible |
| Notice | Short error/success/warning; retry where appropriate |

## 3. Status vocabulary

Service: Waiting (amber), Assigned (blue), Accepted (blue), Completed (neutral). Presence: Inside / Left as separate labels. Purchase: Sale (green), No-Sale (neutral), Not recorded (muted). Associate: Available (green), Off Floor (neutral), Pending Acceptance (amber), On UP (blue). Failed command uses red notice; No-Sale is a normal outcome, not an application error.

Render a description such as upper / lower / accessory by joining only known nonempty parts. Use Description not provided if no description exists. Do not substitute a demographic guess for Unknown.

## 4. Layout and interaction rules

The operational hierarchy is Shift summary -> Visitors table -> Associates table -> Activity. No large hero, promotional content, decorative charts or equal-weight unrelated cards. Add Visitor is the main global action. Accept/outcome/exit/profile actions remain contextual to their visit/assignment. Visitors default to server registration order; user filters affect presentation only. Use timestamps localized for display; the backend remains UTC.

Sidebar entries Analytics, Company and Support, top search, and user placeholder are nonfunctional and visually identified as unavailable. No fabricated profile menu or account settings. Logo is a text wordmark until an actual asset is supplied.

## 5. Done for this prototype

One token definition, one set of reused primitives, consistent table/action/status patterns and a responsive portal shell are sufficient. UI specification takes precedence over visual novelty. See [Frontend and UI Requirements](Frontend%20and%20UI%20Requirements.md) and [Prototype Backlog](Prototype%20Backlog.md) for behavior.
