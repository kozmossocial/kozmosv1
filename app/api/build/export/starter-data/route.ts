import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { exportStarterData } from "@/app/api/build/export/_starterData";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function extractBearerToken(req: Request) {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function authenticateUser(req: Request) {
  const token = extractBearerToken(req);
  if (!token) return null;
  const authClient = createClient(supabaseUrl, supabaseAnonKey);
  const {
    data: { user },
  } = await authClient.auth.getUser(token);
  return user ?? null;
}

async function requireOwner(spaceId: string, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_build_spaces")
    .select("id, owner_id, title")
    .eq("id", spaceId)
    .maybeSingle();
  if (error) return { ok: false, error: "owner check failed", space: null as Record<string, unknown> | null };
  if (!data || data.owner_id !== userId) return { ok: false, error: "forbidden", space: data as Record<string, unknown> | null };
  return { ok: true, error: null, space: data as Record<string, unknown> };
}

function normalizeArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function quotaFromCount(count: number, fallback: number, min: number, max: number) {
  const n = Number.isFinite(count) ? Math.round(count) : 0;
  return Math.max(min, Math.min(max, Math.max(fallback, n)));
}

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const spaceId = String(url.searchParams.get("spaceId") || "").trim();
    if (!spaceId) return NextResponse.json({ error: "spaceId required" }, { status: 400 });

    const ownerRes = await requireOwner(spaceId, user.id);
    if (!ownerRes.ok) {
      const status = ownerRes.error === "forbidden" ? 403 : 500;
      return NextResponse.json({ error: ownerRes.error }, { status });
    }

    const data = await exportStarterData(spaceId);
    return NextResponse.json({ ok: true, data });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim() : "";
    const data = body?.data && typeof body.data === "object" ? body.data : null;
    if (!spaceId || !data) {
      return NextResponse.json({ error: "spaceId and data required" }, { status: 400 });
    }

    const ownerRes = await requireOwner(spaceId, user.id);
    if (!ownerRes.ok) {
      const status = ownerRes.error === "forbidden" ? 403 : 500;
      return NextResponse.json({ error: ownerRes.error }, { status });
    }

    const starterUsers = normalizeArray((data as { starter_users?: unknown }).starter_users);
    const friendRequests = normalizeArray((data as { friend_requests?: unknown }).friend_requests);
    const friendships = normalizeArray((data as { friendships?: unknown }).friendships);
    const posts = normalizeArray((data as { posts?: unknown }).posts);
    const comments = normalizeArray((data as { comments?: unknown }).comments);
    const likes = normalizeArray((data as { likes?: unknown }).likes);
    const dmThreads = normalizeArray((data as { dm_threads?: unknown }).dm_threads);
    const dmParticipants = normalizeArray((data as { dm_participants?: unknown }).dm_participants);
    const dmMessages = normalizeArray((data as { dm_messages?: unknown }).dm_messages);

    const modeRaw = (data as { mode?: unknown }).mode;
    const mode = modeRaw && typeof modeRaw === "object" ? (modeRaw as Record<string, unknown>) : {};

    const modeUpsert = await supabaseAdmin.from("user_build_backend_modes").upsert(
      {
        space_id: spaceId,
        enabled: Boolean(mode.enabled ?? true),
        posts_quota: quotaFromCount(posts.length, Number(mode.posts_quota || 2000), 100, 20000),
        comments_quota: quotaFromCount(comments.length, Number(mode.comments_quota || 10000), 200, 100000),
        likes_quota: quotaFromCount(likes.length, Number(mode.likes_quota || 40000), 500, 200000),
        dm_threads_quota: quotaFromCount(dmThreads.length, Number(mode.dm_threads_quota || 500), 20, 5000),
        dm_messages_quota: quotaFromCount(dmMessages.length, Number(mode.dm_messages_quota || 60000), 500, 400000),
        starter_users_quota: quotaFromCount(starterUsers.length, Number(mode.starter_users_quota || 3000), 10, 50000),
        friend_requests_quota: quotaFromCount(friendRequests.length, Number(mode.friend_requests_quota || 12000), 50, 200000),
        friendships_quota: quotaFromCount(friendships.length, Number(mode.friendships_quota || 12000), 50, 200000),
        updated_by: user.id,
      },
      { onConflict: "space_id" }
    );
    if (modeUpsert.error) {
      return NextResponse.json({ error: "mode prepare failed" }, { status: 500 });
    }

    await supabaseAdmin.from("user_build_backend_dm_messages").delete().eq("space_id", spaceId);
    await supabaseAdmin.from("user_build_backend_dm_participants").delete().eq("space_id", spaceId);
    await supabaseAdmin.from("user_build_backend_dm_threads").delete().eq("space_id", spaceId);
    await supabaseAdmin.from("user_build_backend_likes").delete().eq("space_id", spaceId);
    await supabaseAdmin.from("user_build_backend_comments").delete().eq("space_id", spaceId);
    await supabaseAdmin.from("user_build_backend_posts").delete().eq("space_id", spaceId);
    await supabaseAdmin.from("user_build_starter_friend_requests").delete().eq("space_id", spaceId);
    await supabaseAdmin.from("user_build_starter_friendships").delete().eq("space_id", spaceId);
    await supabaseAdmin.from("user_build_starter_sessions").delete().eq("space_id", spaceId);
    await supabaseAdmin.from("user_build_starter_users").delete().eq("space_id", spaceId);

    const withSpace = (rows: Array<Record<string, unknown>>) =>
      rows
        .filter((row) => row && typeof row === "object")
        .map((row) => ({ ...row, space_id: spaceId }));

    if (starterUsers.length > 0) {
      const insert = await supabaseAdmin.from("user_build_starter_users").insert(withSpace(starterUsers));
      if (insert.error) return NextResponse.json({ error: "starter users import failed" }, { status: 500 });
    }
    if (friendRequests.length > 0) {
      const insert = await supabaseAdmin
        .from("user_build_starter_friend_requests")
        .insert(withSpace(friendRequests));
      if (insert.error) return NextResponse.json({ error: "friend requests import failed" }, { status: 500 });
    }
    if (friendships.length > 0) {
      const insert = await supabaseAdmin.from("user_build_starter_friendships").insert(withSpace(friendships));
      if (insert.error) return NextResponse.json({ error: "friendships import failed" }, { status: 500 });
    }
    if (posts.length > 0) {
      const insert = await supabaseAdmin.from("user_build_backend_posts").insert(withSpace(posts));
      if (insert.error) return NextResponse.json({ error: "posts import failed" }, { status: 500 });
    }
    if (comments.length > 0) {
      const insert = await supabaseAdmin.from("user_build_backend_comments").insert(withSpace(comments));
      if (insert.error) return NextResponse.json({ error: "comments import failed" }, { status: 500 });
    }
    if (likes.length > 0) {
      const insert = await supabaseAdmin.from("user_build_backend_likes").insert(withSpace(likes));
      if (insert.error) return NextResponse.json({ error: "likes import failed" }, { status: 500 });
    }
    if (dmThreads.length > 0) {
      const insert = await supabaseAdmin.from("user_build_backend_dm_threads").insert(withSpace(dmThreads));
      if (insert.error) return NextResponse.json({ error: "dm threads import failed" }, { status: 500 });
    }
    if (dmParticipants.length > 0) {
      const insert = await supabaseAdmin
        .from("user_build_backend_dm_participants")
        .insert(withSpace(dmParticipants));
      if (insert.error) return NextResponse.json({ error: "dm participants import failed" }, { status: 500 });
    }
    if (dmMessages.length > 0) {
      const insert = await supabaseAdmin.from("user_build_backend_dm_messages").insert(withSpace(dmMessages));
      if (insert.error) return NextResponse.json({ error: "dm messages import failed" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      imported: {
        starter_users: starterUsers.length,
        friend_requests: friendRequests.length,
        friendships: friendships.length,
        posts: posts.length,
        comments: comments.length,
        likes: likes.length,
        dm_threads: dmThreads.length,
        dm_participants: dmParticipants.length,
        dm_messages: dmMessages.length,
      },
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
