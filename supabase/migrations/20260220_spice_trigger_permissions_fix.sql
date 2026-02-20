-- Fix: ensure Spice trigger chain can run under authenticated inserts
-- without exposing direct mint/transfer RPC calls to clients.

create or replace function public.spice_credit(
  p_user_id uuid,
  p_amount bigint,
  p_event_type text,
  p_ref_key text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
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
security definer
set search_path = public
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

create or replace function public.spice_on_profile_insert()
returns trigger
language plpgsql
security definer
set search_path = public
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
security definer
set search_path = public
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
security definer
set search_path = public
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
security definer
set search_path = public
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