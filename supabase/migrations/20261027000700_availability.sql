-- UC-01 idle availability (US-05) with commandId replay protection.
-- Receipt lookup precedes participant-state validation, so a delayed retry
-- returns its saved acknowledgement and never undoes a later change.

create function public.upb_set_availability(
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

  if v_participant.state not in ('Available', 'OffFloor') then
    perform upb_private.fail('INVALID_TRANSITION',
      'Availability can only be changed for an idle associate.');
  end if;

  -- Same state: no-op (queue position and activity unchanged), receipt kept.
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

revoke all on function public.upb_set_availability(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.upb_set_availability(uuid, uuid, uuid, text) to service_role;
