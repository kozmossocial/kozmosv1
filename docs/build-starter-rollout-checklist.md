# Build Starter Rollout Checklist

## 1) Migration Order

Run these in order:

1. `supabase/migrations/20260220_build_runtime_kv.sql`
2. `supabase/migrations/20260220_runtime_axy_missions.sql`
3. `supabase/migrations/20260220_build_starter_backend.sql`
4. `supabase/migrations/20260220_build_starter_auth_social.sql`
5. `supabase/migrations/20260220_build_starter_hardening.sql`

After apply, run:

```sql
select to_regclass('public.user_build_runtime_kv');
select to_regclass('public.runtime_axy_missions');
select to_regclass('public.user_build_starter_users');
select to_regclass('public.user_build_starter_sessions');
select to_regclass('public.user_build_starter_friend_requests');
select to_regclass('public.user_build_starter_friendships');
```

All rows should return a non-null relation name.

## 2) Required Env (Vercel + Local)

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `KOZMOS_BUILD_PROXY_ALLOWLIST`  
  Example: `api.openai.com,*.supabase.co`
- `KOZMOS_STARTER_SESSION_DAYS` (optional, default `30`)

## 3) Deploy Checks

1. `npm run build`
2. Open `/build`
3. Create subspace + `index.html`
4. Confirm preview renders HTML (no `No HTML entry found`)
5. Call `window.KozmosRuntime.kvSet` and `kvGet` from preview
6. Confirm proxy rejects non-allowlisted host with `403`
7. Confirm allowlisted host request succeeds
8. Confirm starter auth flow:
   - register
   - login
   - me (`/starter/auth` GET)
   - logout
9. Confirm starter primitives:
   - posts/comments/likes
   - dm threads/messages
   - friend request + accept
10. Confirm ZIP export works for owner only and contains:
   - subspace files
   - `.kozmos/starter-data.json`

## 4) Smoke API List

- `GET /api/build/runtime/starter/auth`
- `POST /api/build/runtime/starter/auth`
- `GET|POST /api/build/runtime/starter/posts`
- `GET|POST /api/build/runtime/starter/comments`
- `GET|PUT|DELETE /api/build/runtime/starter/likes`
- `GET|POST /api/build/runtime/starter/dm/threads`
- `GET|POST /api/build/runtime/starter/dm/messages`
- `GET|POST|PATCH|DELETE /api/build/runtime/starter/friends`
- `GET|PUT /api/build/export/starter-data`
- `GET /api/build/export/zip`

## 5) Rollback Plan

If rollout is blocked:

1. Disable starter mode for affected space:

```sql
update public.user_build_backend_modes
set enabled = false
where space_id = '<space_id>';
```

2. Remove new API usage from client (keep legacy editor flow).
3. Keep data intact; do not drop starter tables unless explicit migration rollback is prepared.
