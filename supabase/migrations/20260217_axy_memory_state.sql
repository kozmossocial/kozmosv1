create table if not exists public.axy_memory_state (
  conversation_key text primary key,
  recent_replies text[] not null default '{}',
  recent_domains text[] not null default '{}',
  rotation_cursor integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists axy_memory_state_updated_idx
  on public.axy_memory_state (updated_at desc);

create or replace function public.touch_axy_memory_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_axy_memory_state_updated_at
  on public.axy_memory_state;

create trigger trg_touch_axy_memory_state_updated_at
before update on public.axy_memory_state
for each row execute function public.touch_axy_memory_state_updated_at();

alter table public.axy_memory_state enable row level security;
