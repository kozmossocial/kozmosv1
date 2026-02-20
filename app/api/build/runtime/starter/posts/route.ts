import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  clampLimit,
  getBuildRuntimeRequestContext,
  getStarterMode,
  mapBuildRuntimeError,
  passStarterRateLimit,
  sanitizeJsonValue,
} from "@/app/api/build/runtime/_shared";
import {
  extractStarterToken,
  resolveStarterActor,
} from "@/app/api/build/runtime/starter/_auth";

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

async function loadStarterUsernames(spaceId: string, userIds: string[]) {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return new Map<string, string>();
  const { data } = await supabaseAdmin
    .from("user_build_starter_users")
    .select("id, username")
    .eq("space_id", spaceId)
    .in("id", ids);
  const out = new Map<string, string>();
  ((data || []) as ProfileRow[]).forEach((row) => out.set(row.id, String(row.username || "user")));
  return out;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const spaceId = String(url.searchParams.get("spaceId") || "").trim();
    const limit = clampLimit(url.searchParams.get("limit"), 40, 1, 150);
    const beforeId = Number(url.searchParams.get("beforeId") || "0");
    const useBefore = Number.isFinite(beforeId) && beforeId > 0;

    if (!spaceId) {
      return NextResponse.json({ error: "spaceId required" }, { status: 400 });
    }

    const ctx = await getBuildRuntimeRequestContext(req, spaceId);
    if (ctx.access.error) {
      return NextResponse.json(mapBuildRuntimeError(ctx.access.error, "access check failed"), {
        status: 500,
      });
    }
    if (!ctx.access.space || !ctx.access.canRead) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    if (!passStarterRateLimit(ctx.rateIdentity, spaceId, "starter.posts.read", 180)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
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
    const starterActorRes = await resolveStarterActor(spaceId, extractStarterToken(req));
    const starterActorId = starterActorRes.actor?.user?.id || "";
    const [profilesRes, likesRes, commentsRes] = await Promise.all([
      loadStarterUsernames(spaceId, authorIds),
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

    if (likesRes.error || commentsRes.error) {
      return NextResponse.json({ error: "posts enrich failed" }, { status: 500 });
    }
    const profileMap = profilesRes;

    const likeRows = (likesRes.data || []) as LikeRow[];
    const likesByPost = new Map<number, number>();
    const likedByMe = new Set<number>();
    likeRows.forEach((row) => {
      likesByPost.set(row.post_id, (likesByPost.get(row.post_id) || 0) + 1);
      if (starterActorId && row.user_id === starterActorId) likedByMe.add(row.post_id);
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

    const ctx = await getBuildRuntimeRequestContext(req, spaceId);
    if (ctx.access.error) {
      return NextResponse.json(mapBuildRuntimeError(ctx.access.error, "access check failed"), {
        status: 500,
      });
    }
    if (!ctx.access.space || !ctx.access.canRead) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    if (!passStarterRateLimit(ctx.rateIdentity, spaceId, "starter.posts.write", 100)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
    }

    const starterToken = extractStarterToken(req, body?.starterToken);
    const starterActorRes = await resolveStarterActor(spaceId, starterToken);
    if (starterActorRes.error || !starterActorRes.actor) {
      return NextResponse.json({ error: "starter auth required" }, { status: 401 });
    }
    const starterUser = starterActorRes.actor.user;

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
        author_id: starterUser.id,
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
        authorUsername: starterUser.username || "user",
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
