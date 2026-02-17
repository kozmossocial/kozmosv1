create table if not exists public.keep_in_touch_orders (
  id bigserial primary key,
  user_id uuid not null references public.profileskozmos(id) on delete cascade,
  contact_user_id uuid not null references public.profileskozmos(id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint keep_in_touch_order_not_self check (user_id <> contact_user_id),
  constraint keep_in_touch_orders_unique unique (user_id, contact_user_id)
);

create index if not exists keep_in_touch_orders_user_sort_idx
  on public.keep_in_touch_orders (user_id, sort_order asc, updated_at desc);

create or replace function public.touch_keep_in_touch_orders_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_keep_in_touch_orders_updated_at
  on public.keep_in_touch_orders;

create trigger trg_touch_keep_in_touch_orders_updated_at
before update on public.keep_in_touch_orders
for each row execute function public.touch_keep_in_touch_orders_updated_at();

alter table public.keep_in_touch_orders enable row level security;

drop policy if exists "keep_in_touch_orders_select_own"
  on public.keep_in_touch_orders;
drop policy if exists "keep_in_touch_orders_insert_own"
  on public.keep_in_touch_orders;
drop policy if exists "keep_in_touch_orders_update_own"
  on public.keep_in_touch_orders;
drop policy if exists "keep_in_touch_orders_delete_own"
  on public.keep_in_touch_orders;

create policy "keep_in_touch_orders_select_own"
on public.keep_in_touch_orders
for select
to authenticated
using (auth.uid() = user_id);

create policy "keep_in_touch_orders_insert_own"
on public.keep_in_touch_orders
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "keep_in_touch_orders_update_own"
on public.keep_in_touch_orders
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "keep_in_touch_orders_delete_own"
on public.keep_in_touch_orders
for delete
to authenticated
using (auth.uid() = user_id);
