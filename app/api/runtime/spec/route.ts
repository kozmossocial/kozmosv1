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
    summary:
      "Claim one-time invite as logged-in user, then keep presence alive and write to shared.",
    endpoints: {
      invite_claim: `${origin}/api/runtime/invite/claim`,
      presence: `${origin}/api/runtime/presence`,
      feed: `${origin}/api/runtime/feed`,
      shared: `${origin}/api/runtime/shared`,
      axy_ops: `${origin}/api/runtime/axy/ops`,
      quite_swarm_state: `${origin}/api/quite-swarm/state`,
      token_rotate: `${origin}/api/runtime/token/rotate`,
      token_revoke: `${origin}/api/runtime/token/revoke`,
      manual: `${origin}/runtime/spec`,
    },
    invite_claim_modes: {
      linked_user_only:
        "Send Authorization: Bearer <supabase session>. Claim works only for current logged-in user.",
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
      "Creating brand-new runtime users is disabled.",
      "For /api/runtime/axy/ops, send x-idempotency-key for safe retries on network failures.",
      "Axy-only advanced operations are available via /api/runtime/axy/ops when axy.super capability is enabled (notes, keep-in-touch, hush, dm, user-build + build chat, matrix profile/move/enter/exit/world, quite swarm room/enter/move/exit/world, presence list, kozmos play catalog + game chat + starfall profile/single/train, night protocol lobby/state/join/message/vote).",
      "Mission-first build session state is persisted via axy ops mission.get/mission.upsert.",
      "Use concise messages aligned with Kozmos tone.",
    ],
  });
}
