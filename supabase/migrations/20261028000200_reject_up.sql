-- Reject UP (BR-06 Accept-or-Decline; contract version 4).
--
-- * A still-pending offer can be rejected: completed_at + completion_reason
--   'Rejected', no acceptance, no queue movement (the associate moved when
--   offered). The Visit returns to Waiting at its original registration
--   order, and dispatch runs immediately - it may offer the same visit to
--   the same associate again if nobody else is eligible.
-- * A visit may therefore accumulate rejected offers as history. At most one
--   NON-rejected assignment per visit remains the rule.
-- * New activity kind AssignmentRejected.

-- 1. Completion reason Rejected; rejected offers were never accepted.
do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  where c.conrelid = 'public.assignments'::regclass and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%Departure%';
  if v_name is null then
    raise exception 'assignments completion_reason value check not found';
  end if;
  execute format('alter table public.assignments drop constraint %I', v_name);
end
$$;

alter table public.assignments
  add constraint assignments_completion_reason_values
    check (completion_reason in ('OutcomeRecorded', 'Departure', 'Rejected')),
  add constraint assignments_rejected_not_accepted
    check (completion_reason is distinct from 'Rejected' or accepted_at is null);

-- 2. One live (non-rejected) assignment per visit instead of one assignment
--    per visit.
do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  where c.conrelid = 'public.assignments'::regclass and c.contype = 'u'
    and c.conkey = array[(select attnum from pg_attribute
                          where attrelid = 'public.assignments'::regclass and attname = 'visit_id')]::int2[];
  if v_name is null then
    raise exception 'assignments unique(visit_id) constraint not found';
  end if;
  execute format('alter table public.assignments drop constraint %I', v_name);
end
$$;

create unique index assignments_one_live_per_visit
  on public.assignments (visit_id)
  where completion_reason is distinct from 'Rejected';
create index assignments_visit_idx on public.assignments (visit_id);

-- 3. Activity kind AssignmentRejected.
do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  where c.conrelid = 'public.activity_entries'::regclass and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%ArrivalRecorded%';
  if v_name is null then
    raise exception 'activity_entries kind check not found';
  end if;
  execute format('alter table public.activity_entries drop constraint %I', v_name);
end
$$;

alter table public.activity_entries
  add constraint activity_entries_kind_values check (kind in (
    'ArrivalRecorded', 'AssignmentCreated', 'AssignmentAccepted', 'AssignmentRejected',
    'TurnCompleted', 'AvailabilityChanged', 'VisitorAttributesUpdated', 'VisitorDeparted'));

-- 4. Board: VisitView.assignmentId ignores rejected offers (null while
--    Waiting); assignments[] lists every offer, rejected ones included.
create or replace function public.upb_get_board()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with ctl as (
    select s.id as session_id, s.started_at
    from public.demo_control c
    join public.demo_sessions s on s.id = c.current_session_id
    where c.id = 1
  ),
  participant as (
    select p.id, p.associate_id, a.display_name, a.initial_rotation_order, p.state,
           case when p.state = 'Available' then
             row_number() over (partition by p.state = 'Available' order by p.queue_order)
           end as queue_position
    from public.associate_sessions p
    join ctl on ctl.session_id = p.session_id
    join public.associates a on a.id = p.associate_id
  ),
  assignment as (
    select g.id, g.visit_id, g.participant_id, g.assigned_at, g.accepted_at, g.completed_at,
           g.completion_reason, v.arrival_order
    from public.assignments g
    join ctl on ctl.session_id = g.session_id
    join public.visits v on v.id = g.visit_id
  ),
  turn_count as (
    select participant_id,
           count(*) as assigned,
           count(accepted_at) as accepted,
           coalesce(jsonb_agg(id order by arrival_order)
                    filter (where accepted_at is not null and completed_at is null), '[]'::jsonb) as active_ids,
           count(*) filter (where accepted_at is not null and completed_at is null) as active,
           (array_agg(id) filter (where accepted_at is null and completed_at is null))[1] as pending_id
    from assignment
    group by participant_id
  ),
  visit as (
    select v.*,
           case when v.status = 'Waiting' and v.departed_at is null then
             row_number() over (partition by v.status = 'Waiting' and v.departed_at is null
                                order by v.arrival_order)
           end as waiting_position
    from public.visits v
    join ctl on ctl.session_id = v.session_id
  ),
  recent_activity as (
    select e.*
    from public.activity_entries e
    join ctl on ctl.session_id = e.session_id
    order by e.activity_order desc
    limit 100
  ),
  visit_totals as (
    select count(*) as visitors, count(*) filter (where outcome = 'Sale') as sales from visit
  ),
  assignment_totals as (
    select count(*) as assigned, count(accepted_at) as accepted from assignment
  )
  select jsonb_build_object(
    'session', jsonb_build_object(
      'sessionId', ctl.session_id,
      'startedAt', upb_private.iso(ctl.started_at)),
    'associates', coalesce((
      select jsonb_agg(jsonb_build_object(
          'participantId', p.id,
          'associateId', p.associate_id,
          'displayName', p.display_name,
          'state', p.state,
          'queuePosition', p.queue_position,
          'pendingAssignmentId', tc.pending_id,
          'activeAssignmentIds', coalesce(tc.active_ids, '[]'::jsonb),
          'activeTurns', coalesce(tc.active, 0),
          'assignedTurns', coalesce(tc.assigned, 0),
          'acceptedTurns', coalesce(tc.accepted, 0))
        order by p.initial_rotation_order)
      from participant p
      left join turn_count tc on tc.participant_id = p.id), '[]'::jsonb),
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
          'visitId', v.id,
          'arrivedAt', upb_private.iso(v.arrived_at),
          'detectedAt', upb_private.iso(v.detected_at),
          'departedAt', upb_private.iso(v.departed_at),
          'source', v.source,
          'status', v.status,
          'attributes', jsonb_build_object(
            'upperDescription', v.upper_description,
            'lowerDescription', v.lower_description,
            'accessoryDescription', v.accessory_description,
            'ageGroup', v.age_group,
            'gender', v.gender),
          'attributesSource', v.attributes_source,
          'enrichmentStatus', v.enrichment_status,
          'outcome', v.outcome,
          'outcomeRecordedAt', upb_private.iso(v.outcome_recorded_at),
          'waitingPosition', v.waiting_position,
          'assignmentId', (select g.id from assignment g
                           where g.visit_id = v.id and g.completion_reason is distinct from 'Rejected'))
        order by v.arrival_order)
      from visit v), '[]'::jsonb),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
          'assignmentId', g.id,
          'visitId', g.visit_id,
          'participantId', g.participant_id,
          'phase', case
            when g.completed_at is not null then 'Completed'
            when g.accepted_at is not null then 'Accepted'
            else 'PendingAcceptance' end,
          'assignedAt', upb_private.iso(g.assigned_at),
          'acceptedAt', upb_private.iso(g.accepted_at),
          'completedAt', upb_private.iso(g.completed_at),
          'completionReason', g.completion_reason)
        order by g.arrival_order, g.assigned_at)
      from assignment g), '[]'::jsonb),
    'metrics', (
      select jsonb_build_object(
        'visitors', vt.visitors,
        'assignedTurns', agt.assigned,
        'acceptedTurns', agt.accepted,
        'closedSales', vt.sales,
        'conversionRate', case when vt.visitors = 0 then 0
                               else (vt.sales * 100.0 / vt.visitors)::double precision end)
      from visit_totals vt, assignment_totals agt),
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object(
          'activityId', e.id,
          'occurredAt', upb_private.iso(e.occurred_at),
          'kind', e.kind,
          'description', e.description,
          'visitId', e.visit_id,
          'participantId', e.participant_id,
          'assignmentId', e.assignment_id)
        order by e.activity_order desc)
      from recent_activity e), '[]'::jsonb),
    'serverTime', upb_private.iso(now()))
  from ctl;
$$;

-- 5. Departure considers only the visit's non-rejected assignment.
create or replace function public.upb_record_departure(p_session_id uuid, p_visit_id uuid, p_outcome text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_session_id uuid;
  v_now        timestamptz;
  v_visit      record;
  v_outcome    text;
  v_closed     boolean := false;
  v_was_offer  boolean := false;
begin
  if p_visit_id is null then
    perform upb_private.fail('VALIDATION_ERROR', 'visitId is required.');
  end if;
  if p_outcome is not null and p_outcome not in ('Sale', 'NoSale') then
    perform upb_private.fail('VALIDATION_ERROR', 'outcome must be Sale or NoSale.');
  end if;

  v_session_id := upb_private.lock_current_session(p_session_id);
  v_now := clock_timestamp();

  select v.id, v.departed_at, v.outcome,
         g.id as assignment_id, g.participant_id, g.accepted_at,
         g.completed_at as assignment_completed_at
    into v_visit
  from public.visits v
  left join public.assignments g
    on g.visit_id = v.id and g.completion_reason is distinct from 'Rejected'
  where v.id = p_visit_id and v.session_id = v_session_id;

  if not found then
    perform upb_private.fail('NOT_FOUND', 'Visit not found in the current demo run.');
  end if;

  if v_visit.departed_at is not null then
    if p_outcome is not null and p_outcome <> v_visit.outcome then
      perform upb_private.fail('OUTCOME_CONFLICT', 'A different purchase result is already recorded.');
    end if;
    return jsonb_build_object(
      'sessionId', v_session_id, 'visitId', v_visit.id,
      'departedAt', upb_private.iso(v_visit.departed_at), 'outcome', v_visit.outcome, 'replayed', true);
  end if;

  if v_visit.outcome is not null then
    if p_outcome is not null and p_outcome <> v_visit.outcome then
      perform upb_private.fail('OUTCOME_CONFLICT', 'A different purchase result is already recorded.');
    end if;
    v_outcome := v_visit.outcome;
  elsif p_outcome is null then
    perform upb_private.fail('OUTCOME_REQUIRED',
      'Select Sale or NoSale: this visit has no purchase result yet.');
  else
    v_outcome := p_outcome;
  end if;

  if v_visit.assignment_id is not null and v_visit.assignment_completed_at is null then
    update public.assignments
    set completed_at = v_now, completion_reason = 'Departure'
    where id = v_visit.assignment_id;
    v_closed := true;
    v_was_offer := v_visit.accepted_at is null;
  end if;

  update public.visits
  set departed_at = v_now,
      status = 'Completed',
      outcome = v_outcome,
      outcome_recorded_at = coalesce(outcome_recorded_at, v_now)
  where id = v_visit.id;

  perform upb_private.append_activity(
    v_session_id, v_now, 'VisitorDeparted',
    upb_private.visit_label(v_visit.id) || ' left the store: ' || upb_private.outcome_label(v_outcome),
    v_visit.id,
    case when v_closed then v_visit.participant_id end,
    case when v_closed then v_visit.assignment_id end);

  if v_closed then
    perform upb_private.append_activity(
      v_session_id, v_now, 'TurnCompleted',
      case when v_was_offer
        then 'Offer of ' || upb_private.visit_label(v_visit.id) || ' to '
               || upb_private.participant_name(v_visit.participant_id)
               || ' closed by departure (turn not consumed)'
        else upb_private.participant_name(v_visit.participant_id) || '''s turn with '
               || upb_private.visit_label(v_visit.id) || ' closed by departure'
      end,
      v_visit.id, v_visit.participant_id, v_visit.assignment_id);
  end if;

  if v_was_offer then
    perform upb_private.dispatch(v_session_id, v_now);
  end if;

  return jsonb_build_object(
    'sessionId', v_session_id, 'visitId', v_visit.id,
    'departedAt', upb_private.iso(v_now), 'outcome', v_outcome, 'replayed', false);
end;
$$;

-- 6. Accepting a rejected offer explains itself.
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

  select g.id, g.visit_id, g.participant_id, g.accepted_at, g.completed_at, g.completion_reason,
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
      case when v_target.completion_reason = 'Rejected'
        then 'This offer was rejected; it cannot be accepted.'
        else 'The visitor departed before this assignment was accepted.' end);
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

-- 7. Reject a pending offer. Natural idempotency by state: a closed offer
--    (rejected, departed) replays with the visit's current status; an
--    accepted offer can never be rejected.
create function public.upb_reject_assignment(p_session_id uuid, p_assignment_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_session_id uuid;
  v_now        timestamptz;
  v_target     record;
  v_status     text;
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
    perform upb_private.fail('INVALID_TRANSITION', 'An accepted assignment cannot be rejected.');
  end if;

  if v_target.completed_at is not null then
    return jsonb_build_object(
      'sessionId', v_session_id, 'assignmentId', v_target.id, 'visitId', v_target.visit_id,
      'status', v_target.visit_status, 'replayed', true);
  end if;

  if v_target.departed_at is not null or v_target.visit_status <> 'Assigned' then
    raise exception 'pending assignment % has a visit in status % / departed', v_target.id, v_target.visit_status;
  end if;

  update public.assignments
  set completed_at = v_now, completion_reason = 'Rejected'
  where id = v_target.id;

  -- Back to Waiting at the original registration order (arrival_order unchanged).
  update public.visits set status = 'Waiting' where id = v_target.visit_id;

  perform upb_private.append_activity(
    v_session_id, v_now, 'AssignmentRejected',
    upb_private.participant_name(v_target.participant_id) || ' rejected '
      || upb_private.visit_label(v_target.visit_id),
    v_target.visit_id, v_target.participant_id, v_target.id);

  perform upb_private.dispatch(v_session_id, v_now);

  select v.status into v_status from public.visits v where v.id = v_target.visit_id;
  return jsonb_build_object(
    'sessionId', v_session_id, 'assignmentId', v_target.id, 'visitId', v_target.visit_id,
    'status', v_status, 'replayed', false);
end;
$$;

revoke all on function public.upb_reject_assignment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.upb_reject_assignment(uuid, uuid) to service_role;
