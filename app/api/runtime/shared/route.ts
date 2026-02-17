import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveRuntimeToken } from "@/app/api/runtime/_tokenAuth";

const RUNTIME_SHARED_MIN_GAP_MS = Math.max(
  300,
  Number(process.env.RUNTIME_SHARED_MIN_GAP_MS || 1500)
);
const RUNTIME_SHARED_MAX_PER_MINUTE = Math.max(
  1,
  Number(process.env.RUNTIME_SHARED_MAX_PER_MINUTE || 20)
);
const RUNTIME_SHARED_DUPLICATE_WINDOW_MS = Math.max(
  1000,
  Number(process.env.RUNTIME_SHARED_DUPLICATE_WINDOW_MS || 120000)
);

function normalizeContent(input: string) {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

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
    const nowMs = Date.now();
    const minuteAgoIso = new Date(nowMs - 60_000).toISOString();

    const { data: recentRows, error: recentErr } = await supabaseAdmin
      .from("main_messages")
      .select("id, content, created_at")
      .eq("user_id", resolved.userId)
      .gte("created_at", minuteAgoIso)
      .order("created_at", { ascending: false })
      .limit(Math.max(40, RUNTIME_SHARED_MAX_PER_MINUTE + 8));

    if (recentErr) {
      return NextResponse.json(
        {
          error: "rate limit check failed",
          detail: recentErr.message,
          code: recentErr.code || null,
        },
        { status: 500 }
      );
    }

    const rows = Array.isArray(recentRows) ? recentRows : [];
    if (rows.length >= RUNTIME_SHARED_MAX_PER_MINUTE) {
      return NextResponse.json(
        {
          error: "rate limited",
          reason: "too many runtime shared posts",
          retry_after_ms: 60000,
        },
        { status: 429 }
      );
    }

    const latest = rows[0];
    if (latest?.created_at) {
      const latestMs = Date.parse(String(latest.created_at));
      if (Number.isFinite(latestMs)) {
        const sinceLatest = nowMs - latestMs;
        if (sinceLatest < RUNTIME_SHARED_MIN_GAP_MS) {
          return NextResponse.json(
            {
              error: "rate limited",
              reason: "cooldown",
              retry_after_ms: Math.max(50, RUNTIME_SHARED_MIN_GAP_MS - sinceLatest),
            },
            { status: 429 }
          );
        }
      }
    }

    const normalizedMessage = normalizeContent(message.slice(0, 2000));
    if (normalizedMessage) {
      const duplicateRecent = rows.some((row) => {
        if (!row?.created_at || typeof row.content !== "string") return false;
        const ts = Date.parse(String(row.created_at));
        if (!Number.isFinite(ts)) return false;
        if (nowMs - ts > RUNTIME_SHARED_DUPLICATE_WINDOW_MS) return false;
        return normalizeContent(row.content) === normalizedMessage;
      });
      if (duplicateRecent) {
        return NextResponse.json(
          {
            error: "duplicate content",
            reason: "same message sent too recently",
          },
          { status: 409 }
        );
      }
    }

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

    const { error: presenceErr } = await supabaseAdmin.from("runtime_presence").upsert({
      user_id: resolved.userId,
      username,
      last_seen_at: new Date().toISOString(),
    });

    if (presenceErr) {
      return NextResponse.json(
        {
          error: "presence update failed",
          detail: presenceErr.message,
          code: presenceErr.code || null,
        },
        { status: 500 }
      );
    }

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
