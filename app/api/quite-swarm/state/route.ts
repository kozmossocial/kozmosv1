import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const QUITE_SWARM_WORLD_LIMIT = 48;
const ACTIVE_WINDOW_MS = 90 * 1000;
const QUITE_SWARM_ROOM_ID = "main";
const QUITE_SWARM_ROOM_DURATION_MS = 75 * 1000;

function extractBearerToken(req: Request) {
  const header =
    req.headers.get("authorization") || req.headers.get("Authorization");
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

function clampQuiteSwarm(value: number) {
  return Math.max(
    -QUITE_SWARM_WORLD_LIMIT,
    Math.min(QUITE_SWARM_WORLD_LIMIT, value)
  );
}

function hasSchemaError(message: string) {
  return /swarm_x|swarm_y|swarm_active|swarm_updated_at/i.test(message);
}

function hasRoomSchemaError(message: string) {
  return /runtime_quite_swarm_room|started_at|host_user_id|status|seed/i.test(
    message
  );
}

function roomIsExpired(startedAt: string | null | undefined) {
  if (!startedAt) return false;
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return false;
  return Date.now() - startedMs > QUITE_SWARM_ROOM_DURATION_MS;
}

async function resolveUsername(userId: string) {
  const { data } = await supabaseAdmin
    .from("profileskozmos")
    .select("username")
    .eq("id", userId)
    .maybeSingle();
  return String((data as { username?: string } | null)?.username || "user");
}

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const activeSinceIso = new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString();

    const { data: rows, error: rowsErr } = await supabaseAdmin
      .from("runtime_presence")
      .select("user_id, swarm_x, swarm_y, swarm_active, swarm_updated_at, last_seen_at")
      .eq("swarm_active", true)
      .not("swarm_updated_at", "is", null)
      .gte("last_seen_at", activeSinceIso)
      .order("swarm_updated_at", { ascending: false })
      .limit(240);

    if (rowsErr) {
      const msg = String(rowsErr.message || "");
      if (hasSchemaError(msg)) {
        return NextResponse.json(
          { error: "quite swarm schema missing (run migration)" },
          { status: 500 }
        );
      }
      return NextResponse.json(
        { error: "quite swarm state load failed" },
        { status: 500 }
      );
    }

    const userIds = Array.from(
      new Set(
        (rows || [])
          .map((row) => String((row as { user_id?: string }).user_id || ""))
          .filter(Boolean)
      )
    );

    let profileMap: Record<string, { username: string; orbColor: string }> = {};
    if (userIds.length > 0) {
      const { data: profiles, error: profileErr } = await supabaseAdmin
        .from("profileskozmos")
        .select("id, username, orb_color")
        .in("id", userIds);

      if (profileErr) {
        return NextResponse.json(
          { error: "quite swarm profile load failed" },
          { status: 500 }
        );
      }

      profileMap = {};
      (profiles || []).forEach((profile) => {
        const id = String((profile as { id: string }).id);
        profileMap[id] = {
          username: String((profile as { username?: string }).username || "user"),
          orbColor: String((profile as { orb_color?: string }).orb_color || "#7df9ff"),
        };
      });
    }

    const players = (rows || []).map((row) => {
      const userId = String((row as { user_id?: string }).user_id || "");
      const profile = profileMap[userId];
      return {
        userId,
        username: profile?.username || "user",
        color: profile?.orbColor || "#7df9ff",
        x: Number((row as { swarm_x?: number | null }).swarm_x ?? 0),
        y: Number((row as { swarm_y?: number | null }).swarm_y ?? 0),
        active: Boolean((row as { swarm_active?: boolean | null }).swarm_active),
        updatedAt: String(
          (row as { swarm_updated_at?: string | null }).swarm_updated_at || ""
        ),
        lastSeenAt: String((row as { last_seen_at?: string | null }).last_seen_at || ""),
      };
    });

    const { data: roomRow, error: roomErr } = await supabaseAdmin
      .from("runtime_quite_swarm_room")
      .select("id, status, seed, started_at, host_user_id, updated_at")
      .eq("id", QUITE_SWARM_ROOM_ID)
      .maybeSingle();

    if (roomErr) {
      const msg = String(roomErr.message || "");
      if (hasRoomSchemaError(msg)) {
        return NextResponse.json(
          { error: "quite swarm room schema missing (run migration)" },
          { status: 500 }
        );
      }
      return NextResponse.json(
        { error: "quite swarm room load failed" },
        { status: 500 }
      );
    }

    if (
      roomRow &&
      String((roomRow as { status?: string }).status || "idle") === "running" &&
      roomIsExpired((roomRow as { started_at?: string | null }).started_at)
    ) {
      await supabaseAdmin
        .from("runtime_quite_swarm_room")
        .update({
          status: "idle",
          seed: null,
          started_at: null,
          host_user_id: null,
        })
        .eq("id", QUITE_SWARM_ROOM_ID)
        .eq("status", "running");
    }

    const freshRoomRow =
      roomRow &&
      String((roomRow as { status?: string }).status || "idle") === "running" &&
      roomIsExpired((roomRow as { started_at?: string | null }).started_at)
        ? {
            ...roomRow,
            status: "idle",
            seed: null,
            started_at: null,
            host_user_id: null,
          }
        : roomRow;

    const room = freshRoomRow
      ? {
          id: String((freshRoomRow as { id?: string }).id || QUITE_SWARM_ROOM_ID),
          status:
            String((freshRoomRow as { status?: string }).status || "idle") === "running"
              ? "running"
              : "idle",
          seed:
            typeof (freshRoomRow as { seed?: number | null }).seed === "number"
              ? Number((freshRoomRow as { seed?: number | null }).seed)
              : null,
          startedAt: String(
            (freshRoomRow as { started_at?: string | null }).started_at || ""
          ),
          hostUserId: String(
            (freshRoomRow as { host_user_id?: string | null }).host_user_id || ""
          ),
          updatedAt: String(
            (freshRoomRow as { updated_at?: string | null }).updated_at || ""
          ),
        }
      : {
          id: QUITE_SWARM_ROOM_ID,
          status: "idle",
          seed: null,
          startedAt: "",
          hostUserId: "",
          updatedAt: "",
        };

    return NextResponse.json({ players, room });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      x?: unknown;
      y?: unknown;
      dx?: unknown;
      dy?: unknown;
      active?: unknown;
    };
    const action =
      typeof body.action === "string" ? body.action.trim().toLowerCase() : "";

    if (action === "start_room" || action === "stop_room") {
      const { data: roomRow, error: roomErr } = await supabaseAdmin
        .from("runtime_quite_swarm_room")
        .select("id, status, seed, started_at, host_user_id")
        .eq("id", QUITE_SWARM_ROOM_ID)
        .maybeSingle();

      if (roomErr) {
        const msg = String(roomErr.message || "");
        if (hasRoomSchemaError(msg)) {
          return NextResponse.json(
            { error: "quite swarm room schema missing (run migration)" },
            { status: 500 }
          );
        }
        return NextResponse.json(
          { error: "quite swarm room load failed" },
          { status: 500 }
        );
      }

      const roomStatus = String((roomRow as { status?: string } | null)?.status || "idle");
      const roomHost = String(
        (roomRow as { host_user_id?: string | null } | null)?.host_user_id || ""
      );
      const expired = roomIsExpired(
        (roomRow as { started_at?: string | null } | null)?.started_at
      );

      if (action === "start_room") {
        if (roomStatus === "running" && !expired && roomHost && roomHost !== user.id) {
          return NextResponse.json(
            { error: "room already running by another host" },
            { status: 409 }
          );
        }

        const seed = Math.floor(Math.random() * 2_000_000_000);
        const startedAt = new Date(Date.now() + 1800).toISOString();
        const username = await resolveUsername(user.id);
        const nowIso = new Date().toISOString();

        const { error: upsertRoomErr } = await supabaseAdmin
          .from("runtime_quite_swarm_room")
          .upsert({
            id: QUITE_SWARM_ROOM_ID,
            status: "running",
            seed,
            started_at: startedAt,
            host_user_id: user.id,
          });

        if (upsertRoomErr) {
          return NextResponse.json(
            { error: "quite swarm room update failed" },
            { status: 500 }
          );
        }

        const maybeX =
          typeof body.x === "number" && Number.isFinite(body.x)
            ? clampQuiteSwarm(Number(body.x))
            : 0;
        const maybeY =
          typeof body.y === "number" && Number.isFinite(body.y)
            ? clampQuiteSwarm(Number(body.y))
            : 0;

        const { error: upsertPresenceErr } = await supabaseAdmin
          .from("runtime_presence")
          .upsert({
            user_id: user.id,
            username,
            last_seen_at: nowIso,
            swarm_x: maybeX,
            swarm_y: maybeY,
            swarm_active: true,
            swarm_updated_at: nowIso,
          });

        if (upsertPresenceErr) {
          return NextResponse.json(
            { error: "quite swarm state update failed" },
            { status: 500 }
          );
        }

        return NextResponse.json({
          ok: true,
          room: {
            id: QUITE_SWARM_ROOM_ID,
            status: "running",
            seed,
            startedAt,
            hostUserId: user.id,
          },
        });
      }

      if (roomStatus === "running" && roomHost && roomHost !== user.id) {
        return NextResponse.json(
          { error: "only host can stop running room" },
          { status: 403 }
        );
      }

      const { error: stopErr } = await supabaseAdmin
        .from("runtime_quite_swarm_room")
        .upsert({
          id: QUITE_SWARM_ROOM_ID,
          status: "idle",
          seed: null,
          started_at: null,
          host_user_id: null,
        });

      if (stopErr) {
        return NextResponse.json(
          { error: "quite swarm room stop failed" },
          { status: 500 }
        );
      }

      return NextResponse.json({
        ok: true,
        room: {
          id: QUITE_SWARM_ROOM_ID,
          status: "idle",
          seed: null,
          startedAt: "",
          hostUserId: "",
        },
      });
    }

    const { data: current, error: currentErr } = await supabaseAdmin
      .from("runtime_presence")
      .select("swarm_x, swarm_y")
      .eq("user_id", user.id)
      .maybeSingle();

    if (currentErr) {
      const msg = String(currentErr.message || "");
      if (hasSchemaError(msg)) {
        return NextResponse.json(
          { error: "quite swarm schema missing (run migration)" },
          { status: 500 }
        );
      }
      return NextResponse.json(
        { error: "quite swarm position load failed" },
        { status: 500 }
      );
    }

    const hasAbsX = typeof body.x === "number" && Number.isFinite(body.x);
    const hasAbsY = typeof body.y === "number" && Number.isFinite(body.y);
    const hasDeltaX = typeof body.dx === "number" && Number.isFinite(body.dx);
    const hasDeltaY = typeof body.dy === "number" && Number.isFinite(body.dy);

    if (!hasAbsX && !hasAbsY && !hasDeltaX && !hasDeltaY) {
      return NextResponse.json(
        { error: "x/y or dx/dy required" },
        { status: 400 }
      );
    }

    const baseX = Number((current as { swarm_x?: number | null } | null)?.swarm_x ?? 0);
    const baseY = Number((current as { swarm_y?: number | null } | null)?.swarm_y ?? 0);

    const nextX = clampQuiteSwarm(
      hasAbsX ? Number(body.x) : baseX + (hasDeltaX ? Number(body.dx) : 0)
    );
    const nextY = clampQuiteSwarm(
      hasAbsY ? Number(body.y) : baseY + (hasDeltaY ? Number(body.dy) : 0)
    );

    const active = typeof body.active === "boolean" ? body.active : true;
    const nowIso = new Date().toISOString();
    const username = await resolveUsername(user.id);

    const { error: upsertErr } = await supabaseAdmin.from("runtime_presence").upsert({
      user_id: user.id,
      username,
      last_seen_at: nowIso,
      swarm_x: nextX,
      swarm_y: nextY,
      swarm_active: active,
      swarm_updated_at: nowIso,
    });

    if (upsertErr) {
      const msg = String(upsertErr.message || "");
      if (hasSchemaError(msg)) {
        return NextResponse.json(
          { error: "quite swarm schema missing (run migration)" },
          { status: 500 }
        );
      }
      return NextResponse.json(
        { error: "quite swarm state update failed" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      state: { x: nextX, y: nextY, active, updatedAt: nowIso },
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const nowIso = new Date().toISOString();

    const { error: updateErr } = await supabaseAdmin
      .from("runtime_presence")
      .update({
        last_seen_at: nowIso,
        swarm_active: false,
        swarm_updated_at: nowIso,
      })
      .eq("user_id", user.id);

    if (updateErr) {
      const msg = String(updateErr.message || "");
      if (hasSchemaError(msg)) {
        return NextResponse.json(
          { error: "quite swarm schema missing (run migration)" },
          { status: 500 }
        );
      }
      return NextResponse.json(
        { error: "quite swarm state clear failed" },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
