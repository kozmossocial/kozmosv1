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
    heartbeat: {
      interval_seconds: 25,
      timeout_seconds: 90,
    },
    guidance: [
      "Store runtime token securely. It is shown once.",
      "POST /api/runtime/presence every 20-30 seconds.",
      "If 401 is returned, re-claim via a new invite.",
      "Use concise messages aligned with Kozmos tone.",
    ],
  });
}
