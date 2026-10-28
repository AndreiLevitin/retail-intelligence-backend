-- Private helpers shared by the command functions. The upb_private schema is
-- not exposed through PostgREST; only the trusted backend role may execute
-- these, and only indirectly through the public command functions.

create schema upb_private;
revoke all on schema upb_private from public;
grant usage on schema upb_private to service_role;

-- Business-rule failure. MESSAGE carries the stable public code, DETAIL a
-- short public explanation. The gateway maps SQLSTATE P0001 + known code.
create function upb_private.fail(p_code text, p_message text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = p_message;
end;
$$;

-- ISO 8601 UTC with millisecond precision, independent of session TimeZone.
create function upb_private.iso(p_value timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- Lock the stable control row, then validate the caller's run identity.
-- Every mutation calls this first, so all writes (including reset) are
-- serialized and a stale sessionId can never touch the current run.
create function upb_private.lock_current_session(p_session_id uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_current uuid;
begin
  if p_session_id is null then
    perform upb_private.fail('VALIDATION_ERROR', 'sessionId is required.');
  end if;

  select c.current_session_id into v_current
  from public.demo_control c
  where c.id = 1
  for update;

  if not found or v_current is null then
    raise exception 'demo_control is not initialised';
  end if;

  if v_current <> p_session_id then
    perform upb_private.fail('STALE_SESSION', 'The demo run has changed; reload the board.');
  end if;

  return v_current;
end;
$$;

create function upb_private.append_activity(
  p_session_id     uuid,
  p_occurred_at    timestamptz,
  p_kind           text,
  p_description    text,
  p_visit_id       uuid default null,
  p_participant_id uuid default null,
  p_assignment_id  uuid default null
)
returns void
language sql
set search_path = ''
as $$
  insert into public.activity_entries
    (session_id, occurred_at, kind, description, visit_id, participant_id, assignment_id)
  values
    (p_session_id, p_occurred_at, p_kind, p_description, p_visit_id, p_participant_id, p_assignment_id);
$$;

-- Human-readable label: per-run ordinal, never the raw arrival_order token.
create function upb_private.visit_label(p_visit_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select 'Visitor #' || count(*)
  from public.visits v
  join public.visits target on target.id = p_visit_id
  where v.session_id = target.session_id
    and v.arrival_order <= target.arrival_order;
$$;

create function upb_private.participant_name(p_participant_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select a.display_name
  from public.associate_sessions p
  join public.associates a on a.id = p.associate_id
  where p.id = p_participant_id;
$$;

create function upb_private.state_label(p_state text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_state
    when 'OffFloor' then 'Off Floor'
    when 'PendingAcceptance' then 'Pending Acceptance'
    when 'OnUP' then 'On UP'
    else p_state
  end;
$$;

create function upb_private.outcome_label(p_outcome text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_outcome when 'NoSale' then 'No-Sale' else p_outcome end;
$$;

-- Queue append token: one above the current maximum among the run's
-- Available participants (1 for an empty queue). Called under the lock.
create function upb_private.next_queue_order(p_session_id uuid)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(max(p.queue_order), 0) + 1
  from public.associate_sessions p
  where p.session_id = p_session_id
    and p.state = 'Available';
$$;

-- Return a busy participant to the bottom of the rotation (exactly once per
-- unfinished assignment; callers close that assignment in the same step).
create function upb_private.release_participant(p_session_id uuid, p_participant_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.associate_sessions p
  set state = 'Available',
      queue_order = upb_private.next_queue_order(p_session_id)
  where p.id = p_participant_id
    and p.session_id = p_session_id
    and p.state in ('PendingAcceptance', 'OnUP');

  if not found then
    raise exception 'participant % is not busy in session %', p_participant_id, p_session_id;
  end if;
end;
$$;

-- FIFO dispatcher: pair the oldest registered Waiting visit still inside with
-- the first Available participant until either runs out. Returns the number
-- of reservations made. Called under the control lock.
create function upb_private.dispatch(p_session_id uuid, p_at timestamptz)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_visit_id       uuid;
  v_participant_id uuid;
  v_assignment_id  uuid;
  v_count          integer := 0;
begin
  loop
    select v.id into v_visit_id
    from public.visits v
    where v.session_id = p_session_id
      and v.status = 'Waiting'
      and v.departed_at is null
    order by v.arrival_order
    limit 1;
    exit when not found;

    select p.id into v_participant_id
    from public.associate_sessions p
    where p.session_id = p_session_id
      and p.state = 'Available'
    order by p.queue_order
    limit 1;
    exit when not found;

    insert into public.assignments (session_id, visit_id, participant_id, assigned_at)
    values (p_session_id, v_visit_id, v_participant_id, p_at)
    returning id into v_assignment_id;

    update public.visits set status = 'Assigned' where id = v_visit_id;

    update public.associate_sessions
    set state = 'PendingAcceptance', queue_order = null
    where id = v_participant_id;

    perform upb_private.append_activity(
      p_session_id, p_at, 'AssignmentCreated',
      upb_private.visit_label(v_visit_id) || ' assigned to '
        || upb_private.participant_name(v_participant_id),
      v_visit_id, v_participant_id, v_assignment_id);

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Create a fresh run with the whole predefined roster Available in initial
-- rotation order. Does not touch demo_control.
create function upb_private.seed_session()
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_session_id uuid;
begin
  if not exists (select 1 from public.associates) then
    raise exception 'associate roster is empty';
  end if;

  insert into public.demo_sessions (started_at)
  values (clock_timestamp())
  returning id into v_session_id;

  insert into public.associate_sessions (session_id, associate_id, state, queue_order)
  select v_session_id, a.id, 'Available', a.initial_rotation_order
  from public.associates a
  order by a.initial_rotation_order;

  return v_session_id;
end;
$$;

-- Idempotent setup: creates the control row and a first run only when none
-- exists. Re-running it never erases an active demo (reset is the explicit
-- destructive operation). Returns the current session id.
create function upb_private.ensure_demo_setup()
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_current uuid;
begin
  lock table public.demo_control in share row exclusive mode;

  select c.current_session_id into v_current from public.demo_control c where c.id = 1;
  if found then
    if v_current is null then
      raise exception 'demo_control exists without a current session';
    end if;
    return v_current;
  end if;

  v_current := upb_private.seed_session();
  insert into public.demo_control (id, current_session_id) values (1, v_current);
  return v_current;
end;
$$;

revoke all on all functions in schema upb_private from public;
grant execute on all functions in schema upb_private to service_role;
-- Setup is a deployment step, not a backend operation.
revoke execute on function upb_private.ensure_demo_setup() from service_role;
