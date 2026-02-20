create table if not exists public.user_build_runtime_kv (
  id bigserial primary key,
  space_id uuid not null references public.user_build_spaces(id) on delete cascade,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  updated_by uuid not null references public.profileskozmos(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_build_runtime_kv_unique unique (space_id, key),
  constraint user_build_runtime_kv_key_len check (char_length(key) between 1 and 128)
);

create index if not exists user_build_runtime_kv_space_updated_idx
  on public.user_build_runtime_kv (space_id, updated_at desc);

create index if not exists user_build_runtime_kv_space_key_idx
  on public.user_build_runtime_kv (space_id, key);

create or replace function public.touch_user_build_runtime_kv_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_user_build_runtime_kv_updated_at
  on public.user_build_runtime_kv;

create trigger trg_touch_user_build_runtime_kv_updated_at
before update on public.user_build_runtime_kv
for each row execute function public.touch_user_build_runtime_kv_updated_at();

alter table public.user_build_runtime_kv enable row level security;

drop policy if exists "user_build_runtime_kv_select_accessible"
  on public.user_build_runtime_kv;
drop policy if exists "user_build_runtime_kv_insert_editable"
  on public.user_build_runtime_kv;
drop policy if exists "user_build_runtime_kv_update_editable"
  on public.user_build_runtime_kv;
drop policy if exists "user_build_runtime_kv_delete_editable"
  on public.user_build_runtime_kv;

create policy "user_build_runtime_kv_select_accessible"
on public.user_build_runtime_kv
for select
to authenticated
using (
  exists (
    select 1
    from public.user_build_spaces s
    where s.id = user_build_runtime_kv.space_id
      and (
        s.owner_id = auth.uid()
        or s.is_public = true
        or exists (
          select 1
          from public.user_build_space_access a
          where a.space_id = s.id
            and a.user_id = auth.uid()
        )
      )
  )
);

create policy "user_build_runtime_kv_insert_editable"
on public.user_build_runtime_kv
for insert
to authenticated
with check (
  updated_by = auth.uid()
  and exists (
    select 1
    from public.user_build_spaces s
    where s.id = user_build_runtime_kv.space_id
      and (
        s.owner_id = auth.uid()
        or exists (
          select 1
          from public.user_build_space_access a
          where a.space_id = s.id
            and a.user_id = auth.uid()
            and a.can_edit = true
        )
      )
  )
);

create policy "user_build_runtime_kv_update_editable"
on public.user_build_runtime_kv
for update
to authenticated
using (
  exists (
    select 1
    from public.user_build_spaces s
    where s.id = user_build_runtime_kv.space_id
      and (
        s.owner_id = auth.uid()
        or exists (
          select 1
          from public.user_build_space_access a
          where a.space_id = s.id
            and a.user_id = auth.uid()
            and a.can_edit = true
        )
      )
  )
)
with check (
  updated_by = auth.uid()
  and exists (
    select 1
    from public.user_build_spaces s
    where s.id = user_build_runtime_kv.space_id
      and (
        s.owner_id = auth.uid()
        or exists (
          select 1
          from public.user_build_space_access a
          where a.space_id = s.id
            and a.user_id = auth.uid()
            and a.can_edit = true
        )
      )
  )
);

create policy "user_build_runtime_kv_delete_editable"
on public.user_build_runtime_kv
for delete
to authenticated
using (
  exists (
    select 1
    from public.user_build_spaces s
    where s.id = user_build_runtime_kv.space_id
      and (
        s.owner_id = auth.uid()
        or exists (
          select 1
          from public.user_build_space_access a
          where a.space_id = s.id
            and a.user_id = auth.uid()
            and a.can_edit = true
        )
      )
  )
);
