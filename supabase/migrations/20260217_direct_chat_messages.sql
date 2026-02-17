create table if not exists public.direct_chat_messages (
  id bigserial primary key,
  chat_id uuid not null references public.direct_chats(id) on delete cascade,
  sender_id uuid not null references public.profileskozmos(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists direct_chat_messages_chat_created_idx
  on public.direct_chat_messages (chat_id, created_at desc);

alter table public.direct_chat_messages enable row level security;

drop policy if exists "direct_chat_messages_select_involved"
  on public.direct_chat_messages;
drop policy if exists "direct_chat_messages_insert_involved"
  on public.direct_chat_messages;

create policy "direct_chat_messages_select_involved"
on public.direct_chat_messages
for select
to authenticated
using (
  exists (
    select 1
    from public.direct_chats c
    where c.id = direct_chat_messages.chat_id
      and (c.participant_a = auth.uid() or c.participant_b = auth.uid())
  )
);

create policy "direct_chat_messages_insert_involved"
on public.direct_chat_messages
for insert
to authenticated
with check (
  sender_id = auth.uid()
  and exists (
    select 1
    from public.direct_chats c
    where c.id = direct_chat_messages.chat_id
      and (c.participant_a = auth.uid() or c.participant_b = auth.uid())
  )
);
