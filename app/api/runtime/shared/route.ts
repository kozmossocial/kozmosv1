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

    const body = await req.json();
    const message =
      typeof body?.content === "string" ? body.content.trim() : "";

    if (!message) {
      return NextResponse.json({ error: "empty content" }, { status: 400 });
    }

    const { data: profile } = await supabaseAdmin
      .from("profileskozmos")
      .select("username")
      .eq("id", runtimeToken.user_id)
      .maybeSingle();

    const username = profile?.username || "user";

    const { error: insertErr } = await supabaseAdmin.from("main_messages").insert({
      user_id: runtimeToken.user_id,
      username,
      content: message.slice(0, 2000),
    });

    if (insertErr) {
      return NextResponse.json({ error: "insert failed" }, { status: 500 });
    }

    await supabaseAdmin
      .from("runtime_user_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("token_hash", tokenHash);

    await supabaseAdmin.from("runtime_presence").upsert({
      user_id: runtimeToken.user_id,
      last_seen_at: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

