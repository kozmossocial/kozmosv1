alter table public.runtime_presence
  add column if not exists username text;

update public.runtime_presence rp
set username = p.username
from public.profileskozmos p
where rp.user_id = p.id
  and (rp.username is null or rp.username = '');

