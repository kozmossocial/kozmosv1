alter table public.user_build_backend_modes
  add column if not exists starter_users_quota integer not null default 3000
    check (starter_users_quota between 10 and 50000),
  add column if not exists friend_requests_quota integer not null default 12000
    check (friend_requests_quota between 50 and 200000),
  add column if not exists friendships_quota integer not null default 12000
    check (friendships_quota between 50 and 200000);

create table if not exists public.user_build_starter_users (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.user_build_spaces(id) on delete cascade,
  username text not null,
  username_key text not null,
  password_salt text not null,
  password_hash text not null,
  display_name text not null default '',
  profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id, username_key),
  constraint user_build_starter_users_username_len check (char_length(username) between 3 and 32),
  constraint user_build_starter_users_username_key_len check (char_length(username_key) between 3 and 32)
);

create table if not exists public.user_build_starter_sessions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.user_build_spaces(id) on delete cascade,
  starter_user_id uuid not null references public.user_build_starter_users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (token_hash),
  unique (space_id, id)
);

create table if not exists public.user_build_starter_friend_requests (
  id bigserial primary key,
  space_id uuid not null references public.user_build_spaces(id) on delete cascade,
  from_user_id uuid not null references public.user_build_starter_users(id) on delete cascade,
  to_user_id uuid not null references public.user_build_starter_users(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id, from_user_id, to_user_id),
  constraint user_build_starter_friend_requests_status_check
    check (status in ('pending', 'accepted', 'declined', 'blocked')),
  constraint user_build_starter_friend_requests_not_self
    check (from_user_id <> to_user_id)
);

create table if not exists public.user_build_starter_friendships (
  id bigserial primary key,
  space_id uuid not null references public.user_build_spaces(id) on delete cascade,
  user_a_id uuid not null references public.user_build_starter_users(id) on delete cascade,
  user_b_id uuid not null references public.user_build_starter_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (space_id, user_a_id, user_b_id),
  constraint user_build_starter_friendships_ordered check (user_a_id < user_b_id),
  constraint user_build_starter_friendships_not_self check (user_a_id <> user_b_id)
);

create index if not exists user_build_starter_users_space_updated_idx
  on public.user_build_starter_users (space_id, updated_at desc);

create index if not exists user_build_starter_users_space_username_idx
  on public.user_build_starter_users (space_id, username_key);

create index if not exists user_build_starter_sessions_space_user_idx
  on public.user_build_starter_sessions (space_id, starter_user_id, expires_at desc);

create index if not exists user_build_starter_sessions_expiry_idx
  on public.user_build_starter_sessions (expires_at desc);

create index if not exists user_build_starter_friend_requests_to_status_idx
  on public.user_build_starter_friend_requests (space_id, to_user_id, status, updated_at desc);

create index if not exists user_build_starter_friend_requests_from_status_idx
  on public.user_build_starter_friend_requests (space_id, from_user_id, status, updated_at desc);

create index if not exists user_build_starter_friendships_space_a_idx
  on public.user_build_starter_friendships (space_id, user_a_id, created_at desc);

create index if not exists user_build_starter_friendships_space_b_idx
  on public.user_build_starter_friendships (space_id, user_b_id, created_at desc);

drop trigger if exists trg_touch_user_build_starter_users_updated_at
  on public.user_build_starter_users;
create trigger trg_touch_user_build_starter_users_updated_at
before update on public.user_build_starter_users
for each row execute function public.touch_user_build_backend_updated_at();

drop trigger if exists trg_touch_user_build_starter_sessions_updated_at
  on public.user_build_starter_sessions;
create trigger trg_touch_user_build_starter_sessions_updated_at
before update on public.user_build_starter_sessions
for each row execute function public.touch_user_build_backend_updated_at();

drop trigger if exists trg_touch_user_build_starter_friend_requests_updated_at
  on public.user_build_starter_friend_requests;
create trigger trg_touch_user_build_starter_friend_requests_updated_at
before update on public.user_build_starter_friend_requests
for each row execute function public.touch_user_build_backend_updated_at();

alter table public.user_build_starter_users enable row level security;
alter table public.user_build_starter_sessions enable row level security;
alter table public.user_build_starter_friend_requests enable row level security;
alter table public.user_build_starter_friendships enable row level security;

drop policy if exists "user_build_starter_users_select_accessible"
  on public.user_build_starter_users;
drop policy if exists "user_build_starter_users_mutate_editable"
  on public.user_build_starter_users;

create policy "user_build_starter_users_select_accessible"
on public.user_build_starter_users
for select
to authenticated
using (public.user_build_space_can_read(space_id, auth.uid()));

create policy "user_build_starter_users_mutate_editable"
on public.user_build_starter_users
for all
to authenticated
using (public.user_build_space_can_edit(space_id, auth.uid()))
with check (public.user_build_space_can_edit(space_id, auth.uid()));

drop policy if exists "user_build_starter_sessions_select_editable"
  on public.user_build_starter_sessions;
drop policy if exists "user_build_starter_sessions_mutate_editable"
  on public.user_build_starter_sessions;

create policy "user_build_starter_sessions_select_editable"
on public.user_build_starter_sessions
for select
to authenticated
using (public.user_build_space_can_edit(space_id, auth.uid()));

create policy "user_build_starter_sessions_mutate_editable"
on public.user_build_starter_sessions
for all
to authenticated
using (public.user_build_space_can_edit(space_id, auth.uid()))
with check (public.user_build_space_can_edit(space_id, auth.uid()));

drop policy if exists "user_build_starter_friend_requests_select_accessible"
  on public.user_build_starter_friend_requests;
drop policy if exists "user_build_starter_friend_requests_mutate_editable"
  on public.user_build_starter_friend_requests;

create policy "user_build_starter_friend_requests_select_accessible"
on public.user_build_starter_friend_requests
for select
to authenticated
using (public.user_build_space_can_read(space_id, auth.uid()));

create policy "user_build_starter_friend_requests_mutate_editable"
on public.user_build_starter_friend_requests
for all
to authenticated
using (public.user_build_space_can_edit(space_id, auth.uid()))
with check (public.user_build_space_can_edit(space_id, auth.uid()));

drop policy if exists "user_build_starter_friendships_select_accessible"
  on public.user_build_starter_friendships;
drop policy if exists "user_build_starter_friendships_mutate_editable"
  on public.user_build_starter_friendships;

create policy "user_build_starter_friendships_select_accessible"
on public.user_build_starter_friendships
for select
to authenticated
using (public.user_build_space_can_read(space_id, auth.uid()));

create policy "user_build_starter_friendships_mutate_editable"
on public.user_build_starter_friendships
for all
to authenticated
using (public.user_build_space_can_edit(space_id, auth.uid()))
with check (public.user_build_space_can_edit(space_id, auth.uid()));
