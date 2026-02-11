# Supabase Service Role Key Rotation

Use this runbook after any accidental key exposure.

## 1) Generate new service role key

1. Supabase Dashboard -> `Project Settings` -> `API Keys`
2. Rotate/regenerate `service_role` key

## 2) Update app secrets immediately

Update both:
- local `.env.local`
- Vercel Environment Variables

Required keys:
- `SUPABASE_SERVICE_ROLE_KEY`
- keep `RUNTIME_BOOTSTRAP_KEY` unchanged unless also exposed

## 3) Redeploy

After updating Vercel env:
1. Trigger `Redeploy` for latest commit
2. Confirm deployment uses new env values

## 4) Revoke runtime tokens (recommended)

If service key was exposed publicly, revoke runtime tokens and issue new ones:

```bash
curl -X POST https://<your-domain>/api/runtime/token/revoke \
  -H "Content-Type: application/json" \
  -H "x-kozmos-bootstrap-key: <RUNTIME_BOOTSTRAP_KEY>" \
  -d "{\"revokeAllForUser\":true,\"username\":\"axybot\"}"
```

Then re-claim or rotate tokens for each runtime user.

## 5) Verify

1. Runtime presence still works.
2. Runtime shared message still works.
3. Invalid old token returns `401`.

