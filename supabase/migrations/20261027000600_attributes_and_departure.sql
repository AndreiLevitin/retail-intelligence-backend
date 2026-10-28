-- UC-11 manual profile correction and UC-12 exit registration (US-02/US-04).

-- Full manual profile replacement. Never changes lifecycle, result, times,
-- assignment or queue. Allowed after departure within the same run.
create function public.upb_update_visitor_attributes(
  p_session_id            uuid,
  p_visit_id              uuid,
  p_source                text,
  p_upper_description     text,
  p_lower_description     text,
  p_accessory_description text,
  p_age_group             text,
  p_gender                text,
  p_enrichment_status     text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_session_id uuid;
  v_now        timestamptz;
  v_profile    jsonb;
  v_visit      record;
  v_current    jsonb;
begin
  if p_visit_id is null then
    perform upb_private.fail('VALIDATION_ERROR', 'visitId is required.');
  end if;
  if p_source is distinct from 'Manual' then
    perform upb_private.fail('VALIDATION_ERROR', 'Only Manual profile updates are accepted in this stage.');
  end if;
  if p_enrichment_status is distinct from 'NotRequested' then
    perform upb_private.fail('VALIDATION_ERROR', 'enrichmentStatus must be NotRequested for manual updates.');
  end if;
  v_profile := upb_private.normalize_profile(
    p_upper_description, p_lower_description, p_accessory_description, p_age_group, p_gender);

  v_session_id := upb_private.lock_current_session(p_session_id);
  v_now := clock_timestamp();

  select v.id, v.upper_description, v.lower_description, v.accessory_description, v.age_group,
         v.gender, v.attributes_source, v.enrichment_status
    into v_visit
  from public.visits v
  where v.id = p_visit_id and v.session_id = v_session_id;

  if not found then
    perform upb_private.fail('NOT_FOUND', 'Visit not found in the current demo run.');
  end if;

  v_current := jsonb_build_object(
    'upperDescription', v_visit.upper_description,
    'lowerDescription', v_visit.lower_description,
    'accessoryDescription', v_visit.accessory_description,
    'ageGroup', v_visit.age_group,
    'gender', v_visit.gender);

  -- Unchanged replacement: no write, no activity.
  if v_current = v_profile and v_visit.attributes_source = 'Manual'
     and v_visit.enrichment_status = 'NotRequested' then
    return jsonb_build_object(
      'sessionId', v_session_id, 'visitId', v_visit.id, 'attributes', v_current,
      'attributesSource', 'Manual', 'enrichmentStatus', 'NotRequested', 'ignored', false);
  end if;

  update public.visits
  set upper_description = v_profile ->> 'upperDescription',
      lower_description = v_profile ->> 'lowerDescription',
      accessory_description = v_profile ->> 'accessoryDescription',
      age_group = v_profile ->> 'ageGroup',
      gender = v_profile ->> 'gender',
      attributes_source = 'Manual',
      enrichment_status = 'NotRequested'
  where id = v_visit.id;

  perform upb_private.append_activity(
    v_session_id, v_now, 'VisitorAttributesUpdated',
    upb_private.visit_label(v_visit.id) || ' profile updated manually',
    v_visit.id);

  return jsonb_build_object(
    'sessionId', v_session_id, 'visitId', v_visit.id, 'attributes', v_profile,
    'attributesSource', 'Manual', 'enrichmentStatus', 'NotRequested', 'ignored', false);
end;
$$;

-- Exit registration, independent of service completion. Handles Waiting,
-- pending, accepted and completed service. Preserves a stored outcome or
-- requires an explicit one; closes only an unfinished assignment (reason
-- Departure, acceptedAt untouched) and releases that participant once.
create function public.upb_record_departure(p_session_id uuid, p_visit_id uuid, p_outcome text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_session_id uuid;
  v_now        timestamptz;
  v_visit      record;
  v_outcome    text;
  v_released   boolean := false;
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
         g.id as assignment_id, g.participant_id, g.completed_at as assignment_completed_at
    into v_visit
  from public.visits v
  left join public.assignments g on g.visit_id = v.id
  where v.id = p_visit_id and v.session_id = v_session_id;

  if not found then
    perform upb_private.fail('NOT_FOUND', 'Visit not found in the current demo run.');
  end if;

  -- Repeated exit: original time/result, no new effects.
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

  -- Close only an unfinished assignment; a completed one is left untouched
  -- even if its participant is now serving someone else.
  if v_visit.assignment_id is not null and v_visit.assignment_completed_at is null then
    update public.assignments
    set completed_at = v_now, completion_reason = 'Departure'
    where id = v_visit.assignment_id;
    perform upb_private.release_participant(v_session_id, v_visit.participant_id);
    v_released := true;
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
    case when v_released then v_visit.participant_id end,
    case when v_released then v_visit.assignment_id end);

  if v_released then
    perform upb_private.append_activity(
      v_session_id, v_now, 'TurnCompleted',
      upb_private.participant_name(v_visit.participant_id) || '''s turn with '
        || upb_private.visit_label(v_visit.id) || ' closed by departure',
      v_visit.id, v_visit.participant_id, v_visit.assignment_id);
    perform upb_private.dispatch(v_session_id, v_now);
  end if;

  return jsonb_build_object(
    'sessionId', v_session_id, 'visitId', v_visit.id,
    'departedAt', upb_private.iso(v_now), 'outcome', v_outcome, 'replayed', false);
end;
$$;

revoke all on function public.upb_update_visitor_attributes(uuid, uuid, text, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.upb_record_departure(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.upb_update_visitor_attributes(uuid, uuid, text, text, text, text, text, text, text)
  to service_role;
grant execute on function public.upb_record_departure(uuid, uuid, text) to service_role;
