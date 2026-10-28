-- Seed for `supabase db reset` and manual setup. The roster itself is
-- reference data created by migration 20261027000300_roster_setup.sql; this
-- file only guarantees the control row and an active run exist. It is
-- idempotent and never erases an active demo - use POST /api/demo/reset
-- (or public.upb_reset_demo) for a destructive restart.

select upb_private.ensure_demo_setup();
