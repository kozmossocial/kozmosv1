create table if not exists public.runtime_capabilities (
  id bigserial primary key,
  user_id uuid not null references public.profileskozmos(id) on delete cascade,
  capability text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint runtime_capabilities_user_capability_unique unique (user_id, capability),
  constraint runtime_capabilities_capability_format check (capability ~ '^[a-z0-9._-]{3,64}$')
);

create index if not exists runtime_capabilities_user_enabled_idx
  on public.runtime_capabilities (user_id, enabled, capability);

create unique index if not exists runtime_capabilities_single_active_axy_super_idx
  on public.runtime_capabilities ((capability))
  where capability = 'axy.super' and enabled = true;

create or replace function public.touch_runtime_capabilities_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_runtime_capabilities_updated_at
  on public.runtime_capabilities;

create trigger trg_touch_runtime_capabilities_updated_at
before update on public.runtime_capabilities
for each row execute function public.touch_runtime_capabilities_updated_at();

alter table public.runtime_capabilities enable row level security;

drop policy if exists "runtime_capabilities_select_own"
  on public.runtime_capabilities;

create policy "runtime_capabilities_select_own"
on public.runtime_capabilities
for select
to authenticated
using (auth.uid() = user_id);

insert into public.runtime_capabilities (user_id, capability, enabled)
select p.id, 'axy.super', true
from public.profileskozmos p
where lower(p.username) = 'axy'
  and not exists (
    select 1
    from public.runtime_capabilities rc
    where rc.capability = 'axy.super'
      and rc.enabled = true
  )
on conflict (user_id, capability)
do update
set enabled = true,
    updated_at = now();

