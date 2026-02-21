create table if not exists public.user_username_change_codes (
  id bigserial primary key,
  user_id uuid not null references public.profileskozmos(id) on delete cascade,
  code_hash text not null,
  request_ip text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempt_count integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists user_username_change_codes_user_created_idx
  on public.user_username_change_codes (user_id, created_at desc);

create index if not exists user_username_change_codes_expires_idx
  on public.user_username_change_codes (expires_at desc);

create index if not exists user_username_change_codes_ip_created_idx
  on public.user_username_change_codes (request_ip, created_at desc);
