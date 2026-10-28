-- Deterministic predefined roster (fixed IDs and rotation order) and the
-- initial active run. Safe to re-run: existing associates are kept and an
-- existing active demo is never erased.

insert into public.associates (id, display_name, initial_rotation_order) values
  ('a55c0000-0000-4000-8000-000000000001', 'Alex',   1),
  ('a55c0000-0000-4000-8000-000000000002', 'Jamie',  2),
  ('a55c0000-0000-4000-8000-000000000003', 'Morgan', 3)
on conflict (id) do nothing;

select upb_private.ensure_demo_setup();
