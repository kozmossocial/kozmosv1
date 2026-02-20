create extension if not exists pgcrypto;

create table if not exists public.spice_supply (
  id smallint primary key default 1 check (id = 1),
  max_supply bigint not null check (max_supply > 0),
  minted_supply bigint not null default 0 check (minted_supply >= 0 and minted_supply <= max_supply),
  updated_at timestamptz not null default now()
);

insert into public.spice_supply (id, max_supply, minted_supply)
values (1, 50000000000, 0)
on conflict (id)
do update set max_supply = excluded.max_supply;

create table if not exists public.spice_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  wallet_address text not null unique default ('kz1_' || encode(gen_random_bytes(20), 'hex')),
  balance bigint not null default 0 check (balance >= 0),
  lifetime_earned bigint not null default 0 check (lifetime_earned >= 0),
  lifetime_spent bigint not null default 0 check (lifetime_spent >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.spice_ledger (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount bigint not null check (amount <> 0),
  event_type text not null,
  ref_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists spice_ledger_user_created_idx
  on public.spice_ledger (user_id, created_at desc);

create unique index if not exists spice_ledger_user_ref_unique_idx
  on public.spice_ledger (user_id, ref_key)
  where ref_key is not null;

create or replace function public.touch_spice_wallets_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_spice_wallets_updated_at on public.spice_wallets;
create trigger trg_touch_spice_wallets_updated_at
before update on public.spice_wallets
for each row execute function public.touch_spice_wallets_updated_at();

alter table public.spice_wallets enable row level security;
alter table public.spice_ledger enable row level security;

drop policy if exists "spice_wallets_select_own" on public.spice_wallets;
drop policy if exists "spice_ledger_select_own" on public.spice_ledger;

create policy "spice_wallets_select_own"
on public.spice_wallets
for select
to authenticated
using (auth.uid() = user_id);

create policy "spice_ledger_select_own"
on public.spice_ledger
for select
to authenticated
using (auth.uid() = user_id);

create or replace function public.spice_credit(
  p_user_id uuid,
  p_amount bigint,
  p_event_type text,
  p_ref_key text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
as $$
declare
  v_supply public.spice_supply%rowtype;
begin
  if p_user_id is null or p_amount is null or p_amount <= 0 then
    return false;
  end if;

  if p_event_type is null or char_length(trim(p_event_type)) = 0 then
    return false;
  end if;

  if p_ref_key is not null and exists (
    select 1
    from public.spice_ledger
    where user_id = p_user_id and ref_key = p_ref_key
  ) then
    return false;
  end if;

  insert into public.spice_wallets (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select *
  into v_supply
  from public.spice_supply
  where id = 1
  for update;

  if not found then
    insert into public.spice_supply (id, max_supply, minted_supply)
    values (1, 50000000000, 0)
    on conflict (id) do nothing;

    select *
    into v_supply
    from public.spice_supply
    where id = 1
    for update;
  end if;

  if v_supply.minted_supply + p_amount > v_supply.max_supply then
    return false;
  end if;

  update public.spice_wallets
  set
    balance = balance + p_amount,
    lifetime_earned = lifetime_earned + p_amount,
    updated_at = now()
  where user_id = p_user_id;

  insert into public.spice_ledger (user_id, amount, event_type, ref_key, metadata)
  values (
    p_user_id,
    p_amount,
    trim(p_event_type),
    nullif(trim(coalesce(p_ref_key, '')), ''),
    coalesce(p_metadata, '{}'::jsonb)
  );

  update public.spice_supply
  set
    minted_supply = minted_supply + p_amount,
    updated_at = now()
  where id = 1;

  return true;
exception
  when unique_violation then
    return false;
end;
$$;

create or replace function public.spice_transfer(
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_amount bigint,
  p_ref_key text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
as $$
declare
  v_from_balance bigint;
  v_ref text;
begin
  if p_from_user_id is null or p_to_user_id is null or p_from_user_id = p_to_user_id then
    return false;
  end if;

  if p_amount is null or p_amount <= 0 then
    return false;
  end if;

  v_ref = nullif(trim(coalesce(p_ref_key, '')), '');

  insert into public.spice_wallets (user_id)
  values (p_from_user_id)
  on conflict (user_id) do nothing;

  insert into public.spice_wallets (user_id)
  values (p_to_user_id)
  on conflict (user_id) do nothing;

  perform 1
  from public.spice_wallets
  where user_id in (p_from_user_id, p_to_user_id)
  order by user_id
  for update;

  select balance
  into v_from_balance
  from public.spice_wallets
  where user_id = p_from_user_id;

  if coalesce(v_from_balance, 0) < p_amount then
    return false;
  end if;

  update public.spice_wallets
  set
    balance = balance - p_amount,
    lifetime_spent = lifetime_spent + p_amount,
    updated_at = now()
  where user_id = p_from_user_id;

  update public.spice_wallets
  set
    balance = balance + p_amount,
    lifetime_earned = lifetime_earned + p_amount,
    updated_at = now()
  where user_id = p_to_user_id;

  insert into public.spice_ledger (user_id, amount, event_type, ref_key, metadata)
  values (
    p_from_user_id,
    -p_amount,
    'transfer_out',
    case when v_ref is null then null else v_ref || ':out' end,
    coalesce(p_metadata, '{}'::jsonb)
  );

  insert into public.spice_ledger (user_id, amount, event_type, ref_key, metadata)
  values (
    p_to_user_id,
    p_amount,
    'transfer_in',
    case when v_ref is null then null else v_ref || ':in' end,
    coalesce(p_metadata, '{}'::jsonb)
  );

  return true;
exception
  when unique_violation then
    return false;
end;
$$;

revoke all on function public.spice_credit(uuid, bigint, text, text, jsonb) from public;
revoke all on function public.spice_transfer(uuid, uuid, bigint, text, jsonb) from public;
grant execute on function public.spice_credit(uuid, bigint, text, text, jsonb) to service_role;
grant execute on function public.spice_transfer(uuid, uuid, bigint, text, jsonb) to service_role;

create or replace function public.spice_on_profile_insert()
returns trigger
language plpgsql
as $$
begin
  perform public.spice_credit(
    new.id,
    100,
    'signup',
    'signup:' || new.id::text,
    jsonb_build_object('source', 'profileskozmos')
  );
  return new;
end;
$$;

create or replace function public.spice_on_main_message_insert()
returns trigger
language plpgsql
as $$
begin
  perform public.spice_credit(
    new.user_id,
    10,
    'main_chat_post',
    'main_chat:' || new.id::text,
    jsonb_build_object('table', 'main_messages')
  );
  return new;
end;
$$;

create or replace function public.spice_on_build_message_insert()
returns trigger
language plpgsql
as $$
begin
  perform public.spice_credit(
    new.user_id,
    100,
    'build_contribution',
    'build_chat:' || new.id::text,
    jsonb_build_object('table', 'build_chat_messages')
  );
  return new;
end;
$$;

create or replace function public.spice_on_keep_in_touch_update()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'accepted' and coalesce(old.status, '') <> 'accepted' then
    perform public.spice_credit(
      new.requester_id,
      20,
      'friend_connected',
      'friend:' || new.id::text || ':requester',
      jsonb_build_object('request_id', new.id)
    );

    perform public.spice_credit(
      new.requested_id,
      20,
      'friend_connected',
      'friend:' || new.id::text || ':requested',
      jsonb_build_object('request_id', new.id)
    );
  end if;

  return new;
end;
$$;

do $$
begin
  if to_regclass('public.profileskozmos') is not null then
    execute 'drop trigger if exists trg_spice_profile_insert on public.profileskozmos';
    execute 'create trigger trg_spice_profile_insert after insert on public.profileskozmos for each row execute function public.spice_on_profile_insert()';
  end if;

  if to_regclass('public.main_messages') is not null then
    execute 'drop trigger if exists trg_spice_main_message_insert on public.main_messages';
    execute 'create trigger trg_spice_main_message_insert after insert on public.main_messages for each row execute function public.spice_on_main_message_insert()';
  end if;

  if to_regclass('public.build_chat_messages') is not null then
    execute 'drop trigger if exists trg_spice_build_message_insert on public.build_chat_messages';
    execute 'create trigger trg_spice_build_message_insert after insert on public.build_chat_messages for each row execute function public.spice_on_build_message_insert()';
  end if;

  if to_regclass('public.keep_in_touch_requests') is not null then
    execute 'drop trigger if exists trg_spice_keep_in_touch_update on public.keep_in_touch_requests';
    execute 'create trigger trg_spice_keep_in_touch_update after update on public.keep_in_touch_requests for each row execute function public.spice_on_keep_in_touch_update()';
  end if;
end;
$$;

do $$
declare
  v_profile record;
begin
  if to_regclass('public.profileskozmos') is null then
    return;
  end if;

  for v_profile in select id from public.profileskozmos loop
    perform public.spice_credit(
      v_profile.id,
      1000,
      'og_bonus',
      'og_bonus:20260220',
      jsonb_build_object('note', 'existing account bonus')
    );
  end loop;
end;
$$;
