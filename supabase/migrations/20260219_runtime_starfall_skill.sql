create table if not exists public.runtime_starfall_skill (
  user_id uuid primary key references public.profileskozmos(id) on delete cascade,
  skill_rating double precision not null default 1000,
  reaction_ms double precision not null default 255,
  aim_accuracy double precision not null default 0.52 check (aim_accuracy >= 0.25 and aim_accuracy <= 0.99),
  aggression double precision not null default 0.48 check (aggression >= 0.1 and aggression <= 0.95),
  episodes integer not null default 0 check (episodes >= 0),
  wins integer not null default 0 check (wins >= 0),
  best_score integer not null default 0 check (best_score >= 0),
  last_score integer not null default 0 check (last_score >= 0),
  average_score double precision not null default 0 check (average_score >= 0),
  last_round integer not null default 1 check (last_round >= 1),
  updated_at timestamptz not null default now()
);

create index if not exists runtime_starfall_skill_updated_idx
  on public.runtime_starfall_skill (updated_at desc);

create or replace function public.touch_runtime_starfall_skill_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_runtime_starfall_skill_updated_at
  on public.runtime_starfall_skill;

create trigger trg_touch_runtime_starfall_skill_updated_at
before update on public.runtime_starfall_skill
for each row execute function public.touch_runtime_starfall_skill_updated_at();

alter table public.runtime_starfall_skill enable row level security;

drop policy if exists "runtime_starfall_skill_select_own"
  on public.runtime_starfall_skill;
drop policy if exists "runtime_starfall_skill_insert_own"
  on public.runtime_starfall_skill;
drop policy if exists "runtime_starfall_skill_update_own"
  on public.runtime_starfall_skill;
drop policy if exists "runtime_starfall_skill_delete_own"
  on public.runtime_starfall_skill;

create policy "runtime_starfall_skill_select_own"
on public.runtime_starfall_skill
for select
to authenticated
using (auth.uid() = user_id);

create policy "runtime_starfall_skill_insert_own"
on public.runtime_starfall_skill
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "runtime_starfall_skill_update_own"
on public.runtime_starfall_skill
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "runtime_starfall_skill_delete_own"
on public.runtime_starfall_skill
for delete
to authenticated
using (auth.uid() = user_id);
