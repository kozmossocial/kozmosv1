import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveRuntimeToken } from "@/app/api/runtime/_tokenAuth";

export async function POST(req: Request) {
  try {
    const resolved = await resolveRuntimeToken(req);
    if (!resolved.userId || !resolved.tokenHash) {
      return NextResponse.json(
        { error: resolved.error || "invalid token" },
        { status: resolved.status || 401 }
      );
    }

    const { data: profile } = await supabaseAdmin
      .from("profileskozmos")
      .select("username")
      .eq("id", resolved.userId)
      .maybeSingle();

    const { error: presenceErr } = await supabaseAdmin.from("runtime_presence").upsert({
      user_id: resolved.userId,
      username: profile?.username || "user",
      last_seen_at: new Date().toISOString(),
    });
    if (presenceErr) {
      return NextResponse.json({ error: "presence update failed" }, { status: 500 });
    }

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
    const resolved = await resolveRuntimeToken(req);
    if (!resolved.userId || !resolved.tokenHash) {
      return NextResponse.json(
        { error: resolved.error || "invalid token" },
        { status: resolved.status || 401 }
      );
    }

    const { error: presenceDeleteErr } = await supabaseAdmin
      .from("runtime_presence")
      .delete()
      .eq("user_id", resolved.userId);
    if (presenceDeleteErr) {
      return NextResponse.json({ error: "presence clear failed" }, { status: 500 });
    }

    await supabaseAdmin
      .from("runtime_user_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("token_hash", resolved.tokenHash);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
