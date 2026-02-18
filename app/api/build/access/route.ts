import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function extractBearerToken(req: Request) {
  const header =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function authenticateUser(req: Request) {
  const token = extractBearerToken(req);
  if (!token) return { user: null as null, token: null as null };

  const authClient = createClient(supabaseUrl, supabaseAnonKey);
  const {
    data: { user },
  } = await authClient.auth.getUser(token);

  return { user, token };
}

async function isSpaceOwner(spaceId: string, userId: string) {
  const { data } = await supabaseAdmin
    .from("user_build_spaces")
    .select("id")
    .eq("id", spaceId)
    .eq("owner_id", userId)
    .maybeSingle();
  return Boolean(data?.id);
}

async function resolveUserIdByUsername(username: string) {
  const clean = username.trim();
  if (!clean) return null;
  const { data } = await supabaseAdmin
    .from("profileskozmos")
    .select("id")
    .eq("username", clean)
    .maybeSingle();
  return data?.id ?? null;
}

async function areUsersInTouch(a: string, b: string) {
  const pairFilter = `and(requester_id.eq.${a},requested_id.eq.${b}),and(requester_id.eq.${b},requested_id.eq.${a})`;
  const { data, error } = await supabaseAdmin
    .from("keep_in_touch_requests")
    .select("id")
    .eq("status", "accepted")
    .or(pairFilter)
    .limit(1);
  if (error) return { ok: false, error };
  return { ok: Array.isArray(data) && data.length > 0, error: null };
}

export async function GET(req: Request) {
  try {
    const { user } = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const spaceId = url.searchParams.get("spaceId") || "";
    if (!spaceId) {
      return NextResponse.json({ error: "spaceId required" }, { status: 400 });
    }

    const owner = await isSpaceOwner(spaceId, user.id);
    if (!owner) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { data, error } = await supabaseAdmin
      .from("user_build_space_access")
      .select("user_id, can_edit")
      .eq("space_id", spaceId)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: "list failed" }, { status: 500 });
    }

    const userIds = Array.from(new Set((data || []).map((row) => row.user_id)));
    const nameMap = new Map<string, string>();

    if (userIds.length > 0) {
      const { data: profiles } = await supabaseAdmin
        .from("profileskozmos")
        .select("id, username")
        .in("id", userIds);
      (profiles || []).forEach((p) => nameMap.set(p.id, p.username));
    }

    const entries = (data || []).map((row) => ({
      userId: row.user_id,
      username: nameMap.get(row.user_id) || "user",
      canEdit: row.can_edit,
    }));

    return NextResponse.json({ entries });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { user } = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId : "";
    const username = typeof body?.username === "string" ? body.username : "";
    const canEdit = body?.canEdit === true;

    if (!spaceId || !username.trim()) {
      return NextResponse.json(
        { error: "spaceId and username required" },
        { status: 400 }
      );
    }

    const owner = await isSpaceOwner(spaceId, user.id);
    if (!owner) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const targetUserId = await resolveUserIdByUsername(username);
    if (!targetUserId) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }

    if (targetUserId === user.id) {
      return NextResponse.json({ error: "cannot grant yourself" }, { status: 400 });
    }

    const inTouch = await areUsersInTouch(user.id, targetUserId);
    if (inTouch.error) {
      return NextResponse.json({ error: "in-touch check failed" }, { status: 500 });
    }
    if (!inTouch.ok) {
      return NextResponse.json({ error: "user is not in touch" }, { status: 403 });
    }

    const { error } = await supabaseAdmin.from("user_build_space_access").upsert(
      {
        space_id: spaceId,
        user_id: targetUserId,
        can_edit: canEdit,
        granted_by: user.id,
      },
      { onConflict: "space_id,user_id" }
    );

    if (error) {
      return NextResponse.json({ error: "grant failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { user } = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId : "";
    const username = typeof body?.username === "string" ? body.username : "";
    if (!spaceId || !username.trim()) {
      return NextResponse.json(
        { error: "spaceId and username required" },
        { status: 400 }
      );
    }

    const owner = await isSpaceOwner(spaceId, user.id);
    if (!owner) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const targetUserId = await resolveUserIdByUsername(username);
    if (!targetUserId) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }

    const { error } = await supabaseAdmin
      .from("user_build_space_access")
      .delete()
      .eq("space_id", spaceId)
      .eq("user_id", targetUserId);

    if (error) {
      return NextResponse.json({ error: "revoke failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
