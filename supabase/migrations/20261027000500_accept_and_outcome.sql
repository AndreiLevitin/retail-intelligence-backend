-- UC-05 acceptance and UC-06 purchase outcome (US-03). The outcome is stored
-- on Visit only; the assignment records the completion milestone/reason.

create function public.upb_accept_assignment(p_session_id uuid, p_assignment_id uuid)
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

  -- Acceptance already happened: natural idempotency, report current phase.
  if v_target.accepted_at is not null then
    return jsonb_build_object(
      'sessionId', v_session_id,
      'assignmentId', v_target.id,
      'phase', case when v_target.completed_at is not null then 'Completed' else 'Accepted' end,
      'replayed', true);
  end if;

  -- Closed by departure before acceptance: never fabricate an acceptance.
  if v_target.completed_at is not null then
    perform upb_private.fail('INVALID_TRANSITION',
      'The visitor departed before this assignment was accepted.');
  end if;

  if v_target.departed_at is not null or v_target.visit_status <> 'Assigned' then
    perform upb_private.fail('INVALID_TRANSITION', 'The visit can no longer be accepted.');
  end if;

  update public.assignments set accepted_at = v_now where id = v_target.id;
  update public.visits set status = 'Accepted' where id = v_target.visit_id;
  update public.associate_sessions
  set state = 'OnUP'
  where id = v_target.participant_id and state = 'PendingAcceptance';
  if not found then
    raise exception 'participant % is not pending acceptance', v_target.participant_id;
  end if;

  perform upb_private.append_activity(
    v_session_id, v_now, 'AssignmentAccepted',
    upb_private.participant_name(v_target.participant_id) || ' accepted '
      || upb_private.visit_label(v_target.visit_id),
    v_target.visit_id, v_target.participant_id, v_target.id);

  return jsonb_build_object(
    'sessionId', v_session_id, 'assignmentId', v_target.id, 'phase', 'Accepted', 'replayed', false);
end;
$$;

create function public.upb_record_outcome(p_session_id uuid, p_assignment_id uuid, p_outcome text)
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

  -- Turn already completed by an outcome: same result is a replay (even
  -- after a later exit), a different one is a conflict.
  if v_target.completion_reason = 'OutcomeRecorded' then
    if v_target.outcome = p_outcome then
      return jsonb_build_object(
        'sessionId', v_session_id, 'visitId', v_target.visit_id, 'assignmentId', v_target.id,
        'outcome', v_target.outcome, 'replayed', true);
    end if;
    perform upb_private.fail('OUTCOME_CONFLICT', 'A different purchase result is already recorded.');
  end if;

  -- Closed by departure: the turn can no longer receive a normal outcome,
  -- even if the visit has a result from the exit registration.
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

  perform upb_private.release_participant(v_session_id, v_target.participant_id);

  perform upb_private.append_activity(
    v_session_id, v_now, 'TurnCompleted',
    upb_private.participant_name(v_target.participant_id) || ' completed the turn with '
      || upb_private.visit_label(v_target.visit_id) || ': ' || upb_private.outcome_label(p_outcome),
    v_target.visit_id, v_target.participant_id, v_target.id);

  perform upb_private.dispatch(v_session_id, v_now);

  return jsonb_build_object(
    'sessionId', v_session_id, 'visitId', v_target.visit_id, 'assignmentId', v_target.id,
    'outcome', p_outcome, 'replayed', false);
end;
$$;

revoke all on function public.upb_accept_assignment(uuid, uuid) from public, anon, authenticated;
revoke all on function public.upb_record_outcome(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.upb_accept_assignment(uuid, uuid) to service_role;
grant execute on function public.upb_record_outcome(uuid, uuid, text) to service_role;
