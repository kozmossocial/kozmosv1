create extension if not exists pgcrypto;

create table if not exists public.runtime_user_tokens (
  id bigserial primary key,
  user_id uuid not null references public.profileskozmos(id) on delete cascade,
  token_hash text not null unique,
  label text not null default 'runtime',
  is_active boolean not null default true,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.runtime_presence (
  user_id uuid primary key references public.profileskozmos(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists runtime_user_tokens_user_idx
  on public.runtime_user_tokens(user_id, is_active);

create index if not exists runtime_presence_last_seen_idx
  on public.runtime_presence(last_seen_at desc);

create or replace function public.touch_runtime_presence_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_runtime_presence_updated_at
  on public.runtime_presence;

create trigger trg_touch_runtime_presence_updated_at
before update on public.runtime_presence
for each row execute function public.touch_runtime_presence_updated_at();

alter table public.runtime_user_tokens enable row level security;
alter table public.runtime_presence enable row level security;

drop policy if exists "runtime_presence_select_authenticated"
  on public.runtime_presence;

create policy "runtime_presence_select_authenticated"
on public.runtime_presence
for select
to authenticated
using (true);

