alter table public.night_protocol_sessions
  add column if not exists axy_chat_bridge boolean not null default true;

alter table public.night_protocol_sessions
  add column if not exists voting_chat_mode text not null default 'closed'
  check (voting_chat_mode in ('closed', 'open_short'));
