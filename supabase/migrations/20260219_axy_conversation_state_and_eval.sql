create table if not exists public.axy_conversation_state (
  conversation_key text primary key,
  active_intent text not null default 'unknown',
  pending_tasks jsonb not null default '[]'::jsonb,
  user_preferences jsonb not null default '[]'::jsonb,
  social_signals jsonb not null default '[]'::jsonb,
  build_history jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists axy_conversation_state_updated_idx
  on public.axy_conversation_state (updated_at desc);

create table if not exists public.axy_reply_events (
  id bigserial primary key,
  mode text not null check (mode in ('chat', 'reflect')),
  channel text not null default 'unknown',
  conversation_key text not null,
  intent text not null default 'unknown',
  sent boolean not null default true,
  drop_reason text,
  latency_ms integer not null default 0,
  duplicate_score numeric(5,4) not null default 0,
  initiative text not null default 'low',
  created_at timestamptz not null default now()
);

create index if not exists axy_reply_events_created_idx
  on public.axy_reply_events (created_at desc);

create index if not exists axy_reply_events_channel_created_idx
  on public.axy_reply_events (channel, created_at desc);

alter table public.axy_conversation_state enable row level security;
alter table public.axy_reply_events enable row level security;

