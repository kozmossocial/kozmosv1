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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MessageRow = {
  id: number;
  thread_id: string;
  sender_id: string;
  body: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type ProfileRow = {
  id: string;
  username: string;
};

async function isThreadParticipant(spaceId: string, threadId: string, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_build_backend_dm_participants")
    .select("id, can_write")
    .eq("space_id", spaceId)
    .eq("thread_id", threadId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { error, participant: null as unknown };
  return { error: null, participant: data };
}

function parseThreadId(value: unknown) {
  const threadId = typeof value === "string" ? value.trim() : "";
  return UUID_RE.test(threadId) ? threadId : "";
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const spaceId = String(url.searchParams.get("spaceId") || "").trim();
    const threadId = parseThreadId(url.searchParams.get("threadId"));
    const limit = clampLimit(url.searchParams.get("limit"), 120, 1, 300);
    const afterId = Number(url.searchParams.get("afterId") || "0");
    const useAfter = Number.isFinite(afterId) && afterId > 0;

    if (!spaceId || !threadId) {
      return NextResponse.json({ error: "spaceId and threadId required" }, { status: 400 });
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
    if (!passStarterRateLimit(ctx.rateIdentity, spaceId, "starter.dm.messages.read", 220)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
    }

    const starterActorRes = await resolveStarterActor(spaceId, extractStarterToken(req));
    const starterActor = starterActorRes.actor || null;
    const participantRes = starterActor
      ? await isThreadParticipant(spaceId, threadId, starterActor.user.id)
      : { error: null, participant: null };
    const isOwner = Boolean(ctx.user?.id && ctx.access.space.owner_id === ctx.user.id);
    if (participantRes.error) {
      return NextResponse.json(mapBuildRuntimeError(participantRes.error, "thread check failed"), {
        status: 500,
      });
    }
    if (!isOwner && !participantRes.participant) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    let query = supabaseAdmin
      .from("user_build_backend_dm_messages")
      .select("id, thread_id, sender_id, body, metadata, created_at")
      .eq("space_id", spaceId)
      .eq("thread_id", threadId)
      .order("id", { ascending: true })
      .limit(limit);
    if (useAfter) {
      query = query.gt("id", afterId);
    }
    const { data, error } = await query;
    if (error) {
      return NextResponse.json(mapBuildRuntimeError(error, "messages load failed"), {
        status: 500,
      });
    }

    const rows = (data || []) as MessageRow[];
    if (rows.length === 0) {
      return NextResponse.json({ messages: [] });
    }

    const senderIds = Array.from(new Set(rows.map((row) => row.sender_id)));
    const profilesRes = await supabaseAdmin
      .from("user_build_starter_users")
      .select("id, username")
      .eq("space_id", spaceId)
      .in("id", senderIds);
    if (profilesRes.error) {
      return NextResponse.json({ error: "messages profile load failed" }, { status: 500 });
    }

    const profileMap = new Map<string, string>();
    ((profilesRes.data || []) as ProfileRow[]).forEach((row) => {
      profileMap.set(row.id, String(row.username || "user"));
    });

    return NextResponse.json({
      messages: rows.map((row) => ({
        id: row.id,
        threadId: row.thread_id,
        senderId: row.sender_id,
        senderUsername: profileMap.get(row.sender_id) || "user",
        body: row.body,
        metadata: row.metadata || {},
        createdAt: row.created_at,
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
    const threadId = parseThreadId(body?.threadId);
    const messageBody = typeof body?.body === "string" ? body.body.trim() : "";
    const metadata = sanitizeJsonValue(body?.metadata);

    if (!spaceId || !threadId || !messageBody) {
      return NextResponse.json({ error: "spaceId, threadId and body required" }, { status: 400 });
    }
    if (messageBody.length > 4000) {
      return NextResponse.json({ error: "message body too long" }, { status: 400 });
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
    if (!passStarterRateLimit(ctx.rateIdentity, spaceId, "starter.dm.messages.write", 180)) {
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

    const participantRes = await isThreadParticipant(spaceId, threadId, starterUser.id);
    if (participantRes.error) {
      return NextResponse.json(mapBuildRuntimeError(participantRes.error, "thread check failed"), {
        status: 500,
      });
    }
    if (!participantRes.participant) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (participantRes.participant.can_write === false) {
      return NextResponse.json({ error: "thread is read-only for this user" }, { status: 403 });
    }

    const { data, error } = await supabaseAdmin
      .from("user_build_backend_dm_messages")
      .insert({
        space_id: spaceId,
        thread_id: threadId,
        sender_id: starterUser.id,
        body: messageBody,
        metadata,
      })
      .select("id, thread_id, sender_id, body, metadata, created_at")
      .single();

    if (error || !data) {
      const detail = `${error?.code || ""}:${error?.message || ""}`.toLowerCase();
      if (detail.includes("starter mode disabled")) {
        return NextResponse.json({ error: "starter mode disabled" }, { status: 409 });
      }
      if (detail.includes("starter quota exceeded")) {
        return NextResponse.json({ error: "starter quota exceeded" }, { status: 429 });
      }
      return NextResponse.json(mapBuildRuntimeError(error, "message send failed"), {
        status: 500,
      });
    }

    await supabaseAdmin
      .from("user_build_backend_dm_threads")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", threadId)
      .eq("space_id", spaceId);

    return NextResponse.json({
      ok: true,
      message: {
        id: data.id,
        threadId: data.thread_id,
        senderId: data.sender_id,
        senderUsername: starterUser.username || "user",
        body: data.body,
        metadata: data.metadata || {},
        createdAt: data.created_at,
      },
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
