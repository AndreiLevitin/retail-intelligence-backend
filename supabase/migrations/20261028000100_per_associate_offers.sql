-- Corrected Assignment Rotation Revision: per-associate confirmation gate,
-- queue moves at offer time (contract version 3). Supersedes the per-session
-- single-offer gate of 20261027000900_advance_on_acceptance.sql.
--
-- * Each associate holds at most ONE pending offer (accepted_at and
--   completed_at null); different associates may hold offers at the same time.
-- * Dispatch pairs the oldest Waiting visit still inside with the
--   front-of-queue eligible associate (Available, no pending offer of their
--   own), repeatedly, and moves each offered associate to the queue bottom
--   when the offer is created.
-- * Accept no longer moves the queue; it re-dispatches because the associate
--   became eligible again. Outcome and departures never move the queue.
-- * Several accepted unfinished assignments per associate remain valid.

-- 1. Several pending offers for the SAME participant need reconciliation.
--    (Several pending offers for different participants are now normal.)
do $$
declare
  v_report text;
begin
  select string_agg(format('participant %s has %s pending offers', participant_id, n), '; ')
    into v_report
  from (
    select participant_id, count(*) as n
    from public.assignments
    where accepted_at is null and completed_at is null
    group by participant_id
    having count(*) > 1
  ) offending;

  if v_report is not null then
    raise exception 'Rotation migration stopped: %. Reconcile these offers (accept or record departure) before applying.', v_report;
  end if;
end
$$;

-- 2. One pending offer per participant instead of one per session.
drop index public.assignments_one_pending_offer_per_session;
create unique index assignments_one_pending_offer_per_participant
  on public.assignments (participant_id)
  where accepted_at is null and completed_at is null;

-- 3. Dispatcher: offer to every eligible associate in queue order, oldest
--    Waiting visit first, moving each offered associate to the bottom.
create or replace function upb_private.dispatch(p_session_id uuid, p_at timestamptz)
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
      and not exists (
        select 1 from public.assignments g
        where g.participant_id = p.id and g.accepted_at is null and g.completed_at is null)
    order by p.queue_order
    limit 1;
    exit when not found;

    insert into public.assignments (session_id, visit_id, participant_id, assigned_at)
    values (p_session_id, v_visit_id, v_participant_id, p_at)
    returning id into v_assignment_id;

    update public.visits set status = 'Assigned' where id = v_visit_id;

    -- Optimistic rotation: the offered associate goes to the bottom now.
    update public.associate_sessions
    set queue_order = upb_private.next_queue_order(p_session_id)
    where id = v_participant_id;

    perform upb_private.append_activity(
      p_session_id, p_at, 'AssignmentCreated',
      upb_private.visit_label(v_visit_id) || ' offered to '
        || upb_private.participant_name(v_participant_id),
      v_visit_id, v_participant_id, v_assignment_id);

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- 4. Acceptance: milestone only; the queue already moved at offer time.
create or replace function public.upb_accept_assignment(p_session_id uuid, p_assignment_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_session_id uuid;
  v_now        timestamptz;
  v_target     record;
begin
  if p_assignment_id is null then
    perform upb_private.fail('VALIDATION_ERROR', 'assignmentId is required.');
  end if;

  v_session_id := upb_private.lock_current_session(p_session_id);
  v_now := clock_timestamp();

  select g.id, g.visit_id, g.participant_id, g.accepted_at, g.completed_at,
         v.status as visit_status, v.departed_at
    into v_target
  from public.assignments g
  join public.visits v on v.id = g.visit_id
  where g.id = p_assignment_id and g.session_id = v_session_id;

  if not found then
    perform upb_private.fail('NOT_FOUND', 'Assignment not found in the current demo run.');
  end if;

  if v_target.accepted_at is not null then
    return jsonb_build_object(
      'sessionId', v_session_id,
      'assignmentId', v_target.id,
      'phase', case when v_target.completed_at is not null then 'Completed' else 'Accepted' end,
      'replayed', true);
  end if;

  if v_target.completed_at is not null then
    perform upb_private.fail('INVALID_TRANSITION',
      'The visitor departed before this assignment was accepted.');
  end if;

  if v_target.departed_at is not null or v_target.visit_status <> 'Assigned' then
    perform upb_private.fail('INVALID_TRANSITION', 'The visit can no longer be accepted.');
  end if;

  update public.assignments set accepted_at = v_now where id = v_target.id;
  update public.visits set status = 'Accepted' where id = v_target.visit_id;

  perform upb_private.append_activity(
    v_session_id, v_now, 'AssignmentAccepted',
    upb_private.participant_name(v_target.participant_id) || ' accepted '
      || upb_private.visit_label(v_target.visit_id),
    v_target.visit_id, v_target.participant_id, v_target.id);

  -- The associate is eligible again; Waiting visitors may now be offered.
  perform upb_private.dispatch(v_session_id, v_now);

  return jsonb_build_object(
    'sessionId', v_session_id, 'assignmentId', v_target.id, 'phase', 'Accepted', 'replayed', false);
end;
$$;

-- 5. Existing data: owners of pending offers made under the per-session
--    model did not move at offer time; move them to the bottom now (in offer
--    order), then offer Waiting visitors to the associates that are eligible
--    under the per-associate rule. Runs under the control lock.
do $$
declare
  v_offer record;
  v_session_id uuid;
begin
  perform 1 from public.demo_control where id = 1 for update;

  for v_offer in
    select g.session_id, g.participant_id
    from public.assignments g
    where g.accepted_at is null and g.completed_at is null
    order by g.assigned_at
  loop
    update public.associate_sessions
    set queue_order = upb_private.next_queue_order(v_offer.session_id)
    where id = v_offer.participant_id and state = 'Available';
  end loop;

  select c.current_session_id into v_session_id from public.demo_control c where c.id = 1;
  if v_session_id is not null then
    perform upb_private.dispatch(v_session_id, clock_timestamp());
  end if;
end
$$;
