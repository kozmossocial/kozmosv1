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

    const body = await req.json();
    const message =
      typeof body?.content === "string" ? body.content.trim() : "";

    if (!message) {
      return NextResponse.json({ error: "empty content" }, { status: 400 });
    }

    const { data: profile } = await supabaseAdmin
      .from("profileskozmos")
      .select("username")
      .eq("id", resolved.userId)
      .maybeSingle();

    const username = profile?.username || "user";

    const { error: insertErr } = await supabaseAdmin.from("main_messages").insert({
      user_id: resolved.userId,
      username,
      content: message.slice(0, 2000),
    });

    if (insertErr) {
      return NextResponse.json(
        {
          error: "insert failed",
          detail: insertErr.message,
          code: insertErr.code || null,
        },
        { status: 500 }
      );
    }

    await supabaseAdmin.from("runtime_presence").upsert({
      user_id: resolved.userId,
      username,
      last_seen_at: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      {
        error: "request failed",
        detail,
      },
      { status: 500 }
    );
  }
}
