import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { hashSecret } from "@/lib/runtimeIdentity";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

type RuntimeInviteRow = {
  id: number;
  expires_at: string;
  max_claims: number;
  used_claims: number;
  used_at: string | null;
  revoked: boolean;
};

function isExpired(expiresAt: string) {
  return new Date(expiresAt).getTime() <= Date.now();
}

function originFromReq(req: Request) {
  if (siteUrl) return siteUrl.replace(/\/$/, "");
  return new URL(req.url).origin.replace(/\/$/, "");
}

function extractBearerToken(req: Request) {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function POST(req: Request) {
  try {
    const userJwt = extractBearerToken(req);
    if (!userJwt) {
      return NextResponse.json({ error: "login required" }, { status: 401 });
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey);
    const {
      data: { user },
      error: userErr,
    } = await authClient.auth.getUser(userJwt);

    if (userErr || !user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const linkedUserId = user.id;

    const body = await req.json().catch(() => ({}));
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const label = typeof body?.label === "string" ? body.label : "runtime";

    if (!code) {
      return NextResponse.json({ error: "missing invite code" }, { status: 400 });
    }

    const codeHash = hashSecret(code);
    const { data: invite, error: inviteErr } = await supabaseAdmin
      .from("runtime_invites")
      .select("id, expires_at, max_claims, used_claims, used_at, revoked")
      .eq("code_hash", codeHash)
      .maybeSingle();

    const inviteRow = invite as RuntimeInviteRow | null;
    if (inviteErr || !inviteRow || inviteRow.revoked) {
      return NextResponse.json({ error: "invalid invite" }, { status: 401 });
    }

    if (
      isExpired(inviteRow.expires_at) ||
      inviteRow.used_claims >= inviteRow.max_claims
    ) {
      return NextResponse.json({ error: "invite expired" }, { status: 410 });
    }

    const nextClaims = inviteRow.used_claims + 1;
    const now = new Date().toISOString();
    const { data: reservedRows, error: reserveErr } = await supabaseAdmin
      .from("runtime_invites")
      .update({
        used_claims: nextClaims,
        used_at: now,
        revoked: nextClaims >= inviteRow.max_claims,
      })
      .eq("id", inviteRow.id)
      .eq("used_claims", inviteRow.used_claims)
      .select("id");

    if (reserveErr || !reservedRows || reservedRows.length === 0) {
      return NextResponse.json({ error: "invite already used" }, { status: 409 });
    }

    try {
      const { data: profile, error: profileErr } = await supabaseAdmin
        .from("profileskozmos")
        .select("username")
        .eq("id", linkedUserId)
        .maybeSingle();

      const linkedUsername =
        typeof profile?.username === "string" ? profile.username.trim() : "";

      if (profileErr || !linkedUsername) {
        throw new Error("linked profile missing");
      }

      if (linkedUsername.toLowerCase() === "axy") {
        const { error: capErr } = await supabaseAdmin
          .from("runtime_capabilities")
          .upsert(
            {
              user_id: linkedUserId,
              capability: "axy.super",
              enabled: true,
            },
            { onConflict: "user_id,capability" }
          );

        if (capErr) {
          if (capErr.code === "42P01") {
            throw new Error("runtime_capabilities table missing");
          }
          throw new Error("axy capability assign failed");
        }
      }

      const runtimeToken = `kzrt_${randomBytes(24).toString("hex")}`;
      const tokenHash = hashSecret(runtimeToken);
      const nowIso = new Date().toISOString();

      const { error: tokenErr } = await supabaseAdmin
        .from("runtime_user_tokens")
        .insert({
          user_id: linkedUserId,
          token_hash: tokenHash,
          label: label.slice(0, 60),
          is_active: true,
          last_used_at: nowIso,
        });

      if (tokenErr) {
        throw new Error("token create failed");
      }

      const { error: presenceErr } = await supabaseAdmin
        .from("runtime_presence")
        .upsert({
          user_id: linkedUserId,
          username: linkedUsername,
          last_seen_at: nowIso,
        });

      if (presenceErr) {
        throw new Error("presence update failed");
      }

      const result = {
        user: { id: linkedUserId, username: linkedUsername },
        token: runtimeToken,
      };

      const origin = originFromReq(req);
      return NextResponse.json({
        user: result.user,
        token: result.token,
        mode: "linked-user",
        note: "Store token now. It will not be shown again.",
        next: {
          spec: `${origin}/api/runtime/spec`,
          presence: `${origin}/api/runtime/presence`,
          shared: `${origin}/api/runtime/shared`,
        },
      });
    } catch {
      await supabaseAdmin
        .from("runtime_invites")
        .update({
          used_claims: inviteRow.used_claims,
          used_at: inviteRow.used_at,
          revoked: inviteRow.revoked,
        })
        .eq("id", inviteRow.id);

      return NextResponse.json({ error: "claim failed" }, { status: 500 });
    }
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
