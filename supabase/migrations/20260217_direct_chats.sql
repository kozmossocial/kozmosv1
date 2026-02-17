create table if not exists public.direct_chats (
  id uuid primary key default gen_random_uuid(),
  participant_a uuid not null references public.profileskozmos(id) on delete cascade,
  participant_b uuid not null references public.profileskozmos(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint direct_chats_not_self check (participant_a <> participant_b),
  constraint direct_chats_pair_unique unique (participant_a, participant_b)
);

create index if not exists direct_chats_updated_idx
  on public.direct_chats (updated_at desc);

create or replace function public.touch_direct_chats_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_direct_chats_updated_at
  on public.direct_chats;

create trigger trg_touch_direct_chats_updated_at
before update on public.direct_chats
for each row execute function public.touch_direct_chats_updated_at();

alter table public.direct_chats enable row level security;

drop policy if exists "direct_chats_select_involved"
  on public.direct_chats;
drop policy if exists "direct_chats_insert_involved"
  on public.direct_chats;

create policy "direct_chats_select_involved"
on public.direct_chats
for select
to authenticated
using (auth.uid() = participant_a or auth.uid() = participant_b);

create policy "direct_chats_insert_involved"
on public.direct_chats
for insert
to authenticated
with check (auth.uid() = participant_a or auth.uid() = participant_b);
