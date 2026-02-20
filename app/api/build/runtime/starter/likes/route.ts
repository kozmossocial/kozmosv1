import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getBuildRuntimeRequestContext,
  getStarterMode,
  mapBuildRuntimeError,
  passStarterRateLimit,
} from "@/app/api/build/runtime/_shared";
import {
  extractStarterToken,
  resolveStarterActor,
} from "@/app/api/build/runtime/starter/_auth";

type LikeState = {
  likeCount: number;
  likedByMe: boolean;
};

async function fetchLikeState(spaceId: string, postId: number, userId: string) {
  const [countRes, mineRes] = await Promise.all([
    supabaseAdmin
      .from("user_build_backend_likes")
      .select("id", { count: "exact", head: true })
      .eq("space_id", spaceId)
      .eq("post_id", postId),
    supabaseAdmin
      .from("user_build_backend_likes")
      .select("id")
      .eq("space_id", spaceId)
      .eq("post_id", postId)
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  if (countRes.error || mineRes.error) {
    return { error: countRes.error || mineRes.error, state: null as LikeState | null };
  }
  return {
    error: null,
    state: {
      likeCount: Number(countRes.count || 0),
      likedByMe: Boolean((mineRes.data as { id?: number } | null)?.id),
    },
  };
}

function parseSpaceAndPost(
  source: URLSearchParams | { spaceId?: unknown; postId?: unknown }
) {
  const spaceId =
    source instanceof URLSearchParams
      ? String(source.get("spaceId") || "").trim()
      : typeof source?.spaceId === "string"
        ? source.spaceId.trim()
        : "";
  const postIdRaw =
    source instanceof URLSearchParams
      ? Number(source.get("postId") || "0")
      : Number(source?.postId || 0);
  return { spaceId, postId: postIdRaw };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const { spaceId, postId } = parseSpaceAndPost(url.searchParams);
    if (!spaceId || !Number.isFinite(postId) || postId <= 0) {
      return NextResponse.json({ error: "spaceId and postId required" }, { status: 400 });
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
    if (!passStarterRateLimit(ctx.rateIdentity, spaceId, "starter.likes.read", 180)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
    }

    const starterActorRes = await resolveStarterActor(spaceId, extractStarterToken(req));
    const starterUserId = starterActorRes.actor?.user?.id || "";
    const stateRes = await fetchLikeState(spaceId, postId, starterUserId);
    if (stateRes.error) {
      return NextResponse.json(mapBuildRuntimeError(stateRes.error, "likes load failed"), {
        status: 500,
      });
    }
    return NextResponse.json(stateRes.state);
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { spaceId, postId } = parseSpaceAndPost(body as { spaceId?: unknown; postId?: unknown });
    if (!spaceId || !Number.isFinite(postId) || postId <= 0) {
      return NextResponse.json({ error: "spaceId and postId required" }, { status: 400 });
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
    if (!passStarterRateLimit(ctx.rateIdentity, spaceId, "starter.likes.write", 180)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
    }

    const starterActorRes = await resolveStarterActor(spaceId, extractStarterToken(req, body?.starterToken));
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

    const { error } = await supabaseAdmin.from("user_build_backend_likes").upsert(
      {
        space_id: spaceId,
        post_id: postId,
        user_id: starterUser.id,
      },
      { onConflict: "space_id,post_id,user_id" }
    );
    if (error) {
      const detail = `${error?.code || ""}:${error?.message || ""}`.toLowerCase();
      if (detail.includes("starter mode disabled")) {
        return NextResponse.json({ error: "starter mode disabled" }, { status: 409 });
      }
      if (detail.includes("starter quota exceeded")) {
        return NextResponse.json({ error: "starter quota exceeded" }, { status: 429 });
      }
      return NextResponse.json(mapBuildRuntimeError(error, "like failed"), { status: 500 });
    }

    const stateRes = await fetchLikeState(spaceId, postId, starterUser.id);
    if (stateRes.error) {
      return NextResponse.json(mapBuildRuntimeError(stateRes.error, "likes load failed"), {
        status: 500,
      });
    }
    return NextResponse.json({ ok: true, ...(stateRes.state || { likeCount: 0, likedByMe: false }) });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { spaceId, postId } = parseSpaceAndPost(body as { spaceId?: unknown; postId?: unknown });
    if (!spaceId || !Number.isFinite(postId) || postId <= 0) {
      return NextResponse.json({ error: "spaceId and postId required" }, { status: 400 });
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
    if (!passStarterRateLimit(ctx.rateIdentity, spaceId, "starter.likes.write", 180)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
    }

    const starterActorRes = await resolveStarterActor(spaceId, extractStarterToken(req, body?.starterToken));
    if (starterActorRes.error || !starterActorRes.actor) {
      return NextResponse.json({ error: "starter auth required" }, { status: 401 });
    }
    const starterUser = starterActorRes.actor.user;

    const { error } = await supabaseAdmin
      .from("user_build_backend_likes")
      .delete()
      .eq("space_id", spaceId)
      .eq("post_id", postId)
      .eq("user_id", starterUser.id);
    if (error) {
      return NextResponse.json(mapBuildRuntimeError(error, "unlike failed"), { status: 500 });
    }

    const stateRes = await fetchLikeState(spaceId, postId, starterUser.id);
    if (stateRes.error) {
      return NextResponse.json(mapBuildRuntimeError(stateRes.error, "likes load failed"), {
        status: 500,
      });
    }
    return NextResponse.json({ ok: true, ...(stateRes.state || { likeCount: 0, likedByMe: false }) });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
