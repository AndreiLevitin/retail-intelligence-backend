-- Board snapshot (US-01) and manual arrival with automatic FIFO dispatch
-- (US-02). Command functions are invoker-rights and executable only by the
-- trusted backend role; the gateway hides their names behind WorkflowStore.

-- Validates and normalizes a full visitor profile. Mirrors the API
-- normalization so direct RPC callers cannot bypass the rules.
create function upb_private.normalize_profile(
  p_upper_description     text,
  p_lower_description     text,
  p_accessory_description text,
  p_age_group             text,
  p_gender                text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_ws        constant text := E' \t\n\r\f\v';
  v_upper     text;
  v_lower     text;
  v_accessory text;
begin
  if p_upper_description is null or p_lower_description is null then
    perform upb_private.fail('VALIDATION_ERROR',
      'upperDescription and lowerDescription are required (use an empty string when unknown).');
  end if;

  v_upper := btrim(p_upper_description, v_ws);
  v_lower := btrim(p_lower_description, v_ws);
  v_accessory := nullif(btrim(p_accessory_description, v_ws), '');

  if char_length(v_upper) > 200 or char_length(v_lower) > 200
     or coalesce(char_length(v_accessory), 0) > 200 then
    perform upb_private.fail('VALIDATION_ERROR', 'Descriptions are limited to 200 characters.');
  end if;

  if p_age_group is null
     or p_age_group not in ('Under20', 'From20To39', 'From40To59', 'Age60Plus', 'Unknown') then
    perform upb_private.fail('VALIDATION_ERROR', 'ageGroup is not a supported value.');
  end if;

  if p_gender is null or p_gender not in ('Female', 'Male', 'Unknown') then
    perform upb_private.fail('VALIDATION_ERROR', 'gender is not a supported value.');
  end if;

  return jsonb_build_object(
    'upperDescription', v_upper,
    'lowerDescription', v_lower,
    'accessoryDescription', v_accessory,
    'ageGroup', p_age_group,
    'gender', p_gender);
end;
$$;

-- One consistent current-run projection, assembled in a single SQL
-- statement (STABLE: one snapshot). Each collection is aggregated
-- independently so counts are never multiplied by joins.
create function public.upb_get_board()
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
    select participant_id, count(*) as assigned, count(accepted_at) as accepted
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
          'currentAssignmentId', (
            select g.id from assignment g
            where g.participant_id = p.id and g.completed_at is null),
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

-- UC-03/04: register a manual arrival at server time and FIFO order,
-- deduplicated by eventId against the immutable original payload, then
-- reserve the first Available participant if any.
create function public.upb_register_arrival(
  p_session_id            uuid,
  p_event_id              uuid,
  p_source                text,
  p_detected_at           timestamptz,
  p_upper_description     text,
  p_lower_description     text,
  p_accessory_description text,
  p_age_group             text,
  p_gender                text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_session_id uuid;
  v_now        timestamptz;
  v_profile    jsonb;
  v_payload    jsonb;
  v_receipt    record;
  v_visit_id   uuid;
  v_status     text;
begin
  if p_event_id is null then
    perform upb_private.fail('VALIDATION_ERROR', 'eventId is required.');
  end if;
  if p_source is distinct from 'Manual' then
    perform upb_private.fail('VALIDATION_ERROR', 'Only Manual arrivals are accepted in this stage.');
  end if;
  if p_detected_at is not null then
    perform upb_private.fail('VALIDATION_ERROR', 'detectedAt must be null for manual arrivals.');
  end if;
  v_profile := upb_private.normalize_profile(
    p_upper_description, p_lower_description, p_accessory_description, p_age_group, p_gender);
  v_payload := jsonb_build_object('source', 'Manual', 'detectedAt', null, 'attributes', v_profile);

  v_session_id := upb_private.lock_current_session(p_session_id);
  -- Milestone time is taken after the lock, not at transaction start.
  v_now := clock_timestamp();

  select r.command_kind, r.request_payload, r.result into v_receipt
  from public.command_receipts r
  where r.session_id = v_session_id and r.command_id = p_event_id;

  if found then
    if v_receipt.command_kind <> 'Arrival' or v_receipt.request_payload <> v_payload then
      perform upb_private.fail('REPLAY_CONFLICT',
        'This eventId was already used with a different request.');
    end if;
    v_visit_id := (v_receipt.result ->> 'visitId')::uuid;
    select v.status into v_status from public.visits v where v.id = v_visit_id;
    return jsonb_build_object(
      'sessionId', v_session_id, 'visitId', v_visit_id, 'duplicate', true, 'status', v_status);
  end if;

  insert into public.visits (
    session_id, arrival_event_id, arrived_at, source, status, detected_at,
    upper_description, lower_description, accessory_description, age_group, gender,
    attributes_source, enrichment_status)
  values (
    v_session_id, p_event_id, v_now, 'Manual', 'Waiting', null,
    v_profile ->> 'upperDescription', v_profile ->> 'lowerDescription',
    v_profile ->> 'accessoryDescription', v_profile ->> 'ageGroup', v_profile ->> 'gender',
    'Manual', 'NotRequested')
  returning id into v_visit_id;

  insert into public.command_receipts (session_id, command_id, command_kind, request_payload, result)
  values (v_session_id, p_event_id, 'Arrival', v_payload, jsonb_build_object('visitId', v_visit_id));

  perform upb_private.append_activity(
    v_session_id, v_now, 'ArrivalRecorded',
    upb_private.visit_label(v_visit_id) || ' registered (manual entry)',
    v_visit_id);

  perform upb_private.dispatch(v_session_id, v_now);

  select v.status into v_status from public.visits v where v.id = v_visit_id;
  return jsonb_build_object(
    'sessionId', v_session_id, 'visitId', v_visit_id, 'duplicate', false, 'status', v_status);
end;
$$;

revoke all on function upb_private.normalize_profile(text, text, text, text, text) from public;
grant execute on function upb_private.normalize_profile(text, text, text, text, text) to service_role;

revoke all on function public.upb_get_board() from public, anon, authenticated;
revoke all on function public.upb_register_arrival(uuid, uuid, text, timestamptz, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.upb_get_board() to service_role;
grant execute on function public.upb_register_arrival(uuid, uuid, text, timestamptz, text, text, text, text, text)
  to service_role;
