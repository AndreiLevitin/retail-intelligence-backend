# Digital UP Board - Stage 1 backend

Proof of concept for registering store visitors and distributing them between
sales associates (manual stories US-01 through US-06; computer vision is a
separate, later workstream).

Workspace layout (sibling folders under `RetailIntelligence/`):

- `../*.md` - shared analysis and design specifications (not tracked in this
  repository). Start with `Session Handoffs.md` and `Backend Requirements.md`
  (section 6).
- `../retail-intelligence-frontend/` - React + TypeScript UI, separate repository.
- `./` (this repository) - backend.

Architecture: Vercel Functions (HTTP, access check, validation, error mapping)
-> `WorkflowStore` / `SupabaseGateway` (TypeScript) -> Supabase PostgreSQL
(tables, constraints and atomic SQL command functions in `supabase/migrations/`).

Setup and run instructions are added as the implementation lands.
