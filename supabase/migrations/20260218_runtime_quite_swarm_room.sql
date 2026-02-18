create table if not exists public.runtime_quite_swarm_room (
  id text primary key,
  status text not null default 'idle' check (status in ('idle', 'running')),
  seed integer,
  started_at timestamptz,
  host_user_id uuid references public.profileskozmos(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.runtime_quite_swarm_room (id, status)
values ('main', 'idle')
on conflict (id) do nothing;

create or replace function public.touch_runtime_quite_swarm_room_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_runtime_quite_swarm_room_updated_at
  on public.runtime_quite_swarm_room;

create trigger trg_touch_runtime_quite_swarm_room_updated_at
before update on public.runtime_quite_swarm_room
for each row execute function public.touch_runtime_quite_swarm_room_updated_at();

alter table public.runtime_quite_swarm_room enable row level security;

drop policy if exists "runtime_quite_swarm_room_select_authenticated"
  on public.runtime_quite_swarm_room;

create policy "runtime_quite_swarm_room_select_authenticated"
on public.runtime_quite_swarm_room
for select
to authenticated
using (true);

do $$
begin
  begin
    alter publication supabase_realtime add table public.runtime_quite_swarm_room;
  exception
    when duplicate_object then null;
  end;
end
$$;
