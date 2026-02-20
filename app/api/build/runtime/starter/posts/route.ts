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

type PostRow = {
  id: number;
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

type LikeRow = {
  post_id: number;
  user_id: string;
};

type CommentCountRow = {
  post_id: number;
};

export async function GET(req: Request) {
  try {
    const user = await authenticateBuildRuntimeUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const spaceId = String(url.searchParams.get("spaceId") || "").trim();
    const limit = clampLimit(url.searchParams.get("limit"), 40, 1, 150);
    const beforeId = Number(url.searchParams.get("beforeId") || "0");
    const useBefore = Number.isFinite(beforeId) && beforeId > 0;

    if (!spaceId) {
      return NextResponse.json({ error: "spaceId required" }, { status: 400 });
    }
    if (!passStarterRateLimit(user.id, spaceId, "starter.posts.read", 180)) {
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

    let query = supabaseAdmin
      .from("user_build_backend_posts")
      .select("id, author_id, body, meta, created_at, updated_at")
      .eq("space_id", spaceId)
      .order("id", { ascending: false })
      .limit(limit);
    if (useBefore) {
      query = query.lt("id", beforeId);
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json(mapBuildRuntimeError(error, "posts load failed"), { status: 500 });
    }

    const rows = (data || []) as PostRow[];
    const postIds = rows.map((row) => row.id);
    if (postIds.length === 0) {
      return NextResponse.json({ mode: modeRes.mode, posts: [] });
    }

    const authorIds = Array.from(new Set(rows.map((row) => row.author_id)));
    const [profilesRes, likesRes, commentsRes] = await Promise.all([
      supabaseAdmin.from("profileskozmos").select("id, username").in("id", authorIds),
      supabaseAdmin
        .from("user_build_backend_likes")
        .select("post_id, user_id")
        .eq("space_id", spaceId)
        .in("post_id", postIds),
      supabaseAdmin
        .from("user_build_backend_comments")
        .select("post_id")
        .eq("space_id", spaceId)
        .in("post_id", postIds),
    ]);

    if (profilesRes.error || likesRes.error || commentsRes.error) {
      return NextResponse.json({ error: "posts enrich failed" }, { status: 500 });
    }

    const profileMap = new Map<string, string>();
    ((profilesRes.data || []) as ProfileRow[]).forEach((row) => {
      profileMap.set(row.id, String(row.username || "user"));
    });

    const likeRows = (likesRes.data || []) as LikeRow[];
    const likesByPost = new Map<number, number>();
    const likedByMe = new Set<number>();
    likeRows.forEach((row) => {
      likesByPost.set(row.post_id, (likesByPost.get(row.post_id) || 0) + 1);
      if (row.user_id === user.id) likedByMe.add(row.post_id);
    });

    const commentsByPost = new Map<number, number>();
    ((commentsRes.data || []) as CommentCountRow[]).forEach((row) => {
      commentsByPost.set(row.post_id, (commentsByPost.get(row.post_id) || 0) + 1);
    });

    return NextResponse.json({
      mode: modeRes.mode,
      posts: rows.map((row) => ({
        id: row.id,
        authorId: row.author_id,
        authorUsername: profileMap.get(row.author_id) || "user",
        body: row.body,
        meta: row.meta || {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        likeCount: likesByPost.get(row.id) || 0,
        commentCount: commentsByPost.get(row.id) || 0,
        likedByMe: likedByMe.has(row.id),
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
    const postBody = typeof body?.body === "string" ? body.body.trim() : "";
    const meta = sanitizeJsonValue(body?.meta);

    if (!spaceId || !postBody) {
      return NextResponse.json({ error: "spaceId and body required" }, { status: 400 });
    }
    if (postBody.length > 5000) {
      return NextResponse.json({ error: "post body too long" }, { status: 400 });
    }
    if (!passStarterRateLimit(user.id, spaceId, "starter.posts.write", 100)) {
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
      .from("user_build_backend_posts")
      .insert({
        space_id: spaceId,
        author_id: user.id,
        body: postBody,
        meta,
      })
      .select("id, author_id, body, meta, created_at, updated_at")
      .single();

    if (error || !data) {
      const detail = `${error?.code || ""}:${error?.message || ""}`.toLowerCase();
      if (detail.includes("starter mode disabled")) {
        return NextResponse.json({ error: "starter mode disabled" }, { status: 409 });
      }
      if (detail.includes("starter quota exceeded")) {
        return NextResponse.json({ error: "starter quota exceeded" }, { status: 429 });
      }
      return NextResponse.json(mapBuildRuntimeError(error, "post create failed"), { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      post: {
        id: data.id,
        authorId: data.author_id,
        authorUsername: user.user_metadata?.username || "user",
        body: data.body,
        meta: data.meta || {},
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        likeCount: 0,
        commentCount: 0,
        likedByMe: false,
      },
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
