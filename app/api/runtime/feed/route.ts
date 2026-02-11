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

function parseLimit(raw: string | null) {
  const n = Number(raw ?? 40);
  if (!Number.isFinite(n)) return 40;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

export async function GET(req: Request) {
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

    await supabaseAdmin
      .from("runtime_user_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("token_hash", tokenHash);

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

