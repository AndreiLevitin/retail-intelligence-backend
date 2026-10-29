-- CV arrivals reuse the existing atomic, idempotent dispatcher. No attributes inferred here.
-- CREATE OR REPLACE retains the existing service_role-only execute grants.
create or replace function public.upb_register_arrival(
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
  if p_source is null or p_source not in ('Manual', 'CV') then
    perform upb_private.fail('VALIDATION_ERROR', 'source must be Manual or CV.');
  end if;
  if p_source = 'Manual' and p_detected_at is not null then
    perform upb_private.fail('VALIDATION_ERROR', 'detectedAt must be null for manual arrivals.');
  end if;
  if p_source = 'CV' and (p_detected_at is null or not isfinite(p_detected_at)) then
    perform upb_private.fail('VALIDATION_ERROR', 'CV arrivals require a finite detectedAt.');
  end if;
  v_profile := upb_private.normalize_profile(
    p_upper_description, p_lower_description, p_accessory_description, p_age_group, p_gender);
  v_payload := jsonb_build_object('source', p_source, 'detectedAt', upb_private.iso(p_detected_at), 'attributes', v_profile);

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
    v_session_id, p_event_id, v_now, p_source, 'Waiting', p_detected_at,
    v_profile ->> 'upperDescription', v_profile ->> 'lowerDescription',
    v_profile ->> 'accessoryDescription', v_profile ->> 'ageGroup', v_profile ->> 'gender',
    case when p_source = 'CV' then 'Unknown' else 'Manual' end, 'NotRequested')
  returning id into v_visit_id;

  insert into public.command_receipts (session_id, command_id, command_kind, request_payload, result)
  values (v_session_id, p_event_id, 'Arrival', v_payload, jsonb_build_object('visitId', v_visit_id));

  perform upb_private.append_activity(
    v_session_id, v_now, 'ArrivalRecorded',
    upb_private.visit_label(v_visit_id) || case when p_source = 'CV' then ' registered (CV entrance)' else ' registered (manual entry)' end,
    v_visit_id);

  perform upb_private.dispatch(v_session_id, v_now);

  select v.status into v_status from public.visits v where v.id = v_visit_id;
  return jsonb_build_object(
    'sessionId', v_session_id, 'visitId', v_visit_id, 'duplicate', false, 'status', v_status);
end;
$$;
