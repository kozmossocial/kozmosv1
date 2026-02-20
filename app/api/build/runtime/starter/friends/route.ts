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
  normalizeStarterUsername,
  resolveStarterActor,
} from "@/app/api/build/runtime/starter/_auth";

type StarterProfileRow = {
  id: string;
  username: string;
  display_name: string;
};

type FriendRequestRow = {
  id: number;
  from_user_id: string;
  to_user_id: string;
  status: "pending" | "accepted" | "declined" | "blocked";
  created_at: string;
  updated_at: string;
};

type FriendshipRow = {
  id: number;
  user_a_id: string;
  user_b_id: string;
  created_at: string;
};

function normalizePair(a: string, b: string) {
  return a < b ? [a, b] : [b, a];
}

async function loadStarterProfiles(spaceId: string, ids: string[]) {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) return new Map<string, StarterProfileRow>();
  const { data } = await supabaseAdmin
    .from("user_build_starter_users")
    .select("id, username, display_name")
    .eq("space_id", spaceId)
    .in("id", uniqueIds);
  const map = new Map<string, StarterProfileRow>();
  ((data || []) as StarterProfileRow[]).forEach((row) => map.set(row.id, row));
  return map;
}

async function enforceFriendQuotas(spaceId: string) {
  const modeRes = await getStarterMode(spaceId);
  if (modeRes.error) return { error: "mode load failed", blocked: true };
  if (!modeRes.mode?.enabled) return { error: "starter mode disabled", blocked: true };
  const [requestCountRes, friendshipCountRes] = await Promise.all([
    supabaseAdmin
      .from("user_build_starter_friend_requests")
      .select("id", { count: "exact", head: true })
      .eq("space_id", spaceId),
    supabaseAdmin
      .from("user_build_starter_friendships")
      .select("id", { count: "exact", head: true })
      .eq("space_id", spaceId),
  ]);
  if (requestCountRes.error || friendshipCountRes.error) {
    return { error: "friend quota check failed", blocked: true };
  }
  const reqQuota = Number(modeRes.mode?.friend_requests_quota || 12000);
  const linkQuota = Number(modeRes.mode?.friendships_quota || 12000);
  if (Number(requestCountRes.count || 0) >= reqQuota) {
    return { error: "starter quota exceeded: friend_requests", blocked: true };
  }
  if (Number(friendshipCountRes.count || 0) >= linkQuota) {
    return { error: "starter quota exceeded: friendships", blocked: true };
  }
  return { error: null, blocked: false };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const spaceId = String(url.searchParams.get("spaceId") || "").trim();
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
    if (!passStarterRateLimit(ctx.rateIdentity, spaceId, "starter.friends.read", 220)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
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

    const starterToken = extractStarterToken(req);
    const actorRes = await resolveStarterActor(spaceId, starterToken);
    if (actorRes.error || !actorRes.actor) {
      return NextResponse.json({ error: "starter auth required" }, { status: 401 });
    }
    const me = actorRes.actor.user;

    const [friendshipRes, incomingRes, outgoingRes] = await Promise.all([
      supabaseAdmin
        .from("user_build_starter_friendships")
        .select("id, user_a_id, user_b_id, created_at")
        .eq("space_id", spaceId)
        .or(`user_a_id.eq.${me.id},user_b_id.eq.${me.id}`)
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("user_build_starter_friend_requests")
        .select("id, from_user_id, to_user_id, status, created_at, updated_at")
        .eq("space_id", spaceId)
        .eq("to_user_id", me.id)
        .eq("status", "pending")
        .order("updated_at", { ascending: false }),
      supabaseAdmin
        .from("user_build_starter_friend_requests")
        .select("id, from_user_id, to_user_id, status, created_at, updated_at")
        .eq("space_id", spaceId)
        .eq("from_user_id", me.id)
        .eq("status", "pending")
        .order("updated_at", { ascending: false }),
    ]);

    if (friendshipRes.error || incomingRes.error || outgoingRes.error) {
      return NextResponse.json({ error: "friends load failed" }, { status: 500 });
    }

    const friendshipRows = (friendshipRes.data || []) as FriendshipRow[];
    const incomingRows = (incomingRes.data || []) as FriendRequestRow[];
    const outgoingRows = (outgoingRes.data || []) as FriendRequestRow[];
    const relatedIds = [
      ...friendshipRows.map((row) => (row.user_a_id === me.id ? row.user_b_id : row.user_a_id)),
      ...incomingRows.map((row) => row.from_user_id),
      ...outgoingRows.map((row) => row.to_user_id),
    ];
    const profileMap = await loadStarterProfiles(spaceId, relatedIds);

    return NextResponse.json({
      me: {
        id: me.id,
        username: me.username,
        displayName: me.display_name || "",
      },
      friends: friendshipRows.map((row) => {
        const friendId = row.user_a_id === me.id ? row.user_b_id : row.user_a_id;
        const profile = profileMap.get(friendId);
        return {
          friendshipId: row.id,
          userId: friendId,
          username: profile?.username || "user",
          displayName: profile?.display_name || "",
          createdAt: row.created_at,
        };
      }),
      incoming: incomingRows.map((row) => {
        const profile = profileMap.get(row.from_user_id);
        return {
          requestId: row.id,
          fromUserId: row.from_user_id,
          fromUsername: profile?.username || "user",
          fromDisplayName: profile?.display_name || "",
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }),
      outgoing: outgoingRows.map((row) => {
        const profile = profileMap.get(row.to_user_id);
        return {
          requestId: row.id,
          toUserId: row.to_user_id,
          toUsername: profile?.username || "user",
          toDisplayName: profile?.display_name || "",
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }),
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim() : "";
    const toUsernameRaw = typeof body?.toUsername === "string" ? body.toUsername : "";
    if (!spaceId || !toUsernameRaw) {
      return NextResponse.json({ error: "spaceId and toUsername required" }, { status: 400 });
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
    if (!passStarterRateLimit(ctx.rateIdentity, spaceId, "starter.friends.write", 120)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
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

    const actorRes = await resolveStarterActor(spaceId, extractStarterToken(req, body?.starterToken));
    if (actorRes.error || !actorRes.actor) {
      return NextResponse.json({ error: "starter auth required" }, { status: 401 });
    }
    const me = actorRes.actor.user;

    const normalized = normalizeStarterUsername(toUsernameRaw);
    if (!normalized.usernameKey) {
      return NextResponse.json({ error: "invalid username" }, { status: 400 });
    }

    const targetRes = await supabaseAdmin
      .from("user_build_starter_users")
      .select("id, username, display_name")
      .eq("space_id", spaceId)
      .eq("username_key", normalized.usernameKey)
      .maybeSingle();
    if (targetRes.error || !targetRes.data) {
      return NextResponse.json({ error: "target user not found" }, { status: 404 });
    }
    const target = targetRes.data as StarterProfileRow;
    if (target.id === me.id) {
      return NextResponse.json({ error: "cannot friend yourself" }, { status: 400 });
    }

    const quotaRes = await enforceFriendQuotas(spaceId);
    if (quotaRes.blocked) {
      const status = quotaRes.error?.includes("quota") ? 429 : 409;
      return NextResponse.json({ error: quotaRes.error }, { status });
    }

    const [a, b] = normalizePair(me.id, target.id);
    const existingFriendship = await supabaseAdmin
      .from("user_build_starter_friendships")
      .select("id")
      .eq("space_id", spaceId)
      .eq("user_a_id", a)
      .eq("user_b_id", b)
      .maybeSingle();
    if (existingFriendship.error) {
      return NextResponse.json({ error: "friend check failed" }, { status: 500 });
    }
    if (existingFriendship.data?.id) {
      return NextResponse.json({ ok: true, state: "already_friends" });
    }

    const reversePendingRes = await supabaseAdmin
      .from("user_build_starter_friend_requests")
      .select("id")
      .eq("space_id", spaceId)
      .eq("from_user_id", target.id)
      .eq("to_user_id", me.id)
      .eq("status", "pending")
      .maybeSingle();
    if (reversePendingRes.error) {
      return NextResponse.json({ error: "friend request check failed" }, { status: 500 });
    }

    if (reversePendingRes.data?.id) {
      const acceptReq = await supabaseAdmin
        .from("user_build_starter_friend_requests")
        .update({ status: "accepted" })
        .eq("id", reversePendingRes.data.id)
        .eq("space_id", spaceId);
      if (acceptReq.error) {
        return NextResponse.json({ error: "friend request accept failed" }, { status: 500 });
      }
      const linkCreate = await supabaseAdmin.from("user_build_starter_friendships").upsert(
        {
          space_id: spaceId,
          user_a_id: a,
          user_b_id: b,
        },
        { onConflict: "space_id,user_a_id,user_b_id" }
      );
      if (linkCreate.error) {
        return NextResponse.json({ error: "friendship create failed" }, { status: 500 });
      }
      return NextResponse.json({
        ok: true,
        state: "accepted_reverse_request",
        friend: {
          userId: target.id,
          username: target.username,
          displayName: target.display_name || "",
        },
      });
    }

    const requestUpsert = await supabaseAdmin.from("user_build_starter_friend_requests").upsert(
      {
        space_id: spaceId,
        from_user_id: me.id,
        to_user_id: target.id,
        status: "pending",
      },
      { onConflict: "space_id,from_user_id,to_user_id" }
    );
    if (requestUpsert.error) {
      return NextResponse.json({ error: "friend request create failed" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      state: "request_sent",
      to: {
        userId: target.id,
        username: target.username,
        displayName: target.display_name || "",
      },
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim() : "";
    const requestId = Number(body?.requestId || 0);
    const action = typeof body?.action === "string" ? body.action.trim().toLowerCase() : "";
    if (!spaceId || !Number.isFinite(requestId) || requestId <= 0) {
      return NextResponse.json({ error: "spaceId and requestId required" }, { status: 400 });
    }
    if (!["accept", "decline", "block"].includes(action)) {
      return NextResponse.json({ error: "action must be accept|decline|block" }, { status: 400 });
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
    if (!passStarterRateLimit(ctx.rateIdentity, spaceId, "starter.friends.write", 120)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
    }

    const actorRes = await resolveStarterActor(spaceId, extractStarterToken(req, body?.starterToken));
    if (actorRes.error || !actorRes.actor) {
      return NextResponse.json({ error: "starter auth required" }, { status: 401 });
    }
    const me = actorRes.actor.user;

    const requestRes = await supabaseAdmin
      .from("user_build_starter_friend_requests")
      .select("id, from_user_id, to_user_id, status, created_at, updated_at")
      .eq("space_id", spaceId)
      .eq("id", requestId)
      .maybeSingle();
    if (requestRes.error || !requestRes.data) {
      return NextResponse.json({ error: "request not found" }, { status: 404 });
    }
    const row = requestRes.data as FriendRequestRow;
    if (row.to_user_id !== me.id && row.from_user_id !== me.id) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (row.status !== "pending") {
      return NextResponse.json({ ok: true, state: row.status });
    }

    const status = action === "accept" ? "accepted" : action === "decline" ? "declined" : "blocked";
    const updateRes = await supabaseAdmin
      .from("user_build_starter_friend_requests")
      .update({ status })
      .eq("space_id", spaceId)
      .eq("id", requestId);
    if (updateRes.error) {
      return NextResponse.json({ error: "request update failed" }, { status: 500 });
    }

    if (status === "accepted") {
      const [a, b] = normalizePair(row.from_user_id, row.to_user_id);
      const createLink = await supabaseAdmin.from("user_build_starter_friendships").upsert(
        {
          space_id: spaceId,
          user_a_id: a,
          user_b_id: b,
        },
        { onConflict: "space_id,user_a_id,user_b_id" }
      );
      if (createLink.error) {
        return NextResponse.json({ error: "friendship create failed" }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true, state: status });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim() : "";
    const friendUserId = typeof body?.friendUserId === "string" ? body.friendUserId.trim() : "";
    if (!spaceId || !friendUserId) {
      return NextResponse.json({ error: "spaceId and friendUserId required" }, { status: 400 });
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
    if (!passStarterRateLimit(ctx.rateIdentity, spaceId, "starter.friends.write", 120)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
    }

    const actorRes = await resolveStarterActor(spaceId, extractStarterToken(req, body?.starterToken));
    if (actorRes.error || !actorRes.actor) {
      return NextResponse.json({ error: "starter auth required" }, { status: 401 });
    }
    const me = actorRes.actor.user;
    const [a, b] = normalizePair(me.id, friendUserId);
    const removeRes = await supabaseAdmin
      .from("user_build_starter_friendships")
      .delete()
      .eq("space_id", spaceId)
      .eq("user_a_id", a)
      .eq("user_b_id", b);
    if (removeRes.error) {
      return NextResponse.json({ error: "unfriend failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
