create table if not exists public.keep_in_touch_requests (
  id bigserial primary key,
  requester_id uuid not null references public.profileskozmos(id) on delete cascade,
  requested_id uuid not null references public.profileskozmos(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint keep_in_touch_not_self check (requester_id <> requested_id)
);

create unique index if not exists keep_in_touch_pair_unique_idx
  on public.keep_in_touch_requests (
    least(requester_id, requested_id),
    greatest(requester_id, requested_id)
  );

create index if not exists keep_in_touch_requested_status_idx
  on public.keep_in_touch_requests (requested_id, status, updated_at desc);

create index if not exists keep_in_touch_requester_status_idx
  on public.keep_in_touch_requests (requester_id, status, updated_at desc);

create or replace function public.touch_keep_in_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_keep_in_touch_updated_at
  on public.keep_in_touch_requests;

create trigger trg_touch_keep_in_touch_updated_at
before update on public.keep_in_touch_requests
for each row execute function public.touch_keep_in_touch_updated_at();

alter table public.keep_in_touch_requests enable row level security;

drop policy if exists "keep_in_touch_select_involved"
  on public.keep_in_touch_requests;

create policy "keep_in_touch_select_involved"
on public.keep_in_touch_requests
for select
to authenticated
using (auth.uid() = requester_id or auth.uid() = requested_id);
