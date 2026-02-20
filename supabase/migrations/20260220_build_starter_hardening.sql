alter table public.user_build_backend_posts
  drop constraint if exists user_build_backend_posts_author_id_fkey;

alter table public.user_build_backend_comments
  drop constraint if exists user_build_backend_comments_author_id_fkey;

alter table public.user_build_backend_likes
  drop constraint if exists user_build_backend_likes_user_id_fkey;

alter table public.user_build_backend_dm_threads
  drop constraint if exists user_build_backend_dm_threads_created_by_fkey;

alter table public.user_build_backend_dm_participants
  drop constraint if exists user_build_backend_dm_participants_user_id_fkey;

alter table public.user_build_backend_dm_messages
  drop constraint if exists user_build_backend_dm_messages_sender_id_fkey;

drop policy if exists "user_build_starter_users_select_accessible"
  on public.user_build_starter_users;

drop policy if exists "user_build_starter_users_mutate_editable"
  on public.user_build_starter_users;

drop policy if exists "user_build_starter_users_select_editable"
  on public.user_build_starter_users;

drop policy if exists "user_build_starter_sessions_select_editable"
  on public.user_build_starter_sessions;

drop policy if exists "user_build_starter_sessions_mutate_editable"
  on public.user_build_starter_sessions;

create policy "user_build_starter_users_select_editable"
on public.user_build_starter_users
for select
to authenticated
using (public.user_build_space_can_edit(space_id, auth.uid()));

drop policy if exists "user_build_starter_users_insert_editable"
  on public.user_build_starter_users;

create policy "user_build_starter_users_insert_editable"
on public.user_build_starter_users
for insert
to authenticated
with check (public.user_build_space_can_edit(space_id, auth.uid()));

drop policy if exists "user_build_starter_users_update_editable"
  on public.user_build_starter_users;

create policy "user_build_starter_users_update_editable"
on public.user_build_starter_users
for update
to authenticated
using (public.user_build_space_can_edit(space_id, auth.uid()))
with check (public.user_build_space_can_edit(space_id, auth.uid()));

drop policy if exists "user_build_starter_users_delete_editable"
  on public.user_build_starter_users;

create policy "user_build_starter_users_delete_editable"
on public.user_build_starter_users
for delete
to authenticated
using (public.user_build_space_can_edit(space_id, auth.uid()));

drop policy if exists "user_build_starter_sessions_insert_editable"
  on public.user_build_starter_sessions;

create policy "user_build_starter_sessions_insert_editable"
on public.user_build_starter_sessions
for insert
to authenticated
with check (public.user_build_space_can_edit(space_id, auth.uid()));

drop policy if exists "user_build_starter_sessions_update_editable"
  on public.user_build_starter_sessions;

create policy "user_build_starter_sessions_update_editable"
on public.user_build_starter_sessions
for update
to authenticated
using (public.user_build_space_can_edit(space_id, auth.uid()))
with check (public.user_build_space_can_edit(space_id, auth.uid()));

drop policy if exists "user_build_starter_sessions_delete_editable"
  on public.user_build_starter_sessions;

create policy "user_build_starter_sessions_delete_editable"
on public.user_build_starter_sessions
for delete
to authenticated
using (public.user_build_space_can_edit(space_id, auth.uid()));
