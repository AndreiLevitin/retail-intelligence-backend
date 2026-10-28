-- UC-10 Reset Demo (US-06). One transaction under the control lock:
-- validate the caller's run, delete its operational records in dependency
-- order, create a fresh run with the roster Available in initial order and
-- point demo_control at it. The predefined associates are preserved. Any
-- failure rolls back the whole reset. A delayed reset carrying the old
-- sessionId fails with STALE_SESSION instead of erasing the newer run.

create function public.upb_reset_demo(p_session_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_old_session_id uuid;
  v_new_session_id uuid;
  v_started_at     timestamptz;
begin
  v_old_session_id := upb_private.lock_current_session(p_session_id);

  update public.demo_control set current_session_id = null where id = 1;

  delete from public.command_receipts   where session_id = v_old_session_id;
  delete from public.activity_entries   where session_id = v_old_session_id;
  delete from public.assignments        where session_id = v_old_session_id;
  delete from public.visits             where session_id = v_old_session_id;
  delete from public.associate_sessions where session_id = v_old_session_id;
  delete from public.demo_sessions      where id = v_old_session_id;

  v_new_session_id := upb_private.seed_session();
  update public.demo_control set current_session_id = v_new_session_id where id = 1;

  select s.started_at into v_started_at from public.demo_sessions s where s.id = v_new_session_id;

  return jsonb_build_object(
    'sessionId', v_new_session_id, 'startedAt', upb_private.iso(v_started_at));
end;
$$;

revoke all on function public.upb_reset_demo(uuid) from public, anon, authenticated;
grant execute on function public.upb_reset_demo(uuid) to service_role;
