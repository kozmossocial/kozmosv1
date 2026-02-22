-- AXY UNIFIED ARCHITECTURE MIGRATION
-- Consolidates memory systems, adds cross-channel conversation tracking

-- ==================== GLOBAL CONVERSATION TURNS ====================
-- Single table for all Axy interactions across all channels

create table if not exists public.axy_global_turns (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  username text not null default 'anonymous',
  channel text not null check (channel in ('welcome', 'main', 'my-home', 'build', 'runtime', 'hush', 'dm', 'reflection')),
  conversation_key text not null default 'default',
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists axy_global_turns_user_idx
  on public.axy_global_turns (user_id, created_at desc);

create index if not exists axy_global_turns_channel_idx
  on public.axy_global_turns (channel, created_at desc);

create index if not exists axy_global_turns_conversation_idx
  on public.axy_global_turns (conversation_key, created_at desc);

-- Limit rows per user to prevent unbounded growth
create index if not exists axy_global_turns_cleanup_idx
  on public.axy_global_turns (user_id, id desc);

-- ==================== UNIFIED EVAL TABLE ====================
-- Extends axy_reply_events to cover all channels uniformly

-- First, add missing columns to existing axy_reply_events if it exists
do $$
begin
  -- Add tone_used column if not exists
  if not exists (
    select 1 from information_schema.columns 
    where table_name = 'axy_reply_events' and column_name = 'tone_used'
  ) then
    alter table public.axy_reply_events add column tone_used text default 'neutral';
  end if;

  -- Add was_proactive column if not exists
  if not exists (
    select 1 from information_schema.columns 
    where table_name = 'axy_reply_events' and column_name = 'was_proactive'
  ) then
    alter table public.axy_reply_events add column was_proactive boolean default false;
  end if;

  -- Add user_id column if not exists
  if not exists (
    select 1 from information_schema.columns 
    where table_name = 'axy_reply_events' and column_name = 'user_id'
  ) then
    alter table public.axy_reply_events add column user_id uuid references auth.users(id) on delete set null;
  end if;

  -- Add metadata column if not exists
  if not exists (
    select 1 from information_schema.columns 
    where table_name = 'axy_reply_events' and column_name = 'metadata'
  ) then
    alter table public.axy_reply_events add column metadata jsonb default '{}'::jsonb;
  end if;
exception
  when undefined_table then
    -- Table doesn't exist, will be created by earlier migration
    null;
end $$;

-- ==================== MIGRATE PERSONAL_AXY_MEMORIES TO AXY_USER_MEMORY ====================
-- Merge personal_axy_memories data into the unified axy_user_memory table

-- Add personal_memories column to axy_user_memory for imported data
do $$
begin
  if not exists (
    select 1 from information_schema.columns 
    where table_name = 'axy_user_memory' and column_name = 'personal_memories'
  ) then
    alter table public.axy_user_memory add column personal_memories jsonb default '[]'::jsonb;
  end if;
exception
  when undefined_table then
    -- Table doesn't exist yet
    null;
end $$;

-- Migrate existing personal_axy_memories to axy_user_memory
do $$
declare
  mem_record record;
  existing_memory jsonb;
begin
  -- Check if personal_axy_memories table exists
  if exists (select 1 from information_schema.tables where table_name = 'personal_axy_memories') then
    for mem_record in 
      select user_id, array_agg(
        jsonb_build_object(
          'memory', memory,
          'tags', coalesce(to_jsonb(tags), '[]'::jsonb),
          'salience', salience,
          'created_at', created_at
        )
      ) as memories
      from personal_axy_memories
      group by user_id
    loop
      -- Check if user already has entry in axy_user_memory
      select personal_memories into existing_memory
      from axy_user_memory
      where user_id = mem_record.user_id;

      if found then
        -- Update existing entry
        update axy_user_memory
        set personal_memories = coalesce(existing_memory, '[]'::jsonb) || to_jsonb(mem_record.memories),
            updated_at = now()
        where user_id = mem_record.user_id;
      else
        -- Insert new entry
        insert into axy_user_memory (user_id, username, personal_memories, updated_at)
        values (mem_record.user_id, '', to_jsonb(mem_record.memories), now())
        on conflict (user_id) do update
        set personal_memories = excluded.personal_memories,
            updated_at = now();
      end if;
    end loop;
  end if;
exception
  when undefined_table then
    -- Either source or target table doesn't exist
    null;
end $$;

-- ==================== MIGRATE PERSONAL_AXY_HISTORY TO GLOBAL TURNS ====================

do $$
declare
  turn_record record;
begin
  -- Check if personal_axy_history table exists
  if exists (select 1 from information_schema.tables where table_name = 'personal_axy_history') then
    for turn_record in 
      select user_id, user_message, axy_reply, created_at
      from personal_axy_history
      order by created_at
    loop
      -- Insert user turn
      insert into axy_global_turns (user_id, channel, conversation_key, role, content, created_at)
      values (turn_record.user_id, 'my-home', 'personal:' || turn_record.user_id::text, 'user', turn_record.user_message, turn_record.created_at);

      -- Insert assistant turn
      insert into axy_global_turns (user_id, channel, conversation_key, role, content, created_at)
      values (turn_record.user_id, 'my-home', 'personal:' || turn_record.user_id::text, 'assistant', turn_record.axy_reply, turn_record.created_at + interval '1 second');
    end loop;
  end if;
exception
  when undefined_table then
    null;
end $$;

-- ==================== RLS POLICIES ====================

alter table public.axy_global_turns enable row level security;

-- Service role can do everything
create policy "Service role full access on axy_global_turns"
  on public.axy_global_turns for all using (true) with check (true);

-- ==================== CLEANUP FUNCTION ====================
-- Keeps only last N turns per user to prevent unbounded growth

create or replace function cleanup_old_axy_global_turns(keep_per_user int default 200)
returns int as $$
declare
  deleted_count int;
begin
  with old_turns as (
    select id
    from (
      select id, row_number() over (partition by user_id order by id desc) as rn
      from axy_global_turns
    ) ranked
    where rn > keep_per_user
  )
  delete from axy_global_turns where id in (select id from old_turns);
  
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$ language plpgsql security definer;
