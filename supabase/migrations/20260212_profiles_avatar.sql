alter table public.profileskozmos
  add column if not exists avatar_url text;

insert into storage.buckets (id, name, public)
values ('profile-pics', 'profile-pics', true)
on conflict (id) do nothing;

drop policy if exists "profile_pics_public_read" on storage.objects;
drop policy if exists "profile_pics_upload_own" on storage.objects;
drop policy if exists "profile_pics_update_own" on storage.objects;
drop policy if exists "profile_pics_delete_own" on storage.objects;

create policy "profile_pics_public_read"
on storage.objects
for select
to public
using (bucket_id = 'profile-pics');

create policy "profile_pics_upload_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'profile-pics'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "profile_pics_update_own"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'profile-pics'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'profile-pics'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "profile_pics_delete_own"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'profile-pics'
  and (storage.foldername(name))[1] = auth.uid()::text
);
