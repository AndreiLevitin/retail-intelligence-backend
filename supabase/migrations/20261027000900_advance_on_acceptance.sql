-- Assignment Rotation Revision - "Advance on Acceptance" (approved business
-- rule; supersedes exclusive-until-outcome rotation).
--
-- * Associate availability is only Available / OffFloor. Accepted unfinished
--   work never makes an associate ineligible; several accepted unfinished
--   assignments per participant are valid.
-- * At most ONE unresolved offer (accepted_at and completed_at null) exists
--   per run. Creating it keeps the participant's availability and queue order.
-- * Acceptance moves the participant to the queue bottom exactly once and then
--   offers the next oldest Waiting visit.
-- * Outcome and departure never move rotation. Departure of a pending offer
--   closes it (reason Departure) without consuming the turn and clears the
--   gate for the next offer.

-- 1. Existing data must not contain several pending offers in one run: that
--    needs business reconciliation, never silent reassignment or deletion.
do $$
declare
  v_report text;
begin
  select string_agg(format('session %s has %s pending offers', session_id, n), '; ')
    into v_report
  from (
    select session_id, count(*) as n
    from public.assignments
    where accepted_at is null and completed_at is null
    group by session_id
    having count(*) > 1
  ) offending;

  if v_report is not null then
    raise exception 'Rotation migration stopped: %. Reconcile these offers (e.g. accept or record departure) before applying.', v_report;
  end if;
end
$$;

-- 2. Replace one-unfinished-turn-per-participant with one-pending-offer-per-run.
--    The index name is the one created by 20261027000100_schema.sql.
drop index public.assignments_one_unfinished_per_participant;
create unique index assignments_one_pending_offer_per_session
  on public.assignments (session_id)
  where accepted_at is null and completed_at is null;

-- 3. Busy participant states become Available (assignment milestones are kept
--    as they are). They join the queue bottom in initial roster order.
update public.associate_sessions p
set state = 'Available', queue_order = moved.queue_order
from (
  select b.id,
         (select coalesce(max(x.queue_order), 0)
          from public.associate_sessions x
          where x.session_id = b.session_id and x.state = 'Available')
         + row_number() over (partition by b.session_id order by a.initial_rotation_order) as queue_order
  from public.associate_sessions b
  join public.associates a on a.id = b.associate_id
  where b.state in ('PendingAcceptance', 'OnUP')
) moved
where p.id = moved.id;

do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  where c.conrelid = 'public.associate_sessions'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%PendingAcceptance%';
  if v_name is null then
    raise exception 'associate_sessions state check constraint not found';
  end if;
  execute format('alter table public.associate_sessions drop constraint %I', v_name);
end
$$;

alter table public.associate_sessions
  add constraint associate_sessions_state_check check (state in ('Available', 'OffFloor'));

-- 4. Dispatcher: create at most one offer, only while no offer is pending.
--    The offered participant keeps availability and queue order.
create or replace function upb_private.dispatch(p_session_id uuid, p_at timestamptz)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_visit_id       uuid;
  v_participant_id uuid;
  v_assignment_id  uuid;
begin
  if exists (
    select 1 from public.assignments g
    where g.session_id = p_session_id and g.accepted_at is null and g.completed_at is null
  ) then
    return 0;
  end if;

  select v.id into v_visit_id
  from public.visits v
  where v.session_id = p_session_id
    and v.status = 'Waiting'
    and v.departed_at is null
  order by v.arrival_order
  limit 1;
  if not found then
    return 0;
  end if;

  select p.id into v_participant_id
  from public.associate_sessions p
  where p.session_id = p_session_id
    and p.state = 'Available'
  order by p.queue_order
  limit 1;
  if not found then
    return 0;
  end if;

  insert into public.assignments (session_id, visit_id, participant_id, assigned_at)
  values (p_session_id, v_visit_id, v_participant_id, p_at)
  returning id into v_assignment_id;

  update public.visits set status = 'Assigned' where id = v_visit_id;

  perform upb_private.append_activity(
    p_session_id, p_at, 'AssignmentCreated',
    upb_private.visit_label(v_visit_id) || ' offered to '
      || upb_private.participant_name(v_participant_id),
    v_visit_id, v_participant_id, v_assignment_id);

  return 1;
end;
$$;

-- Releasing participants no longer exists in the rotation model.
drop function upb_private.release_participant(uuid, uuid);

-- 5. Acceptance advances rotation once, then offers the next visitor.
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

  -- Already accepted: report the current phase; never move rotation again.
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

  -- Move from the current position to the bottom, exactly once. The owner of
  -- the pending offer cannot be Off Floor (availability rejects that).
  update public.associate_sessions
  set queue_order = upb_private.next_queue_order(v_session_id)
  where id = v_target.participant_id and state = 'Available';
  if not found then
    raise exception 'participant % owning the pending offer is not Available', v_target.participant_id;
  end if;

  perform upb_private.append_activity(
    v_session_id, v_now, 'AssignmentAccepted',
    upb_private.participant_name(v_target.participant_id) || ' accepted '
      || upb_private.visit_label(v_target.visit_id),
    v_target.visit_id, v_target.participant_id, v_target.id);

  perform upb_private.dispatch(v_session_id, v_now);

  return jsonb_build_object(
    'sessionId', v_session_id, 'assignmentId', v_target.id, 'phase', 'Accepted', 'replayed', false);
end;
$$;

-- 6. Outcome completes only the given assignment/visit; rotation unchanged.
create or replace function public.upb_record_outcome(p_session_id uuid, p_assignment_id uuid, p_outcome text)
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
  if p_outcome is null or p_outcome not in ('Sale', 'NoSale') then
    perform upb_private.fail('VALIDATION_ERROR', 'outcome must be Sale or NoSale.');
  end if;

  v_session_id := upb_private.lock_current_session(p_session_id);
  v_now := clock_timestamp();

  select g.id, g.visit_id, g.participant_id, g.accepted_at, g.completed_at, g.completion_reason,
         v.outcome, v.departed_at
    into v_target
  from public.assignments g
  join public.visits v on v.id = g.visit_id
  where g.id = p_assignment_id and g.session_id = v_session_id;

  if not found then
    perform upb_private.fail('NOT_FOUND', 'Assignment not found in the current demo run.');
  end if;

  if v_target.completion_reason = 'OutcomeRecorded' then
    if v_target.outcome = p_outcome then
      return jsonb_build_object(
        'sessionId', v_session_id, 'visitId', v_target.visit_id, 'assignmentId', v_target.id,
        'outcome', v_target.outcome, 'replayed', true);
    end if;
    perform upb_private.fail('OUTCOME_CONFLICT', 'A different purchase result is already recorded.');
  end if;

  if v_target.completion_reason = 'Departure' then
    perform upb_private.fail('INVALID_TRANSITION',
      'This turn was closed by the visitor''s departure.');
  end if;

  if v_target.accepted_at is null then
    perform upb_private.fail('INVALID_TRANSITION', 'The assignment must be accepted before recording an outcome.');
  end if;

  if v_target.outcome is not null or v_target.departed_at is not null then
    raise exception 'unfinished assignment % has a visit with result or departure', v_target.id;
  end if;

  update public.visits
  set outcome = p_outcome, outcome_recorded_at = v_now, status = 'Completed'
  where id = v_target.visit_id;

  update public.assignments
  set completed_at = v_now, completion_reason = 'OutcomeRecorded'
  where id = v_target.id;

  perform upb_private.append_activity(
    v_session_id, v_now, 'TurnCompleted',
    upb_private.participant_name(v_target.participant_id) || ' completed the turn with '
      || upb_private.visit_label(v_target.visit_id) || ': ' || upb_private.outcome_label(p_outcome),
    v_target.visit_id, v_target.participant_id, v_target.id);

  return jsonb_build_object(
    'sessionId', v_session_id, 'visitId', v_target.visit_id, 'assignmentId', v_target.id,
    'outcome', p_outcome, 'replayed', false);
end;
$$;

-- 7. Departure never moves rotation. Closing a pending offer clears the gate
--    without consuming the associate's turn and offers the next visitor.
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
  left join public.assignments g on g.visit_id = v.id
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

-- 8. Availability is receptionist-controlled even with accepted unfinished
--    work; only the owner of the pending offer cannot go Off Floor.
create or replace function public.upb_set_availability(
  p_session_id     uuid,
  p_participant_id uuid,
  p_command_id     uuid,
  p_state          text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_session_id  uuid;
  v_now         timestamptz;
  v_payload     jsonb;
  v_receipt     record;
  v_participant record;
  v_result      jsonb;
begin
  if p_participant_id is null or p_command_id is null then
    perform upb_private.fail('VALIDATION_ERROR', 'participantId and commandId are required.');
  end if;
  if p_state is null or p_state not in ('Available', 'OffFloor') then
    perform upb_private.fail('VALIDATION_ERROR', 'state must be Available or OffFloor.');
  end if;
  v_payload := jsonb_build_object('participantId', p_participant_id, 'state', p_state);

  v_session_id := upb_private.lock_current_session(p_session_id);
  v_now := clock_timestamp();

  select r.command_kind, r.request_payload, r.result into v_receipt
  from public.command_receipts r
  where r.session_id = v_session_id and r.command_id = p_command_id;

  if found then
    if v_receipt.command_kind <> 'Availability' or v_receipt.request_payload <> v_payload then
      perform upb_private.fail('REPLAY_CONFLICT',
        'This commandId was already used with a different request.');
    end if;
    return v_receipt.result || jsonb_build_object('replayed', true);
  end if;

  select p.id, p.state into v_participant
  from public.associate_sessions p
  where p.id = p_participant_id and p.session_id = v_session_id;

  if not found then
    perform upb_private.fail('NOT_FOUND', 'Participant not found in the current demo run.');
  end if;

  if p_state = 'OffFloor' and exists (
    select 1 from public.assignments g
    where g.participant_id = v_participant.id and g.accepted_at is null and g.completed_at is null
  ) then
    perform upb_private.fail('INVALID_TRANSITION',
      'Resolve the pending offer (accept or record departure) before marking this associate Off Floor.');
  end if;

  if v_participant.state <> p_state then
    update public.associate_sessions
    set state = p_state,
        queue_order = case when p_state = 'Available'
                           then upb_private.next_queue_order(v_session_id) end
    where id = v_participant.id;

    perform upb_private.append_activity(
      v_session_id, v_now, 'AvailabilityChanged',
      upb_private.participant_name(v_participant.id) || ': '
        || upb_private.state_label(v_participant.state) || ' -> ' || upb_private.state_label(p_state),
      null, v_participant.id, null);

    if p_state = 'Available' then
      perform upb_private.dispatch(v_session_id, v_now);
    end if;
  end if;

  v_result := jsonb_build_object(
    'sessionId', v_session_id, 'participantId', v_participant.id, 'replayed', false);

  insert into public.command_receipts (session_id, command_id, command_kind, request_payload, result)
  values (v_session_id, p_command_id, 'Availability', v_payload, v_result);

  return v_result;
end;
$$;

-- 9. Board: associates expose the pending offer and accepted unfinished work
--    separately from availability.
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
          'assignmentId', (select g.id from assignment g where g.visit_id = v.id))
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
        order by g.arrival_order)
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
