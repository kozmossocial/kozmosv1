-- Axy Advanced Memory System
-- Persistent user memory for cross-session learning

-- User-level memory (persists across sessions)
create table if not exists public.axy_user_memory (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null default '',
  
  -- Interaction stats
  total_interactions integer not null default 0,
  last_interaction_at timestamptz,
  first_interaction_at timestamptz not null default now(),
  
  -- Personality insights (learned from interactions)
  personality_traits jsonb not null default '{}'::jsonb,
  -- Example: { "tone": "casual", "humor_appreciation": 0.7, "technical_level": "advanced" }
  
  -- Topics of interest (weighted)
  interests jsonb not null default '[]'::jsonb,
  -- Example: [{ "topic": "game-dev", "weight": 0.8, "last_mentioned": "2026-02-22" }]
  
  -- Conversation summaries (rolling window)
  conversation_summaries jsonb not null default '[]'::jsonb,
  -- Example: [{ "date": "2026-02-22", "summary": "discussed starfall strategies", "sentiment": "positive" }]
  
  -- Preferences
  preferred_channels jsonb not null default '[]'::jsonb,
  -- Example: ["hush", "dm"]
  
  -- Feedback signals
  positive_interactions integer not null default 0,
  negative_interactions integer not null default 0,
  
  -- Adaptive tone (computed from interactions)
  tone_profile text not null default 'neutral',
  -- Values: 'casual', 'formal', 'playful', 'technical', 'supportive', 'neutral'
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists axy_user_memory_last_interaction_idx
  on public.axy_user_memory (last_interaction_at desc);

create index if not exists axy_user_memory_username_idx
  on public.axy_user_memory (username);

-- Feedback tracking for learning loop
create table if not exists public.axy_feedback (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  channel text not null default 'unknown',
  conversation_key text,
  feedback_type text not null check (feedback_type in ('positive', 'negative', 'neutral', 'explicit_like', 'explicit_dislike', 'continued_engagement', 'abandoned', 'follow_up_question')),
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists axy_feedback_user_idx
  on public.axy_feedback (user_id, created_at desc);

create index if not exists axy_feedback_type_idx
  on public.axy_feedback (feedback_type, created_at desc);

-- Proactive engagement tracking
create table if not exists public.axy_proactive_messages (
  id bigserial primary key,
  target_user_id uuid references auth.users(id) on delete cascade,
  channel text not null,
  message_type text not null check (message_type in ('observation', 'suggestion', 'check_in', 'share_insight', 'build_update', 'question')),
  content text not null,
  response_received boolean not null default false,
  response_sentiment text,
  created_at timestamptz not null default now()
);

create index if not exists axy_proactive_messages_user_idx
  on public.axy_proactive_messages (target_user_id, created_at desc);

-- Multi-space awareness
create table if not exists public.axy_space_state (
  space_id uuid primary key references user_build_spaces(id) on delete cascade,
  last_activity_at timestamptz not null default now(),
  activity_level text not null default 'low' check (activity_level in ('low', 'medium', 'high')),
  active_users jsonb not null default '[]'::jsonb,
  recent_topics jsonb not null default '[]'::jsonb,
  priority_score numeric(5,2) not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists axy_space_state_priority_idx
  on public.axy_space_state (priority_score desc);

-- Learning patterns (aggregated insights)
create table if not exists public.axy_learning_patterns (
  pattern_key text primary key,
  pattern_type text not null check (pattern_type in ('successful_reply', 'failed_reply', 'engagement_driver', 'disengagement_driver', 'topic_correlation', 'tone_effectiveness')),
  pattern_data jsonb not null default '{}'::jsonb,
  confidence numeric(5,4) not null default 0,
  sample_count integer not null default 0,
  last_updated_at timestamptz not null default now()
);

create index if not exists axy_learning_patterns_type_idx
  on public.axy_learning_patterns (pattern_type, confidence desc);

-- RLS policies
alter table public.axy_user_memory enable row level security;
alter table public.axy_feedback enable row level security;
alter table public.axy_proactive_messages enable row level security;
alter table public.axy_space_state enable row level security;
alter table public.axy_learning_patterns enable row level security;

-- Service role can do everything
create policy "Service role full access on axy_user_memory"
  on public.axy_user_memory for all using (true) with check (true);

create policy "Service role full access on axy_feedback"
  on public.axy_feedback for all using (true) with check (true);

create policy "Service role full access on axy_proactive_messages"
  on public.axy_proactive_messages for all using (true) with check (true);

create policy "Service role full access on axy_space_state"
  on public.axy_space_state for all using (true) with check (true);

create policy "Service role full access on axy_learning_patterns"
  on public.axy_learning_patterns for all using (true) with check (true);
