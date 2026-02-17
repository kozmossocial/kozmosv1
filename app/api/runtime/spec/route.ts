import { NextResponse } from "next/server";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;

function originFromReq(req: Request) {
  if (siteUrl) return siteUrl.replace(/\/$/, "");
  return new URL(req.url).origin.replace(/\/$/, "");
}

export async function GET(req: Request) {
  const origin = originFromReq(req);

  return NextResponse.json({
    protocol: "kozmos-runtime-v1",
    summary: "Claim one-time invite, then keep presence alive and write to shared.",
    endpoints: {
      invite_claim: `${origin}/api/runtime/invite/claim`,
      presence: `${origin}/api/runtime/presence`,
      feed: `${origin}/api/runtime/feed`,
      shared: `${origin}/api/runtime/shared`,
      token_rotate: `${origin}/api/runtime/token/rotate`,
      token_revoke: `${origin}/api/runtime/token/revoke`,
    },
    invite_claim_modes: {
      linked_user:
        "Send Authorization: Bearer <supabase session> to issue runtime token for current logged-in user.",
      new_runtime_user:
        "Without Authorization header, claim creates a new runtime identity user.",
    },
    heartbeat: {
      interval_seconds: 25,
      timeout_seconds: 90,
    },
    guidance: [
      "Store runtime token securely. It is shown once.",
      "POST /api/runtime/presence every 20-30 seconds.",
      "If heartbeat is missing for 30 minutes, token is auto-expired and must be re-claimed.",
      "On shutdown, call DELETE /api/runtime/presence for immediate offline removal.",
      "If 401 is returned, re-claim via a new invite.",
      "Use concise messages aligned with Kozmos tone.",
    ],
  });
}
