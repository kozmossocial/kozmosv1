import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

type SpaceAccess = {
  space: {
    id: string;
    owner_id: string;
    is_public: boolean;
  } | null;
  canRead: boolean;
  canEdit: boolean;
  error: { code?: string; message?: string } | null;
};

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

function mapError(error: { code?: string; message?: string } | null, fallback: string) {
  if (!error) return { error: fallback };
  const detail = [error.code, error.message].filter(Boolean).join(": ");
  return { error: detail || fallback };
}

async function getSpaceAccess(spaceId: string, userId: string): Promise<SpaceAccess> {
  const { data: space, error: spaceErr } = await supabaseAdmin
    .from("user_build_spaces")
    .select("id, owner_id, is_public")
    .eq("id", spaceId)
    .maybeSingle();
  if (spaceErr) return { space: null, canRead: false, canEdit: false, error: spaceErr };
  if (!space) return { space: null, canRead: false, canEdit: false, error: null };

  if (space.owner_id === userId) {
    return { space, canRead: true, canEdit: true, error: null };
  }

  const { data: accessRow, error: accessErr } = await supabaseAdmin
    .from("user_build_space_access")
    .select("can_edit")
    .eq("space_id", spaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (accessErr) return { space, canRead: false, canEdit: false, error: accessErr };

  const hasSharedAccess = Boolean(accessRow);
  const canRead = space.is_public || hasSharedAccess;
  const canEdit = Boolean(accessRow?.can_edit);
  return { space, canRead, canEdit, error: null };
}

function normalizeRuntimeKey(value: unknown) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key) return "";
  const normalized = key.replace(/\s+/g, "_").slice(0, 128);
  if (!/^[a-zA-Z0-9._:-]+$/.test(normalized)) return "";
  return normalized;
}

function toRuntimeJson(value: unknown) {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string" || text.length > 24_000) {
      return { ok: false, value: null as unknown };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, value: null as unknown };
  }
}

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const spaceId = String(url.searchParams.get("spaceId") || "").trim();
    const key = normalizeRuntimeKey(url.searchParams.get("key"));
    const prefix = normalizeRuntimeKey(url.searchParams.get("prefix"));
    const limitRaw = Number(url.searchParams.get("limit") || "100");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.round(limitRaw))) : 100;

    if (!spaceId) {
      return NextResponse.json({ error: "spaceId required" }, { status: 400 });
    }

    const access = await getSpaceAccess(spaceId, user.id);
    if (access.error) {
      return NextResponse.json(mapError(access.error, "access check failed"), { status: 500 });
    }
    if (!access.space || !access.canRead) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    if (key) {
      const { data, error } = await supabaseAdmin
        .from("user_build_runtime_kv")
        .select("key, value, updated_at")
        .eq("space_id", spaceId)
        .eq("key", key)
        .maybeSingle();
      if (error) {
        return NextResponse.json(mapError(error, "runtime read failed"), { status: 500 });
      }
      return NextResponse.json({ item: data || null });
    }

    let query = supabaseAdmin
      .from("user_build_runtime_kv")
      .select("key, value, updated_at")
      .eq("space_id", spaceId)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (prefix) {
      query = query.ilike("key", `${prefix}%`);
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json(mapError(error, "runtime list failed"), { status: 500 });
    }
    return NextResponse.json({ items: data || [] });
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
    const key = normalizeRuntimeKey(body?.key);
    const parsedValue = toRuntimeJson(body?.value);

    if (!spaceId || !key) {
      return NextResponse.json({ error: "spaceId and key required" }, { status: 400 });
    }
    if (!parsedValue.ok) {
      return NextResponse.json({ error: "invalid value (must be JSON <= 24KB)" }, { status: 400 });
    }

    const access = await getSpaceAccess(spaceId, user.id);
    if (access.error) {
      return NextResponse.json(mapError(access.error, "access check failed"), { status: 500 });
    }
    if (!access.space || !access.canEdit) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { count, error: countErr } = await supabaseAdmin
      .from("user_build_runtime_kv")
      .select("id", { count: "exact", head: true })
      .eq("space_id", spaceId);
    if (countErr) {
      return NextResponse.json(mapError(countErr, "runtime write failed"), { status: 500 });
    }
    if (Number(count || 0) >= 500) {
      const { data: existsRow } = await supabaseAdmin
        .from("user_build_runtime_kv")
        .select("id")
        .eq("space_id", spaceId)
        .eq("key", key)
        .maybeSingle();
      if (!existsRow?.id) {
        return NextResponse.json({ error: "runtime kv quota exceeded (500 keys)" }, { status: 429 });
      }
    }

    const { error } = await supabaseAdmin.from("user_build_runtime_kv").upsert(
      {
        space_id: spaceId,
        key,
        value: parsedValue.value,
        updated_by: user.id,
      },
      { onConflict: "space_id,key" }
    );

    if (error) {
      return NextResponse.json(mapError(error, "runtime write failed"), { status: 500 });
    }

    return NextResponse.json({ ok: true, key });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim() : "";
    const key = normalizeRuntimeKey(body?.key);

    if (!spaceId || !key) {
      return NextResponse.json({ error: "spaceId and key required" }, { status: 400 });
    }

    const access = await getSpaceAccess(spaceId, user.id);
    if (access.error) {
      return NextResponse.json(mapError(access.error, "access check failed"), { status: 500 });
    }
    if (!access.space || !access.canEdit) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { error } = await supabaseAdmin
      .from("user_build_runtime_kv")
      .delete()
      .eq("space_id", spaceId)
      .eq("key", key);
    if (error) {
      return NextResponse.json(mapError(error, "runtime delete failed"), { status: 500 });
    }
    return NextResponse.json({ ok: true, key });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
