create table if not exists public.runtime_invites (
  id bigserial primary key,
  code_hash text not null unique,
  created_by uuid not null references public.profileskozmos(id) on delete cascade,
  expires_at timestamptz not null,
  max_claims integer not null default 1 check (max_claims >= 1),
  used_claims integer not null default 0 check (used_claims >= 0),
  used_at timestamptz,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists runtime_invites_expires_idx
  on public.runtime_invites (expires_at desc);

create index if not exists runtime_invites_creator_idx
  on public.runtime_invites (created_by, created_at desc);

alter table public.runtime_invites enable row level security;

