-- Digital UP Board, Stage 1: domain and technical tables.
-- Physical mapping of "Database Design.md" section 1/3. Cross-table state
-- correspondence is maintained by the command functions under the
-- demo_control lock; the constraints below protect keys, references,
-- uniqueness and single-row value rules independently of those functions.

create table public.demo_sessions (
  id         uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default clock_timestamp()
);

-- Predefined roster; survives reset.
create table public.associates (
  id                     uuid primary key,
  display_name           text not null check (btrim(display_name) <> ''),
  initial_rotation_order bigint not null unique check (initial_rotation_order > 0)
);

create table public.associate_sessions (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.demo_sessions (id),
  associate_id uuid not null references public.associates (id),
  state        text not null
    check (state in ('Available', 'OffFloor', 'PendingAcceptance', 'OnUP')),
  -- Relative FIFO token; present iff Available. Never exposed publicly.
  queue_order  bigint check (queue_order > 0),
  unique (session_id, associate_id),
  unique (session_id, id),
  unique (session_id, queue_order),
  check ((state = 'Available') = (queue_order is not null))
);

create table public.visits (
  id                    uuid primary key default gen_random_uuid(),
  session_id            uuid not null references public.demo_sessions (id),
  arrival_event_id      uuid not null,
  arrived_at            timestamptz not null,
  -- Server registration order (FIFO); allocated under the control lock.
  arrival_order         bigint not null generated always as identity,
  source                text not null check (source in ('CV', 'Manual')),
  status                text not null
    check (status in ('Waiting', 'Assigned', 'Accepted', 'Completed')),
  detected_at           timestamptz,
  upper_description     text not null,
  lower_description     text not null,
  accessory_description text,
  age_group             text not null
    check (age_group in ('Under20', 'From20To39', 'From40To59', 'Age60Plus', 'Unknown')),
  gender                text not null check (gender in ('Female', 'Male', 'Unknown')),
  attributes_source     text not null check (attributes_source in ('Manual', 'CV', 'Unknown')),
  enrichment_status     text not null
    check (enrichment_status in ('Pending', 'Complete', 'Failed', 'NotRequested')),
  departed_at           timestamptz,
  outcome               text check (outcome in ('Sale', 'NoSale')),
  outcome_recorded_at   timestamptz,
  unique (session_id, arrival_event_id),
  unique (session_id, arrival_order),
  unique (session_id, id),
  -- Descriptions are stored normalized: trimmed, at most 200 characters,
  -- accessory null instead of empty.
  constraint visits_upper_description_normalized check (
    upper_description = btrim(upper_description, E' \t\n\r\f\v')
    and char_length(upper_description) <= 200),
  constraint visits_lower_description_normalized check (
    lower_description = btrim(lower_description, E' \t\n\r\f\v')
    and char_length(lower_description) <= 200),
  constraint visits_accessory_description_normalized check (
    accessory_description is null
    or (accessory_description = btrim(accessory_description, E' \t\n\r\f\v')
        and char_length(accessory_description) between 1 and 200)),
  constraint visits_outcome_time check ((outcome is null) = (outcome_recorded_at is null)),
  -- For the currently defined commands, Completed iff a purchase result exists.
  constraint visits_completed_has_outcome check ((status = 'Completed') = (outcome is not null)),
  constraint visits_departure check (
    departed_at is null
    or (departed_at >= arrived_at and status = 'Completed' and outcome is not null)),
  constraint visits_outcome_after_arrival check (
    outcome_recorded_at is null or outcome_recorded_at >= arrived_at)
);

create table public.assignments (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.demo_sessions (id),
  visit_id          uuid not null,
  participant_id    uuid not null,
  assigned_at       timestamptz not null,
  accepted_at       timestamptz,
  completed_at      timestamptz,
  completion_reason text check (completion_reason in ('OutcomeRecorded', 'Departure')),
  -- Same-session links. Purchase outcome is deliberately NOT stored here.
  foreign key (session_id, visit_id) references public.visits (session_id, id),
  foreign key (session_id, participant_id) references public.associate_sessions (session_id, id),
  unique (visit_id),
  unique (session_id, id),
  constraint assignments_completion_reason check ((completion_reason is null) = (completed_at is null)),
  constraint assignments_outcome_requires_acceptance check (
    completion_reason is distinct from 'OutcomeRecorded' or accepted_at is not null),
  constraint assignments_accepted_order check (accepted_at is null or accepted_at >= assigned_at),
  constraint assignments_completed_order check (
    completed_at is null or completed_at >= coalesce(accepted_at, assigned_at))
);

-- At most one unfinished assignment per participant.
create unique index assignments_one_unfinished_per_participant
  on public.assignments (participant_id) where completed_at is null;
create index assignments_session_idx on public.assignments (session_id);

create table public.activity_entries (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.demo_sessions (id),
  occurred_at    timestamptz not null,
  activity_order bigint not null generated always as identity,
  kind           text not null check (kind in (
    'ArrivalRecorded', 'AssignmentCreated', 'AssignmentAccepted', 'TurnCompleted',
    'AvailabilityChanged', 'VisitorAttributesUpdated', 'VisitorDeparted')),
  description    text not null,
  visit_id       uuid,
  participant_id uuid,
  assignment_id  uuid,
  unique (session_id, activity_order),
  foreign key (session_id, visit_id) references public.visits (session_id, id),
  foreign key (session_id, participant_id) references public.associate_sessions (session_id, id),
  foreign key (session_id, assignment_id) references public.assignments (session_id, id)
);

-- Technical singleton; the stable row every mutation locks first.
create table public.demo_control (
  id                 smallint primary key check (id = 1),
  -- Null only transiently inside setup/reset.
  current_session_id uuid references public.demo_sessions (id)
);

-- Technical retry bookkeeping: immutable arrival payloads and availability
-- acknowledgements. Never contains credentials. Removed on reset.
create table public.command_receipts (
  session_id      uuid not null references public.demo_sessions (id),
  command_id      uuid not null,
  command_kind    text not null check (command_kind in ('Arrival', 'Availability')),
  request_payload jsonb not null,
  result          jsonb not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  primary key (session_id, command_id)
);

-- Read/dispatch paths.
create index visits_waiting_fifo_idx on public.visits (session_id, arrival_order)
  where status = 'Waiting' and departed_at is null;
create index associate_sessions_available_idx on public.associate_sessions (session_id, queue_order)
  where state = 'Available';
create index activity_entries_recent_idx on public.activity_entries (session_id, activity_order desc);

-- Access: the browser never talks to the database. Deny anonymous and
-- authenticated API roles; only the trusted backend (service_role) may use
-- the tables, and in practice it goes through the command functions.
alter table public.demo_sessions      enable row level security;
alter table public.associates         enable row level security;
alter table public.associate_sessions enable row level security;
alter table public.visits             enable row level security;
alter table public.assignments        enable row level security;
alter table public.activity_entries   enable row level security;
alter table public.demo_control       enable row level security;
alter table public.command_receipts   enable row level security;

revoke all on table
  public.demo_sessions, public.associates, public.associate_sessions, public.visits,
  public.assignments, public.activity_entries, public.demo_control, public.command_receipts
  from public, anon, authenticated;

grant select, insert, update, delete on table
  public.demo_sessions, public.associates, public.associate_sessions, public.visits,
  public.assignments, public.activity_entries, public.demo_control, public.command_receipts
  to service_role;

revoke all on all sequences in schema public from public, anon, authenticated;
grant usage, select on all sequences in schema public to service_role;
