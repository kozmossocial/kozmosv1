create table if not exists public.night_protocol_sessions (
  id uuid primary key default gen_random_uuid(),
  session_code text not null unique,
  host_user_id uuid not null references public.profileskozmos(id) on delete cascade,
  status text not null default 'LOBBY' check (status in ('LOBBY', 'NIGHT', 'DAY', 'VOTING', 'ENDED')),
  round_no integer not null default 0 check (round_no >= 0),
  min_players integer not null default 6 check (min_players >= 4),
  max_players integer not null default 12 check (max_players >= min_players),
  presence_mode boolean not null default true,
  current_speaker_player_id uuid,
  speaker_order jsonb not null default '[]'::jsonb,
  speaker_index integer not null default 0 check (speaker_index >= 0),
  speaker_turn_ends_at timestamptz,
  phase_ends_at timestamptz,
  winner text check (winner in ('CITIZENS', 'SHADOWS')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.night_protocol_players (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.night_protocol_sessions(id) on delete cascade,
  user_id uuid references public.profileskozmos(id) on delete set null,
  username text not null,
  is_ai boolean not null default false,
  seat_no integer not null check (seat_no > 0),
  role text check (role in ('shadow', 'oracle', 'guardian', 'citizen')),
  is_alive boolean not null default true,
  elimination_type text check (elimination_type in ('night_fade', 'exile')),
  revealed_role text check (revealed_role in ('shadow', 'oracle', 'guardian', 'citizen')),
  joined_at timestamptz not null default now(),
  eliminated_at timestamptz,
  constraint night_protocol_players_identity_check check (
    (is_ai = true and user_id is null) or
    (is_ai = false and user_id is not null)
  ),
  constraint night_protocol_players_session_seat_unique unique (session_id, seat_no)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'night_protocol_sessions_current_speaker_fkey'
  ) then
    alter table public.night_protocol_sessions
      add constraint night_protocol_sessions_current_speaker_fkey
      foreign key (current_speaker_player_id)
      references public.night_protocol_players(id)
      on delete set null;
  end if;
end
$$;

create table if not exists public.night_protocol_night_actions (
  id bigserial primary key,
  session_id uuid not null references public.night_protocol_sessions(id) on delete cascade,
  round_no integer not null check (round_no > 0),
  actor_player_id uuid not null references public.night_protocol_players(id) on delete cascade,
  action_type text not null check (action_type in ('shadow_target', 'guardian_protect', 'oracle_peek')),
  target_player_id uuid not null references public.night_protocol_players(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint night_protocol_night_actions_actor_unique
    unique (session_id, round_no, actor_player_id, action_type)
);

create table if not exists public.night_protocol_votes (
  id bigserial primary key,
  session_id uuid not null references public.night_protocol_sessions(id) on delete cascade,
  round_no integer not null check (round_no > 0),
  voter_player_id uuid not null references public.night_protocol_players(id) on delete cascade,
  target_player_id uuid not null references public.night_protocol_players(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint night_protocol_votes_voter_unique unique (session_id, round_no, voter_player_id)
);

create table if not exists public.night_protocol_day_messages (
  id bigserial primary key,
  session_id uuid not null references public.night_protocol_sessions(id) on delete cascade,
  round_no integer not null check (round_no > 0),
  sender_player_id uuid not null references public.night_protocol_players(id) on delete cascade,
  username text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.night_protocol_events (
  id bigserial primary key,
  session_id uuid not null references public.night_protocol_sessions(id) on delete cascade,
  round_no integer not null default 0 check (round_no >= 0),
  phase text not null default 'SYSTEM',
  scope text not null default 'public' check (scope in ('public', 'private')),
  target_player_id uuid references public.night_protocol_players(id) on delete cascade,
  event_type text not null default 'system',
  content text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists night_protocol_players_session_idx
  on public.night_protocol_players (session_id, seat_no asc);

create unique index if not exists night_protocol_players_session_user_unique
  on public.night_protocol_players (session_id, user_id)
  where user_id is not null;

create unique index if not exists night_protocol_players_session_username_unique
  on public.night_protocol_players (session_id, lower(username));

create index if not exists night_protocol_night_actions_round_idx
  on public.night_protocol_night_actions (session_id, round_no, created_at asc);

create index if not exists night_protocol_votes_round_idx
  on public.night_protocol_votes (session_id, round_no, created_at asc);

create index if not exists night_protocol_day_messages_idx
  on public.night_protocol_day_messages (session_id, round_no, created_at asc);

create index if not exists night_protocol_events_idx
  on public.night_protocol_events (session_id, created_at asc);

create or replace function public.touch_night_protocol_sessions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_night_protocol_sessions_updated_at
  on public.night_protocol_sessions;

create trigger trg_touch_night_protocol_sessions_updated_at
before update on public.night_protocol_sessions
for each row execute function public.touch_night_protocol_sessions_updated_at();

alter table public.night_protocol_sessions enable row level security;
alter table public.night_protocol_players enable row level security;
alter table public.night_protocol_night_actions enable row level security;
alter table public.night_protocol_votes enable row level security;
alter table public.night_protocol_day_messages enable row level security;
alter table public.night_protocol_events enable row level security;

drop policy if exists "night_protocol_sessions_select_member"
  on public.night_protocol_sessions;
drop policy if exists "night_protocol_sessions_insert_host"
  on public.night_protocol_sessions;
drop policy if exists "night_protocol_sessions_update_host"
  on public.night_protocol_sessions;

create policy "night_protocol_sessions_select_member"
on public.night_protocol_sessions
for select
to authenticated
using (
  auth.uid() = host_user_id
  or exists (
    select 1
    from public.night_protocol_players p
    where p.session_id = night_protocol_sessions.id
      and p.user_id = auth.uid()
  )
);

create policy "night_protocol_sessions_insert_host"
on public.night_protocol_sessions
for insert
to authenticated
with check (auth.uid() = host_user_id);

create policy "night_protocol_sessions_update_host"
on public.night_protocol_sessions
for update
to authenticated
using (auth.uid() = host_user_id)
with check (auth.uid() = host_user_id);

drop policy if exists "night_protocol_players_select_member"
  on public.night_protocol_players;
drop policy if exists "night_protocol_players_insert_join_or_host_ai"
  on public.night_protocol_players;
drop policy if exists "night_protocol_players_update_self_or_host"
  on public.night_protocol_players;

create policy "night_protocol_players_select_member"
on public.night_protocol_players
for select
to authenticated
using (
  exists (
    select 1
    from public.night_protocol_players p2
    where p2.session_id = night_protocol_players.session_id
      and p2.user_id = auth.uid()
  )
);

create policy "night_protocol_players_insert_join_or_host_ai"
on public.night_protocol_players
for insert
to authenticated
with check (
  (
    is_ai = false
    and user_id = auth.uid()
    and exists (
      select 1
      from public.night_protocol_sessions s
      where s.id = session_id
        and s.status = 'LOBBY'
    )
  )
  or (
    is_ai = true
    and exists (
      select 1
      from public.night_protocol_sessions s
      where s.id = session_id
        and s.host_user_id = auth.uid()
        and s.status = 'LOBBY'
    )
  )
);

create policy "night_protocol_players_update_self_or_host"
on public.night_protocol_players
for update
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1
    from public.night_protocol_sessions s
    where s.id = session_id
      and s.host_user_id = auth.uid()
  )
)
with check (
  user_id = auth.uid()
  or exists (
    select 1
    from public.night_protocol_sessions s
    where s.id = session_id
      and s.host_user_id = auth.uid()
  )
);

drop policy if exists "night_protocol_actions_select_member"
  on public.night_protocol_night_actions;
drop policy if exists "night_protocol_actions_insert_actor"
  on public.night_protocol_night_actions;

create policy "night_protocol_actions_select_member"
on public.night_protocol_night_actions
for select
to authenticated
using (
  exists (
    select 1
    from public.night_protocol_players p
    where p.session_id = night_protocol_night_actions.session_id
      and p.user_id = auth.uid()
  )
);

create policy "night_protocol_actions_insert_actor"
on public.night_protocol_night_actions
for insert
to authenticated
with check (
  exists (
    select 1
    from public.night_protocol_players p
    where p.id = actor_player_id
      and p.session_id = session_id
      and p.user_id = auth.uid()
      and p.is_alive = true
  )
);

drop policy if exists "night_protocol_votes_select_member"
  on public.night_protocol_votes;
drop policy if exists "night_protocol_votes_insert_voter"
  on public.night_protocol_votes;

create policy "night_protocol_votes_select_member"
on public.night_protocol_votes
for select
to authenticated
using (
  exists (
    select 1
    from public.night_protocol_players p
    where p.session_id = night_protocol_votes.session_id
      and p.user_id = auth.uid()
  )
);

create policy "night_protocol_votes_insert_voter"
on public.night_protocol_votes
for insert
to authenticated
with check (
  exists (
    select 1
    from public.night_protocol_players p
    where p.id = voter_player_id
      and p.session_id = session_id
      and p.user_id = auth.uid()
      and p.is_alive = true
  )
);

drop policy if exists "night_protocol_day_messages_select_member"
  on public.night_protocol_day_messages;
drop policy if exists "night_protocol_day_messages_insert_sender"
  on public.night_protocol_day_messages;

create policy "night_protocol_day_messages_select_member"
on public.night_protocol_day_messages
for select
to authenticated
using (
  exists (
    select 1
    from public.night_protocol_players p
    where p.session_id = night_protocol_day_messages.session_id
      and p.user_id = auth.uid()
  )
);

create policy "night_protocol_day_messages_insert_sender"
on public.night_protocol_day_messages
for insert
to authenticated
with check (
  exists (
    select 1
    from public.night_protocol_players p
    where p.id = sender_player_id
      and p.session_id = session_id
      and p.user_id = auth.uid()
      and p.is_alive = true
  )
);

drop policy if exists "night_protocol_events_select_member_or_private_target"
  on public.night_protocol_events;

create policy "night_protocol_events_select_member_or_private_target"
on public.night_protocol_events
for select
to authenticated
using (
  exists (
    select 1
    from public.night_protocol_players p
    where p.session_id = night_protocol_events.session_id
      and p.user_id = auth.uid()
  )
  and (
    scope = 'public'
    or (
      scope = 'private'
      and exists (
        select 1
        from public.night_protocol_players p2
        where p2.id = target_player_id
          and p2.user_id = auth.uid()
      )
    )
  )
);

do $$
begin
  begin
    alter publication supabase_realtime add table public.night_protocol_sessions;
  exception
    when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.night_protocol_players;
  exception
    when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.night_protocol_night_actions;
  exception
    when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.night_protocol_votes;
  exception
    when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.night_protocol_day_messages;
  exception
    when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.night_protocol_events;
  exception
    when duplicate_object then null;
  end;
end
$$;
