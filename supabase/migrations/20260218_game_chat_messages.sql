create table if not exists public.game_chat_messages (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  username text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists game_chat_messages_created_idx
  on public.game_chat_messages (created_at desc);

alter table public.game_chat_messages enable row level security;

drop policy if exists "game_chat_messages_select_authenticated"
  on public.game_chat_messages;
drop policy if exists "game_chat_messages_insert_authenticated"
  on public.game_chat_messages;
drop policy if exists "game_chat_messages_delete_own"
  on public.game_chat_messages;

create policy "game_chat_messages_select_authenticated"
on public.game_chat_messages
for select
to authenticated
using (true);

create policy "game_chat_messages_insert_authenticated"
on public.game_chat_messages
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "game_chat_messages_delete_own"
on public.game_chat_messages
for delete
to authenticated
using (auth.uid() = user_id);

do $$
begin
  begin
    alter publication supabase_realtime add table public.game_chat_messages;
  exception
    when duplicate_object then null;
  end;
end
$$;
