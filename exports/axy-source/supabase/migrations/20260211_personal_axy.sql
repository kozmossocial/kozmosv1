create table if not exists public.personal_axy_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  voice text not null default 'calm minimal',
  boundaries text not null default 'short, calm, intentional',
  updated_at timestamptz not null default now()
);

create table if not exists public.personal_axy_memories (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  memory text not null,
  tags text[] not null default '{}',
  salience smallint not null default 3 check (salience between 1 and 5),
  created_at timestamptz not null default now()
);

create table if not exists public.personal_axy_turns (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_message text not null,
  axy_reply text not null,
  created_at timestamptz not null default now()
);

create index if not exists personal_axy_memories_user_created_idx
  on public.personal_axy_memories (user_id, created_at desc);

create index if not exists personal_axy_memories_user_salience_idx
  on public.personal_axy_memories (user_id, salience desc, created_at desc);

create index if not exists personal_axy_turns_user_created_idx
  on public.personal_axy_turns (user_id, created_at desc);

create or replace function public.touch_personal_axy_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_personal_axy_profiles_updated_at
  on public.personal_axy_profiles;

create trigger trg_touch_personal_axy_profiles_updated_at
before update on public.personal_axy_profiles
for each row execute function public.touch_personal_axy_profiles_updated_at();

alter table public.personal_axy_profiles enable row level security;
alter table public.personal_axy_memories enable row level security;
alter table public.personal_axy_turns enable row level security;

drop policy if exists "personal_axy_profiles_select_own"
  on public.personal_axy_profiles;
drop policy if exists "personal_axy_profiles_insert_own"
  on public.personal_axy_profiles;
drop policy if exists "personal_axy_profiles_update_own"
  on public.personal_axy_profiles;

create policy "personal_axy_profiles_select_own"
on public.personal_axy_profiles
for select
to authenticated
using (auth.uid() = user_id);

create policy "personal_axy_profiles_insert_own"
on public.personal_axy_profiles
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "personal_axy_profiles_update_own"
on public.personal_axy_profiles
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "personal_axy_memories_select_own"
  on public.personal_axy_memories;
drop policy if exists "personal_axy_memories_insert_own"
  on public.personal_axy_memories;
drop policy if exists "personal_axy_memories_delete_own"
  on public.personal_axy_memories;

create policy "personal_axy_memories_select_own"
on public.personal_axy_memories
for select
to authenticated
using (auth.uid() = user_id);

create policy "personal_axy_memories_insert_own"
on public.personal_axy_memories
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "personal_axy_memories_delete_own"
on public.personal_axy_memories
for delete
to authenticated
using (auth.uid() = user_id);

drop policy if exists "personal_axy_turns_select_own"
  on public.personal_axy_turns;
drop policy if exists "personal_axy_turns_insert_own"
  on public.personal_axy_turns;
drop policy if exists "personal_axy_turns_delete_own"
  on public.personal_axy_turns;

create policy "personal_axy_turns_select_own"
on public.personal_axy_turns
for select
to authenticated
using (auth.uid() = user_id);

create policy "personal_axy_turns_insert_own"
on public.personal_axy_turns
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "personal_axy_turns_delete_own"
on public.personal_axy_turns
for delete
to authenticated
using (auth.uid() = user_id);

