-- Reject UP correction (user-confirmed; contract version 5): a visit is
-- never offered to the associate who rejected it LAST. The exclusion is per
-- visit, derived from the rejected-offer history, and lasts until someone
-- else rejects that visit. The rejecter stays eligible for other visitors.
-- Dispatch pairs the oldest Waiting visit that has a non-excluded eligible
-- associate, so a rejected visit keeps its FIFO place and is skipped only
-- for that associate.

-- 1. Dispatcher.
create or replace function upb_private.dispatch(p_session_id uuid, p_at timestamptz)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_pair           record;
  v_assignment_id  uuid;
  v_count          integer := 0;
begin
  loop
    select v.id as visit_id, candidate.id as participant_id
      into v_pair
    from public.visits v
    cross join lateral (
      select p.id
      from public.associate_sessions p
      where p.session_id = p_session_id
        and p.state = 'Available'
        and not exists (
          select 1 from public.assignments g
          where g.participant_id = p.id and g.accepted_at is null and g.completed_at is null)
        and p.id is distinct from (
          select r.participant_id
          from public.assignments r
          where r.visit_id = v.id and r.completion_reason = 'Rejected'
          order by r.completed_at desc
          limit 1)
      order by p.queue_order
      limit 1
    ) candidate
    where v.session_id = p_session_id
      and v.status = 'Waiting'
      and v.departed_at is null
    order by v.arrival_order
    limit 1;
    exit when not found;

    insert into public.assignments (session_id, visit_id, participant_id, assigned_at)
    values (p_session_id, v_pair.visit_id, v_pair.participant_id, p_at)
    returning id into v_assignment_id;

    update public.visits set status = 'Assigned' where id = v_pair.visit_id;

    -- Optimistic rotation: the offered associate goes to the bottom now.
    update public.associate_sessions
    set queue_order = upb_private.next_queue_order(p_session_id)
    where id = v_pair.participant_id;

    perform upb_private.append_activity(
      p_session_id, p_at, 'AssignmentCreated',
      upb_private.visit_label(v_pair.visit_id) || ' offered to '
        || upb_private.participant_name(v_pair.participant_id),
      v_pair.visit_id, v_pair.participant_id, v_assignment_id);

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- 2. Board: VisitView.waitingReason (contract version 5).
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
  ),
  roster_capacity as (
    select count(*) filter (where p.state = 'Available') as available,
           count(*) filter (where p.state = 'Available' and not exists (
             select 1 from assignment g
             where g.participant_id = p.id and g.accepted_at is null and g.completed_at is null)) as eligible
    from participant p
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
          -- Why a Waiting visitor inside has no offer. Dispatch runs in every
          -- command, so an eligible associate next to a Waiting visit means
          -- that associate rejected this visit last.
          'waitingReason', case when v.status = 'Waiting' and v.departed_at is null then
            case when (select available from roster_capacity) = 0 then 'NoAvailableAssociates'
                 when (select eligible from roster_capacity) = 0 then 'AwaitingConfirmation'
                 else 'AwaitingOtherAssociate' end
          end,
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
