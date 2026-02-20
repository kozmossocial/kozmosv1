create table if not exists public.user_build_backend_modes (
  space_id uuid primary key references public.user_build_spaces(id) on delete cascade,
  enabled boolean not null default false,
  posts_quota integer not null default 2000 check (posts_quota between 100 and 20000),
  comments_quota integer not null default 10000 check (comments_quota between 200 and 100000),
  likes_quota integer not null default 40000 check (likes_quota between 500 and 200000),
  dm_threads_quota integer not null default 500 check (dm_threads_quota between 20 and 5000),
  dm_messages_quota integer not null default 60000 check (dm_messages_quota between 500 and 400000),
  updated_by uuid not null references public.profileskozmos(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_build_backend_posts (
  id bigserial primary key,
  space_id uuid not null references public.user_build_spaces(id) on delete cascade,
  author_id uuid not null references public.profileskozmos(id) on delete cascade,
  body text not null default '' check (char_length(body) between 1 and 5000),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id, id)
);

create table if not exists public.user_build_backend_comments (
  id bigserial primary key,
  space_id uuid not null references public.user_build_spaces(id) on delete cascade,
  post_id bigint not null,
  author_id uuid not null references public.profileskozmos(id) on delete cascade,
  body text not null default '' check (char_length(body) between 1 and 3000),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id, id),
  constraint user_build_backend_comments_post_fk
    foreign key (space_id, post_id)
    references public.user_build_backend_posts(space_id, id)
    on delete cascade
);

create table if not exists public.user_build_backend_likes (
  id bigserial primary key,
  space_id uuid not null references public.user_build_spaces(id) on delete cascade,
  post_id bigint not null,
  user_id uuid not null references public.profileskozmos(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (space_id, post_id, user_id),
  constraint user_build_backend_likes_post_fk
    foreign key (space_id, post_id)
    references public.user_build_backend_posts(space_id, id)
    on delete cascade
);

create table if not exists public.user_build_backend_dm_threads (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.user_build_spaces(id) on delete cascade,
  created_by uuid not null references public.profileskozmos(id) on delete cascade,
  subject text not null default '' check (char_length(subject) <= 160),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id, id)
);

create table if not exists public.user_build_backend_dm_participants (
  id bigserial primary key,
  space_id uuid not null references public.user_build_spaces(id) on delete cascade,
  thread_id uuid not null,
  user_id uuid not null references public.profileskozmos(id) on delete cascade,
  can_write boolean not null default true,
  created_at timestamptz not null default now(),
  unique (thread_id, user_id),
  constraint user_build_backend_dm_participants_thread_fk
    foreign key (space_id, thread_id)
    references public.user_build_backend_dm_threads(space_id, id)
    on delete cascade
);

create table if not exists public.user_build_backend_dm_messages (
  id bigserial primary key,
  space_id uuid not null references public.user_build_spaces(id) on delete cascade,
  thread_id uuid not null,
  sender_id uuid not null references public.profileskozmos(id) on delete cascade,
  body text not null default '' check (char_length(body) between 1 and 4000),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint user_build_backend_dm_messages_thread_fk
    foreign key (space_id, thread_id)
    references public.user_build_backend_dm_threads(space_id, id)
    on delete cascade
);

create index if not exists user_build_backend_modes_updated_idx
  on public.user_build_backend_modes (updated_at desc);

create index if not exists user_build_backend_posts_space_created_idx
  on public.user_build_backend_posts (space_id, created_at desc);

create index if not exists user_build_backend_posts_author_idx
  on public.user_build_backend_posts (author_id, created_at desc);

create index if not exists user_build_backend_comments_space_post_created_idx
  on public.user_build_backend_comments (space_id, post_id, created_at asc);

create index if not exists user_build_backend_comments_author_idx
  on public.user_build_backend_comments (author_id, created_at desc);

create index if not exists user_build_backend_likes_space_post_idx
  on public.user_build_backend_likes (space_id, post_id, created_at desc);

create index if not exists user_build_backend_likes_user_idx
  on public.user_build_backend_likes (user_id, created_at desc);

create index if not exists user_build_backend_dm_threads_space_updated_idx
  on public.user_build_backend_dm_threads (space_id, updated_at desc);

create index if not exists user_build_backend_dm_participants_thread_idx
  on public.user_build_backend_dm_participants (thread_id, created_at asc);

create index if not exists user_build_backend_dm_participants_user_idx
  on public.user_build_backend_dm_participants (user_id, created_at desc);

create index if not exists user_build_backend_dm_messages_thread_created_idx
  on public.user_build_backend_dm_messages (thread_id, created_at asc);

create index if not exists user_build_backend_dm_messages_sender_idx
  on public.user_build_backend_dm_messages (sender_id, created_at desc);

create or replace function public.touch_user_build_backend_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_user_build_backend_modes_updated_at
  on public.user_build_backend_modes;
create trigger trg_touch_user_build_backend_modes_updated_at
before update on public.user_build_backend_modes
for each row execute function public.touch_user_build_backend_updated_at();

drop trigger if exists trg_touch_user_build_backend_posts_updated_at
  on public.user_build_backend_posts;
create trigger trg_touch_user_build_backend_posts_updated_at
before update on public.user_build_backend_posts
for each row execute function public.touch_user_build_backend_updated_at();

drop trigger if exists trg_touch_user_build_backend_comments_updated_at
  on public.user_build_backend_comments;
create trigger trg_touch_user_build_backend_comments_updated_at
before update on public.user_build_backend_comments
for each row execute function public.touch_user_build_backend_updated_at();

drop trigger if exists trg_touch_user_build_backend_dm_threads_updated_at
  on public.user_build_backend_dm_threads;
create trigger trg_touch_user_build_backend_dm_threads_updated_at
before update on public.user_build_backend_dm_threads
for each row execute function public.touch_user_build_backend_updated_at();

create or replace function public.user_build_space_can_read(
  p_space_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_build_spaces s
    where s.id = p_space_id
      and (
        s.owner_id = p_user_id
        or s.is_public = true
        or exists (
          select 1
          from public.user_build_space_access a
          where a.space_id = s.id
            and a.user_id = p_user_id
        )
      )
  );
$$;

create or replace function public.user_build_space_can_edit(
  p_space_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_build_spaces s
    where s.id = p_space_id
      and (
        s.owner_id = p_user_id
        or exists (
          select 1
          from public.user_build_space_access a
          where a.space_id = s.id
            and a.user_id = p_user_id
            and a.can_edit = true
        )
      )
  );
$$;

create or replace function public.user_build_dm_thread_is_participant(
  p_thread_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_build_backend_dm_participants p
    where p.thread_id = p_thread_id
      and p.user_id = p_user_id
  );
$$;

create or replace function public.user_build_dm_thread_can_read(
  p_thread_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_build_backend_dm_threads t
    where t.id = p_thread_id
      and (
        public.user_build_dm_thread_is_participant(t.id, p_user_id)
        or exists (
          select 1
          from public.user_build_spaces s
          where s.id = t.space_id
            and s.owner_id = p_user_id
        )
      )
  );
$$;

create or replace function public.user_build_dm_thread_can_moderate(
  p_thread_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_build_backend_dm_threads t
    where t.id = p_thread_id
      and (
        t.created_by = p_user_id
        or exists (
          select 1
          from public.user_build_spaces s
          where s.id = t.space_id
            and s.owner_id = p_user_id
        )
      )
  );
$$;

create or replace function public.assert_user_build_backend_quota()
returns trigger
language plpgsql
as $$
declare
  mode_enabled boolean := false;
  q_posts integer := 2000;
  q_comments integer := 10000;
  q_likes integer := 40000;
  q_dm_threads integer := 500;
  q_dm_messages integer := 60000;
  current_count integer := 0;
begin
  if tg_op <> 'INSERT' then
    return new;
  end if;

  select
    m.enabled,
    m.posts_quota,
    m.comments_quota,
    m.likes_quota,
    m.dm_threads_quota,
    m.dm_messages_quota
  into
    mode_enabled,
    q_posts,
    q_comments,
    q_likes,
    q_dm_threads,
    q_dm_messages
  from public.user_build_backend_modes m
  where m.space_id = new.space_id;

  if coalesce(mode_enabled, false) = false then
    raise exception 'starter mode disabled for this space';
  end if;

  if tg_table_name = 'user_build_backend_posts' then
    select count(*) into current_count
    from public.user_build_backend_posts p
    where p.space_id = new.space_id;
    if current_count >= coalesce(q_posts, 2000) then
      raise exception 'starter quota exceeded: posts';
    end if;
    return new;
  end if;

  if tg_table_name = 'user_build_backend_comments' then
    select count(*) into current_count
    from public.user_build_backend_comments c
    where c.space_id = new.space_id;
    if current_count >= coalesce(q_comments, 10000) then
      raise exception 'starter quota exceeded: comments';
    end if;
    return new;
  end if;

  if tg_table_name = 'user_build_backend_likes' then
    select count(*) into current_count
    from public.user_build_backend_likes l
    where l.space_id = new.space_id;
    if current_count >= coalesce(q_likes, 40000) then
      raise exception 'starter quota exceeded: likes';
    end if;
    return new;
  end if;

  if tg_table_name = 'user_build_backend_dm_threads' then
    select count(*) into current_count
    from public.user_build_backend_dm_threads t
    where t.space_id = new.space_id;
    if current_count >= coalesce(q_dm_threads, 500) then
      raise exception 'starter quota exceeded: dm_threads';
    end if;
    return new;
  end if;

  if tg_table_name = 'user_build_backend_dm_messages' then
    select count(*) into current_count
    from public.user_build_backend_dm_messages m
    where m.space_id = new.space_id;
    if current_count >= coalesce(q_dm_messages, 60000) then
      raise exception 'starter quota exceeded: dm_messages';
    end if;
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_assert_user_build_backend_posts_quota
  on public.user_build_backend_posts;
create trigger trg_assert_user_build_backend_posts_quota
before insert on public.user_build_backend_posts
for each row execute function public.assert_user_build_backend_quota();

drop trigger if exists trg_assert_user_build_backend_comments_quota
  on public.user_build_backend_comments;
create trigger trg_assert_user_build_backend_comments_quota
before insert on public.user_build_backend_comments
for each row execute function public.assert_user_build_backend_quota();

drop trigger if exists trg_assert_user_build_backend_likes_quota
  on public.user_build_backend_likes;
create trigger trg_assert_user_build_backend_likes_quota
before insert on public.user_build_backend_likes
for each row execute function public.assert_user_build_backend_quota();

drop trigger if exists trg_assert_user_build_backend_dm_threads_quota
  on public.user_build_backend_dm_threads;
create trigger trg_assert_user_build_backend_dm_threads_quota
before insert on public.user_build_backend_dm_threads
for each row execute function public.assert_user_build_backend_quota();

drop trigger if exists trg_assert_user_build_backend_dm_messages_quota
  on public.user_build_backend_dm_messages;
create trigger trg_assert_user_build_backend_dm_messages_quota
before insert on public.user_build_backend_dm_messages
for each row execute function public.assert_user_build_backend_quota();

alter table public.user_build_backend_modes enable row level security;
alter table public.user_build_backend_posts enable row level security;
alter table public.user_build_backend_comments enable row level security;
alter table public.user_build_backend_likes enable row level security;
alter table public.user_build_backend_dm_threads enable row level security;
alter table public.user_build_backend_dm_participants enable row level security;
alter table public.user_build_backend_dm_messages enable row level security;

drop policy if exists "user_build_backend_modes_select_accessible"
  on public.user_build_backend_modes;
drop policy if exists "user_build_backend_modes_insert_editable"
  on public.user_build_backend_modes;
drop policy if exists "user_build_backend_modes_update_editable"
  on public.user_build_backend_modes;
drop policy if exists "user_build_backend_modes_delete_editable"
  on public.user_build_backend_modes;

create policy "user_build_backend_modes_select_accessible"
on public.user_build_backend_modes
for select
to authenticated
using (public.user_build_space_can_read(space_id, auth.uid()));

create policy "user_build_backend_modes_insert_editable"
on public.user_build_backend_modes
for insert
to authenticated
with check (
  updated_by = auth.uid()
  and public.user_build_space_can_edit(space_id, auth.uid())
);

create policy "user_build_backend_modes_update_editable"
on public.user_build_backend_modes
for update
to authenticated
using (public.user_build_space_can_edit(space_id, auth.uid()))
with check (
  updated_by = auth.uid()
  and public.user_build_space_can_edit(space_id, auth.uid())
);

create policy "user_build_backend_modes_delete_editable"
on public.user_build_backend_modes
for delete
to authenticated
using (public.user_build_space_can_edit(space_id, auth.uid()));

drop policy if exists "user_build_backend_posts_select_accessible"
  on public.user_build_backend_posts;
drop policy if exists "user_build_backend_posts_insert_accessible"
  on public.user_build_backend_posts;
drop policy if exists "user_build_backend_posts_update_owner"
  on public.user_build_backend_posts;
drop policy if exists "user_build_backend_posts_delete_owner"
  on public.user_build_backend_posts;

create policy "user_build_backend_posts_select_accessible"
on public.user_build_backend_posts
for select
to authenticated
using (public.user_build_space_can_read(space_id, auth.uid()));

create policy "user_build_backend_posts_insert_accessible"
on public.user_build_backend_posts
for insert
to authenticated
with check (
  author_id = auth.uid()
  and public.user_build_space_can_read(space_id, auth.uid())
);

create policy "user_build_backend_posts_update_owner"
on public.user_build_backend_posts
for update
to authenticated
using (
  author_id = auth.uid()
  or public.user_build_space_can_edit(space_id, auth.uid())
)
with check (
  author_id = auth.uid()
  or public.user_build_space_can_edit(space_id, auth.uid())
);

create policy "user_build_backend_posts_delete_owner"
on public.user_build_backend_posts
for delete
to authenticated
using (
  author_id = auth.uid()
  or public.user_build_space_can_edit(space_id, auth.uid())
);

drop policy if exists "user_build_backend_comments_select_accessible"
  on public.user_build_backend_comments;
drop policy if exists "user_build_backend_comments_insert_accessible"
  on public.user_build_backend_comments;
drop policy if exists "user_build_backend_comments_update_owner"
  on public.user_build_backend_comments;
drop policy if exists "user_build_backend_comments_delete_owner"
  on public.user_build_backend_comments;

create policy "user_build_backend_comments_select_accessible"
on public.user_build_backend_comments
for select
to authenticated
using (public.user_build_space_can_read(space_id, auth.uid()));

create policy "user_build_backend_comments_insert_accessible"
on public.user_build_backend_comments
for insert
to authenticated
with check (
  author_id = auth.uid()
  and public.user_build_space_can_read(space_id, auth.uid())
);

create policy "user_build_backend_comments_update_owner"
on public.user_build_backend_comments
for update
to authenticated
using (
  author_id = auth.uid()
  or public.user_build_space_can_edit(space_id, auth.uid())
)
with check (
  author_id = auth.uid()
  or public.user_build_space_can_edit(space_id, auth.uid())
);

create policy "user_build_backend_comments_delete_owner"
on public.user_build_backend_comments
for delete
to authenticated
using (
  author_id = auth.uid()
  or public.user_build_space_can_edit(space_id, auth.uid())
);

drop policy if exists "user_build_backend_likes_select_accessible"
  on public.user_build_backend_likes;
drop policy if exists "user_build_backend_likes_insert_accessible"
  on public.user_build_backend_likes;
drop policy if exists "user_build_backend_likes_delete_owner"
  on public.user_build_backend_likes;

create policy "user_build_backend_likes_select_accessible"
on public.user_build_backend_likes
for select
to authenticated
using (public.user_build_space_can_read(space_id, auth.uid()));

create policy "user_build_backend_likes_insert_accessible"
on public.user_build_backend_likes
for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.user_build_space_can_read(space_id, auth.uid())
);

create policy "user_build_backend_likes_delete_owner"
on public.user_build_backend_likes
for delete
to authenticated
using (
  user_id = auth.uid()
  or public.user_build_space_can_edit(space_id, auth.uid())
);

drop policy if exists "user_build_backend_dm_threads_select_participant"
  on public.user_build_backend_dm_threads;
drop policy if exists "user_build_backend_dm_threads_insert_accessible"
  on public.user_build_backend_dm_threads;
drop policy if exists "user_build_backend_dm_threads_update_moderator"
  on public.user_build_backend_dm_threads;
drop policy if exists "user_build_backend_dm_threads_delete_moderator"
  on public.user_build_backend_dm_threads;

create policy "user_build_backend_dm_threads_select_participant"
on public.user_build_backend_dm_threads
for select
to authenticated
using (public.user_build_dm_thread_can_read(id, auth.uid()));

create policy "user_build_backend_dm_threads_insert_accessible"
on public.user_build_backend_dm_threads
for insert
to authenticated
with check (
  created_by = auth.uid()
  and public.user_build_space_can_read(space_id, auth.uid())
);

create policy "user_build_backend_dm_threads_update_moderator"
on public.user_build_backend_dm_threads
for update
to authenticated
using (public.user_build_dm_thread_can_moderate(id, auth.uid()))
with check (public.user_build_dm_thread_can_moderate(id, auth.uid()));

create policy "user_build_backend_dm_threads_delete_moderator"
on public.user_build_backend_dm_threads
for delete
to authenticated
using (public.user_build_dm_thread_can_moderate(id, auth.uid()));

drop policy if exists "user_build_backend_dm_participants_select_participant"
  on public.user_build_backend_dm_participants;
drop policy if exists "user_build_backend_dm_participants_insert_moderator"
  on public.user_build_backend_dm_participants;
drop policy if exists "user_build_backend_dm_participants_update_moderator"
  on public.user_build_backend_dm_participants;
drop policy if exists "user_build_backend_dm_participants_delete_moderator"
  on public.user_build_backend_dm_participants;

create policy "user_build_backend_dm_participants_select_participant"
on public.user_build_backend_dm_participants
for select
to authenticated
using (public.user_build_dm_thread_can_read(thread_id, auth.uid()));

create policy "user_build_backend_dm_participants_insert_moderator"
on public.user_build_backend_dm_participants
for insert
to authenticated
with check (
  public.user_build_dm_thread_can_moderate(thread_id, auth.uid())
  and public.user_build_space_can_read(space_id, auth.uid())
);

create policy "user_build_backend_dm_participants_update_moderator"
on public.user_build_backend_dm_participants
for update
to authenticated
using (public.user_build_dm_thread_can_moderate(thread_id, auth.uid()))
with check (
  public.user_build_dm_thread_can_moderate(thread_id, auth.uid())
  and public.user_build_space_can_read(space_id, auth.uid())
);

create policy "user_build_backend_dm_participants_delete_moderator"
on public.user_build_backend_dm_participants
for delete
to authenticated
using (public.user_build_dm_thread_can_moderate(thread_id, auth.uid()));

drop policy if exists "user_build_backend_dm_messages_select_participant"
  on public.user_build_backend_dm_messages;
drop policy if exists "user_build_backend_dm_messages_insert_participant"
  on public.user_build_backend_dm_messages;
drop policy if exists "user_build_backend_dm_messages_delete_owner"
  on public.user_build_backend_dm_messages;

create policy "user_build_backend_dm_messages_select_participant"
on public.user_build_backend_dm_messages
for select
to authenticated
using (public.user_build_dm_thread_can_read(thread_id, auth.uid()));

create policy "user_build_backend_dm_messages_insert_participant"
on public.user_build_backend_dm_messages
for insert
to authenticated
with check (
  sender_id = auth.uid()
  and public.user_build_dm_thread_is_participant(thread_id, auth.uid())
  and public.user_build_space_can_read(space_id, auth.uid())
);

create policy "user_build_backend_dm_messages_delete_owner"
on public.user_build_backend_dm_messages
for delete
to authenticated
using (
  sender_id = auth.uid()
  or public.user_build_dm_thread_can_moderate(thread_id, auth.uid())
);
