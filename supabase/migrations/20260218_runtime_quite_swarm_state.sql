alter table public.runtime_presence
  add column if not exists swarm_x double precision not null default 0,
  add column if not exists swarm_y double precision not null default 0,
  add column if not exists swarm_active boolean not null default false,
  add column if not exists swarm_updated_at timestamptz;

create index if not exists runtime_presence_swarm_updated_idx
  on public.runtime_presence (swarm_updated_at desc);

create index if not exists runtime_presence_swarm_active_last_seen_idx
  on public.runtime_presence (swarm_active, last_seen_at desc);
