import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function extractBearerToken(req: Request) {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function hashToken(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

async function resolveRuntimeUserId(req: Request) {
  const token = extractBearerToken(req);
  if (!token) {
    return { userId: null as string | null, tokenHash: null as string | null, error: "missing token" };
  }

  const tokenHash = hashToken(token);
  const { data: runtimeToken, error: tokenErr } = await supabaseAdmin
    .from("runtime_user_tokens")
    .select("user_id, is_active")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (tokenErr || !runtimeToken || !runtimeToken.is_active) {
    return { userId: null as string | null, tokenHash: null as string | null, error: "invalid token" };
  }

  return { userId: runtimeToken.user_id as string, tokenHash, error: null as string | null };
}

export async function POST(req: Request) {
  try {
    const resolved = await resolveRuntimeUserId(req);
    if (!resolved.userId || !resolved.tokenHash) {
      return NextResponse.json({ error: resolved.error || "invalid token" }, { status: 401 });
    }

    const { data: profile } = await supabaseAdmin
      .from("profileskozmos")
      .select("username")
      .eq("id", resolved.userId)
      .maybeSingle();

    await supabaseAdmin.from("runtime_presence").upsert({
      user_id: resolved.userId,
      username: profile?.username || "user",
      last_seen_at: new Date().toISOString(),
    });

    await supabaseAdmin
      .from("runtime_user_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("token_hash", resolved.tokenHash);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const resolved = await resolveRuntimeUserId(req);
    if (!resolved.userId || !resolved.tokenHash) {
      return NextResponse.json({ error: resolved.error || "invalid token" }, { status: 401 });
    }

    await supabaseAdmin
      .from("runtime_presence")
      .delete()
      .eq("user_id", resolved.userId);

    await supabaseAdmin
      .from("runtime_user_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("token_hash", resolved.tokenHash);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
