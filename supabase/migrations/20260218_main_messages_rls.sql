alter table if exists public.main_messages enable row level security;

drop policy if exists "main_messages_select_authenticated"
  on public.main_messages;
drop policy if exists "main_messages_insert_own"
  on public.main_messages;
drop policy if exists "main_messages_delete_own"
  on public.main_messages;

create policy "main_messages_select_authenticated"
on public.main_messages
for select
to authenticated
using (true);

create policy "main_messages_insert_own"
on public.main_messages
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "main_messages_delete_own"
on public.main_messages
for delete
to authenticated
using (auth.uid() = user_id);
