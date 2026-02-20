import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  authenticateBuildRuntimeUser,
  clampLimit,
  getBuildRuntimeSpaceAccess,
  getStarterMode,
  mapBuildRuntimeError,
  passStarterRateLimit,
  sanitizeJsonValue,
} from "@/app/api/build/runtime/_shared";

type CommentRow = {
  id: number;
  post_id: number;
  author_id: string;
  body: string;
  meta: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type ProfileRow = {
  id: string;
  username: string;
};

export async function GET(req: Request) {
  try {
    const user = await authenticateBuildRuntimeUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const spaceId = String(url.searchParams.get("spaceId") || "").trim();
    const postId = Number(url.searchParams.get("postId") || "0");
    const limit = clampLimit(url.searchParams.get("limit"), 80, 1, 200);

    if (!spaceId || !Number.isFinite(postId) || postId <= 0) {
      return NextResponse.json({ error: "spaceId and postId required" }, { status: 400 });
    }
    if (!passStarterRateLimit(user.id, spaceId, "starter.comments.read", 180)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
    }

    const access = await getBuildRuntimeSpaceAccess(spaceId, user.id);
    if (access.error) {
      return NextResponse.json(mapBuildRuntimeError(access.error, "access check failed"), {
        status: 500,
      });
    }
    if (!access.space || !access.canRead) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { data, error } = await supabaseAdmin
      .from("user_build_backend_comments")
      .select("id, post_id, author_id, body, meta, created_at, updated_at")
      .eq("space_id", spaceId)
      .eq("post_id", postId)
      .order("id", { ascending: true })
      .limit(limit);
    if (error) {
      return NextResponse.json(mapBuildRuntimeError(error, "comments load failed"), {
        status: 500,
      });
    }

    const rows = (data || []) as CommentRow[];
    if (rows.length === 0) {
      return NextResponse.json({ comments: [] });
    }

    const authorIds = Array.from(new Set(rows.map((row) => row.author_id)));
    const profilesRes = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username")
      .in("id", authorIds);
    if (profilesRes.error) {
      return NextResponse.json({ error: "comments enrich failed" }, { status: 500 });
    }

    const profileMap = new Map<string, string>();
    ((profilesRes.data || []) as ProfileRow[]).forEach((row) => {
      profileMap.set(row.id, String(row.username || "user"));
    });

    return NextResponse.json({
      comments: rows.map((row) => ({
        id: row.id,
        postId: row.post_id,
        authorId: row.author_id,
        authorUsername: profileMap.get(row.author_id) || "user",
        body: row.body,
        meta: row.meta || {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await authenticateBuildRuntimeUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim() : "";
    const postId = Number(body?.postId || 0);
    const commentBody = typeof body?.body === "string" ? body.body.trim() : "";
    const meta = sanitizeJsonValue(body?.meta);

    if (!spaceId || !Number.isFinite(postId) || postId <= 0 || !commentBody) {
      return NextResponse.json(
        { error: "spaceId, postId and body required" },
        { status: 400 }
      );
    }
    if (commentBody.length > 3000) {
      return NextResponse.json({ error: "comment body too long" }, { status: 400 });
    }
    if (!passStarterRateLimit(user.id, spaceId, "starter.comments.write", 120)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
    }

    const access = await getBuildRuntimeSpaceAccess(spaceId, user.id);
    if (access.error) {
      return NextResponse.json(mapBuildRuntimeError(access.error, "access check failed"), {
        status: 500,
      });
    }
    if (!access.space || !access.canRead) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const modeRes = await getStarterMode(spaceId);
    if (modeRes.error) {
      return NextResponse.json(mapBuildRuntimeError(modeRes.error, "mode load failed"), {
        status: 500,
      });
    }
    if (!modeRes.mode?.enabled) {
      return NextResponse.json({ error: "starter mode disabled" }, { status: 409 });
    }

    const { data, error } = await supabaseAdmin
      .from("user_build_backend_comments")
      .insert({
        space_id: spaceId,
        post_id: postId,
        author_id: user.id,
        body: commentBody,
        meta,
      })
      .select("id, post_id, author_id, body, meta, created_at, updated_at")
      .single();

    if (error || !data) {
      const detail = `${error?.code || ""}:${error?.message || ""}`.toLowerCase();
      if (detail.includes("starter mode disabled")) {
        return NextResponse.json({ error: "starter mode disabled" }, { status: 409 });
      }
      if (detail.includes("starter quota exceeded")) {
        return NextResponse.json({ error: "starter quota exceeded" }, { status: 429 });
      }
      return NextResponse.json(mapBuildRuntimeError(error, "comment create failed"), {
        status: 500,
      });
    }

    return NextResponse.json({
      ok: true,
      comment: {
        id: data.id,
        postId: data.post_id,
        authorId: data.author_id,
        authorUsername: user.user_metadata?.username || "user",
        body: data.body,
        meta: data.meta || {},
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      },
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
