create table if not exists public.runtime_axy_missions (
  session_id text primary key,
  user_id uuid not null references public.profileskozmos(id) on delete cascade,
  status text not null default 'mission_planning',
  topic text,
  output_path text,
  quality_score double precision,
  published boolean not null default false,
  published_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint runtime_axy_missions_status_check check (
    status in (
      'mission_planning',
      'mission_building',
      'mission_review',
      'mission_publish',
      'mission_failed',
      'freedom'
    )
  )
);

create index if not exists runtime_axy_missions_user_updated_idx
  on public.runtime_axy_missions (user_id, updated_at desc);

create index if not exists runtime_axy_missions_published_idx
  on public.runtime_axy_missions (user_id, published, published_at desc);

create or replace function public.touch_runtime_axy_missions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_runtime_axy_missions_updated_at
  on public.runtime_axy_missions;

create trigger trg_touch_runtime_axy_missions_updated_at
before update on public.runtime_axy_missions
for each row execute function public.touch_runtime_axy_missions_updated_at();

alter table public.runtime_axy_missions enable row level security;
