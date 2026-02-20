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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ThreadRow = {
  id: string;
  space_id: string;
  created_by: string;
  subject: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type ParticipantRow = {
  thread_id: string;
  user_id: string;
  can_write: boolean;
};

type ProfileRow = {
  id: string;
  username: string;
};

function asUuidList(input: unknown) {
  if (!Array.isArray(input)) return [] as string[];
  return Array.from(
    new Set(
      input
        .map((value) => String(value || "").trim())
        .filter((value) => UUID_RE.test(value))
    )
  );
}

export async function GET(req: Request) {
  try {
    const user = await authenticateBuildRuntimeUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const spaceId = String(url.searchParams.get("spaceId") || "").trim();
    const limit = clampLimit(url.searchParams.get("limit"), 50, 1, 150);

    if (!spaceId) {
      return NextResponse.json({ error: "spaceId required" }, { status: 400 });
    }
    if (!passStarterRateLimit(user.id, spaceId, "starter.dm.threads.read", 150)) {
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

    let threadIds: string[] = [];
    if (access.space.owner_id === user.id) {
      const allThreadsRes = await supabaseAdmin
        .from("user_build_backend_dm_threads")
        .select("id")
        .eq("space_id", spaceId)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (allThreadsRes.error) {
        return NextResponse.json(
          mapBuildRuntimeError(allThreadsRes.error, "threads load failed"),
          { status: 500 }
        );
      }
      threadIds = (allThreadsRes.data || [])
        .map((row) => String((row as { id?: string }).id || ""))
        .filter(Boolean);
    } else {
      const participantRes = await supabaseAdmin
        .from("user_build_backend_dm_participants")
        .select("thread_id")
        .eq("space_id", spaceId)
        .eq("user_id", user.id)
        .limit(limit);
      if (participantRes.error) {
        return NextResponse.json(
          mapBuildRuntimeError(participantRes.error, "threads load failed"),
          { status: 500 }
        );
      }
      threadIds = (participantRes.data || [])
        .map((row) => String((row as { thread_id?: string }).thread_id || ""))
        .filter(Boolean);
    }

    if (threadIds.length === 0) {
      return NextResponse.json({ mode: modeRes.mode, threads: [] });
    }

    const [threadsRes, participantsRes] = await Promise.all([
      supabaseAdmin
        .from("user_build_backend_dm_threads")
        .select("id, space_id, created_by, subject, metadata, created_at, updated_at")
        .eq("space_id", spaceId)
        .in("id", threadIds)
        .order("updated_at", { ascending: false }),
      supabaseAdmin
        .from("user_build_backend_dm_participants")
        .select("thread_id, user_id, can_write")
        .eq("space_id", spaceId)
        .in("thread_id", threadIds),
    ]);
    if (threadsRes.error || participantsRes.error) {
      return NextResponse.json({ error: "threads load failed" }, { status: 500 });
    }

    const participantRows = (participantsRes.data || []) as ParticipantRow[];
    const userIds = Array.from(new Set(participantRows.map((row) => row.user_id)));
    const profilesRes = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username")
      .in("id", userIds);
    if (profilesRes.error) {
      return NextResponse.json({ error: "threads profile load failed" }, { status: 500 });
    }
    const profileMap = new Map<string, string>();
    ((profilesRes.data || []) as ProfileRow[]).forEach((row) => {
      profileMap.set(row.id, String(row.username || "user"));
    });

    const participantsByThread = new Map<
      string,
      Array<{ userId: string; username: string; canWrite: boolean }>
    >();
    participantRows.forEach((row) => {
      const list = participantsByThread.get(row.thread_id) || [];
      list.push({
        userId: row.user_id,
        username: profileMap.get(row.user_id) || "user",
        canWrite: row.can_write === true,
      });
      participantsByThread.set(row.thread_id, list);
    });

    return NextResponse.json({
      mode: modeRes.mode,
      threads: ((threadsRes.data || []) as ThreadRow[]).map((thread) => ({
        id: thread.id,
        spaceId: thread.space_id,
        createdBy: thread.created_by,
        subject: thread.subject,
        metadata: thread.metadata || {},
        createdAt: thread.created_at,
        updatedAt: thread.updated_at,
        participants: participantsByThread.get(thread.id) || [],
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
    const subject = typeof body?.subject === "string" ? body.subject.trim().slice(0, 160) : "";
    const metadata = sanitizeJsonValue(body?.metadata);
    const participantIds = asUuidList(body?.participantUserIds).slice(0, 16);

    if (!spaceId) {
      return NextResponse.json({ error: "spaceId required" }, { status: 400 });
    }
    if (!passStarterRateLimit(user.id, spaceId, "starter.dm.threads.write", 80)) {
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

    const allParticipants = Array.from(new Set([user.id, ...participantIds]));
    const threadInsertRes = await supabaseAdmin
      .from("user_build_backend_dm_threads")
      .insert({
        space_id: spaceId,
        created_by: user.id,
        subject,
        metadata,
      })
      .select("id, space_id, created_by, subject, metadata, created_at, updated_at")
      .single();

    if (threadInsertRes.error || !threadInsertRes.data) {
      const detail = `${threadInsertRes.error?.code || ""}:${threadInsertRes.error?.message || ""}`.toLowerCase();
      if (detail.includes("starter mode disabled")) {
        return NextResponse.json({ error: "starter mode disabled" }, { status: 409 });
      }
      if (detail.includes("starter quota exceeded")) {
        return NextResponse.json({ error: "starter quota exceeded" }, { status: 429 });
      }
      return NextResponse.json(mapBuildRuntimeError(threadInsertRes.error, "thread create failed"), {
        status: 500,
      });
    }

    const thread = threadInsertRes.data as ThreadRow;
    const participantRows = allParticipants.map((participantId) => ({
      space_id: spaceId,
      thread_id: thread.id,
      user_id: participantId,
      can_write: true,
    }));

    const participantInsertRes = await supabaseAdmin
      .from("user_build_backend_dm_participants")
      .insert(participantRows);
    if (participantInsertRes.error) {
      return NextResponse.json(
        mapBuildRuntimeError(participantInsertRes.error, "thread participants create failed"),
        { status: 500 }
      );
    }

    const profilesRes = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username")
      .in("id", allParticipants);
    if (profilesRes.error) {
      return NextResponse.json({ error: "thread profile load failed" }, { status: 500 });
    }
    const profileMap = new Map<string, string>();
    ((profilesRes.data || []) as ProfileRow[]).forEach((row) => {
      profileMap.set(row.id, String(row.username || "user"));
    });

    return NextResponse.json({
      ok: true,
      thread: {
        id: thread.id,
        spaceId: thread.space_id,
        createdBy: thread.created_by,
        subject: thread.subject,
        metadata: thread.metadata || {},
        createdAt: thread.created_at,
        updatedAt: thread.updated_at,
        participants: allParticipants.map((participantId) => ({
          userId: participantId,
          username: profileMap.get(participantId) || "user",
          canWrite: true,
        })),
      },
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
