alter table public.profileskozmos
  add column if not exists orb_color text not null default '#7df9ff';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profileskozmos_orb_color_hex_chk'
  ) then
    alter table public.profileskozmos
      add constraint profileskozmos_orb_color_hex_chk
      check (orb_color ~ '^#[0-9A-Fa-f]{6}$');
  end if;
end
$$;
