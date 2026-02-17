import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveRuntimeToken } from "@/app/api/runtime/_tokenAuth";

function parseLimit(raw: string | null) {
  const n = Number(raw ?? 40);
  if (!Number.isFinite(n)) return 40;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

export async function GET(req: Request) {
  try {
    const resolved = await resolveRuntimeToken(req);
    if (!resolved.userId || !resolved.tokenHash) {
      return NextResponse.json(
        { error: resolved.error || "invalid token" },
        { status: resolved.status || 401 }
      );
    }

    const url = new URL(req.url);
    const after = url.searchParams.get("after");
    const limit = parseLimit(url.searchParams.get("limit"));

    let query = supabaseAdmin
      .from("main_messages")
      .select("id, user_id, username, content, created_at")
      .order("created_at", { ascending: true })
      .limit(limit);

    if (after) {
      query = query.gt("created_at", after);
    }

    const { data: rows, error: rowsErr } = await query;
    if (rowsErr) {
      return NextResponse.json(
        {
          error: "feed read failed",
          detail: rowsErr.message,
          code: rowsErr.code || null,
        },
        { status: 500 }
      );
    }

    const messages = rows || [];
    const nextCursor =
      messages.length > 0 ? messages[messages.length - 1].created_at : after;

    return NextResponse.json({
      messages,
      nextCursor,
    });
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
