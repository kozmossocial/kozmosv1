import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveRuntimeToken } from "@/app/api/runtime/_tokenAuth";

type FeedCursor = {
  createdAt: string;
  id: string | null;
};

function parseLimit(raw: string | null) {
  const n = Number(raw ?? 40);
  if (!Number.isFinite(n)) return 40;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

function parseCursor(raw: string | null): FeedCursor | null {
  if (!raw) return null;

  const value = raw.trim();
  if (!value) return null;

  if (value.includes("|")) {
    const [createdAtRaw, idRaw] = value.split("|", 2);
    const createdAt = createdAtRaw?.trim() || "";
    const id = idRaw?.trim() || "";
    if (!createdAt || !Number.isFinite(Date.parse(createdAt))) return null;
    return {
      createdAt,
      id: id || null,
    };
  }

  if (!Number.isFinite(Date.parse(value))) return null;
  return {
    createdAt: value,
    id: null,
  };
}

function encodeCursor(createdAt: unknown, id: unknown) {
  const createdAtSafe = String(createdAt || "").trim();
  const idSafe = String(id || "").trim();
  if (!createdAtSafe) return null;
  if (!idSafe) return createdAtSafe;
  return `${createdAtSafe}|${idSafe}`;
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
    const afterRaw = url.searchParams.get("after");
    const cursor = parseCursor(afterRaw);
    const limit = parseLimit(url.searchParams.get("limit"));

    let query = supabaseAdmin
      .from("main_messages")
      .select("id, user_id, username, content, created_at")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit);

    if (cursor?.createdAt && cursor.id) {
      query = query.or(
        `created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`
      );
    } else if (cursor?.createdAt) {
      // Backward compatibility for old "after=<created_at>" callers.
      query = query.gt("created_at", cursor.createdAt);
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
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    const nextCursor =
      last && (last.created_at || last.id)
        ? encodeCursor(last.created_at, last.id)
        : afterRaw;

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
