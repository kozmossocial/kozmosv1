create table if not exists public.user_build_spaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profileskozmos(id) on delete cascade,
  title text not null,
  is_public boolean not null default false,
  language_pref text not null default 'auto',
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_build_spaces
  add column if not exists is_public boolean not null default false;

create table if not exists public.user_build_files (
  id bigserial primary key,
  space_id uuid not null references public.user_build_spaces(id) on delete cascade,
  path text not null,
  content text not null default '',
  language text not null default 'text',
  updated_by uuid not null references public.profileskozmos(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id, path)
);

create table if not exists public.user_build_space_access (
  id bigserial primary key,
  space_id uuid not null references public.user_build_spaces(id) on delete cascade,
  user_id uuid not null references public.profileskozmos(id) on delete cascade,
  can_edit boolean not null default false,
  granted_by uuid not null references public.profileskozmos(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (space_id, user_id)
);

create index if not exists user_build_spaces_owner_updated_idx
  on public.user_build_spaces (owner_id, updated_at desc);

create index if not exists user_build_files_space_updated_idx
  on public.user_build_files (space_id, updated_at desc);

create index if not exists user_build_spaces_public_updated_idx
  on public.user_build_spaces (is_public, updated_at desc);

create index if not exists user_build_space_access_user_idx
  on public.user_build_space_access (user_id, created_at desc);

create index if not exists user_build_space_access_space_idx
  on public.user_build_space_access (space_id, created_at desc);

create or replace function public.touch_user_build_spaces_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.touch_user_build_files_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_user_build_spaces_updated_at
  on public.user_build_spaces;

create trigger trg_touch_user_build_spaces_updated_at
before update on public.user_build_spaces
for each row execute function public.touch_user_build_spaces_updated_at();

drop trigger if exists trg_touch_user_build_files_updated_at
  on public.user_build_files;

create trigger trg_touch_user_build_files_updated_at
before update on public.user_build_files
for each row execute function public.touch_user_build_files_updated_at();

alter table public.user_build_spaces enable row level security;
alter table public.user_build_files enable row level security;
alter table public.user_build_space_access enable row level security;

drop policy if exists "user_build_spaces_select_own"
  on public.user_build_spaces;
drop policy if exists "user_build_spaces_insert_own"
  on public.user_build_spaces;
drop policy if exists "user_build_spaces_update_own"
  on public.user_build_spaces;
drop policy if exists "user_build_spaces_delete_own"
  on public.user_build_spaces;

create policy "user_build_spaces_select_own"
on public.user_build_spaces
for select
to authenticated
using (
  auth.uid() = owner_id
  or is_public = true
  or exists (
    select 1
    from public.user_build_space_access a
    where a.space_id = user_build_spaces.id
      and a.user_id = auth.uid()
  )
);

create policy "user_build_spaces_insert_own"
on public.user_build_spaces
for insert
to authenticated
with check (auth.uid() = owner_id);

create policy "user_build_spaces_update_own"
on public.user_build_spaces
for update
to authenticated
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

create policy "user_build_spaces_delete_own"
on public.user_build_spaces
for delete
to authenticated
using (auth.uid() = owner_id);

drop policy if exists "user_build_files_select_own"
  on public.user_build_files;
drop policy if exists "user_build_files_insert_own"
  on public.user_build_files;
drop policy if exists "user_build_files_update_own"
  on public.user_build_files;
drop policy if exists "user_build_files_delete_own"
  on public.user_build_files;

create policy "user_build_files_select_own"
on public.user_build_files
for select
to authenticated
using (
  exists (
    select 1
    from public.user_build_spaces s
    where s.id = user_build_files.space_id
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

create policy "user_build_files_insert_own"
on public.user_build_files
for insert
to authenticated
with check (
  updated_by = auth.uid()
  and exists (
    select 1
    from public.user_build_spaces s
    where s.id = user_build_files.space_id
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

create policy "user_build_files_update_own"
on public.user_build_files
for update
to authenticated
using (
  exists (
    select 1
    from public.user_build_spaces s
    where s.id = user_build_files.space_id
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
    where s.id = user_build_files.space_id
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

create policy "user_build_files_delete_own"
on public.user_build_files
for delete
to authenticated
using (
  exists (
    select 1
    from public.user_build_spaces s
    where s.id = user_build_files.space_id
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

drop policy if exists "user_build_space_access_select_own_or_owner"
  on public.user_build_space_access;
drop policy if exists "user_build_space_access_insert_owner"
  on public.user_build_space_access;
drop policy if exists "user_build_space_access_update_owner"
  on public.user_build_space_access;
drop policy if exists "user_build_space_access_delete_owner"
  on public.user_build_space_access;

create policy "user_build_space_access_select_own_or_owner"
on public.user_build_space_access
for select
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1
    from public.user_build_spaces s
    where s.id = user_build_space_access.space_id
      and s.owner_id = auth.uid()
  )
);

create policy "user_build_space_access_insert_owner"
on public.user_build_space_access
for insert
to authenticated
with check (
  granted_by = auth.uid()
  and exists (
    select 1
    from public.user_build_spaces s
    where s.id = user_build_space_access.space_id
      and s.owner_id = auth.uid()
  )
);

create policy "user_build_space_access_update_owner"
on public.user_build_space_access
for update
to authenticated
using (
  exists (
    select 1
    from public.user_build_spaces s
    where s.id = user_build_space_access.space_id
      and s.owner_id = auth.uid()
  )
)
with check (
  granted_by = auth.uid()
  and exists (
    select 1
    from public.user_build_spaces s
    where s.id = user_build_space_access.space_id
      and s.owner_id = auth.uid()
  )
);

create policy "user_build_space_access_delete_owner"
on public.user_build_space_access
for delete
to authenticated
using (
  exists (
    select 1
    from public.user_build_spaces s
    where s.id = user_build_space_access.space_id
      and s.owner_id = auth.uid()
  )
);
