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

export async function POST(req: Request) {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      return NextResponse.json({ error: "missing token" }, { status: 401 });
    }

    const tokenHash = hashToken(token);
    const { data: runtimeToken, error: tokenErr } = await supabaseAdmin
      .from("runtime_user_tokens")
      .select("user_id, is_active")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (tokenErr || !runtimeToken || !runtimeToken.is_active) {
      return NextResponse.json({ error: "invalid token" }, { status: 401 });
    }

    await supabaseAdmin.from("runtime_presence").upsert({
      user_id: runtimeToken.user_id,
      last_seen_at: new Date().toISOString(),
    });

    await supabaseAdmin
      .from("runtime_user_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("token_hash", tokenHash);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

