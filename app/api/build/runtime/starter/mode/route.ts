import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  authenticateBuildRuntimeUser,
  getBuildRuntimeSpaceAccess,
  getStarterMode,
  mapBuildRuntimeError,
  passStarterRateLimit,
} from "@/app/api/build/runtime/_shared";

function clampQuota(input: unknown, fallback: number, min: number, max: number) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export async function GET(req: Request) {
  try {
    const user = await authenticateBuildRuntimeUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const spaceId = String(url.searchParams.get("spaceId") || "").trim();
    if (!spaceId) {
      return NextResponse.json({ error: "spaceId required" }, { status: 400 });
    }
    if (!passStarterRateLimit(user.id, spaceId, "starter.mode.read", 180)) {
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

    return NextResponse.json({
      mode: modeRes.mode,
      canEdit: access.canEdit,
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const user = await authenticateBuildRuntimeUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim() : "";
    const enabled = Boolean(body?.enabled);

    if (!spaceId) {
      return NextResponse.json({ error: "spaceId required" }, { status: 400 });
    }
    if (!passStarterRateLimit(user.id, spaceId, "starter.mode.write", 60)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
    }

    const access = await getBuildRuntimeSpaceAccess(spaceId, user.id);
    if (access.error) {
      return NextResponse.json(mapBuildRuntimeError(access.error, "access check failed"), {
        status: 500,
      });
    }
    if (!access.space || !access.canEdit) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const payload = {
      space_id: spaceId,
      enabled,
      posts_quota: clampQuota(body?.postsQuota, 2000, 100, 20000),
      comments_quota: clampQuota(body?.commentsQuota, 10000, 200, 100000),
      likes_quota: clampQuota(body?.likesQuota, 40000, 500, 200000),
      dm_threads_quota: clampQuota(body?.dmThreadsQuota, 500, 20, 5000),
      dm_messages_quota: clampQuota(body?.dmMessagesQuota, 60000, 500, 400000),
      starter_users_quota: clampQuota(body?.starterUsersQuota, 3000, 10, 50000),
      friend_requests_quota: clampQuota(body?.friendRequestsQuota, 12000, 50, 200000),
      friendships_quota: clampQuota(body?.friendshipsQuota, 12000, 50, 200000),
      updated_by: user.id,
    };

    const { data, error } = await supabaseAdmin
      .from("user_build_backend_modes")
      .upsert(payload, { onConflict: "space_id" })
      .select(
        "space_id, enabled, posts_quota, comments_quota, likes_quota, dm_threads_quota, dm_messages_quota, starter_users_quota, friend_requests_quota, friendships_quota, updated_at"
      )
      .single();

    if (error || !data) {
      return NextResponse.json(mapBuildRuntimeError(error, "mode update failed"), {
        status: 500,
      });
    }

    return NextResponse.json({ ok: true, mode: data });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
