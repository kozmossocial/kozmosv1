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

  if (spaceErr) {
    return { space: null, canRead: false, canEdit: false, error: spaceErr };
  }
  if (!space) {
    return { space: null, canRead: false, canEdit: false, error: null };
  }

  if (space.owner_id === userId) {
    return { space, canRead: true, canEdit: true, error: null };
  }

  const { data: accessRow, error: accessErr } = await supabaseAdmin
    .from("user_build_space_access")
    .select("can_edit")
    .eq("space_id", spaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (accessErr) {
    return { space, canRead: false, canEdit: false, error: accessErr };
  }

  const hasSharedAccess = Boolean(accessRow);
  const canRead = space.is_public || hasSharedAccess;
  const canEdit = Boolean(accessRow?.can_edit);

  return { space, canRead, canEdit, error: null };
}

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const spaceId = url.searchParams.get("spaceId") || "";
    if (!spaceId) {
      return NextResponse.json({ error: "spaceId required" }, { status: 400 });
    }

    const access = await getSpaceAccess(spaceId, user.id);
    if (access.error) {
      return NextResponse.json(mapError(access.error, "access check failed"), {
        status: 500,
      });
    }
    if (!access.space || !access.canRead) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { data, error } = await supabaseAdmin
      .from("user_build_files")
      .select("id, path, content, language, updated_at")
      .eq("space_id", spaceId)
      .order("updated_at", { ascending: false });

    if (error) {
      return NextResponse.json(mapError(error, "load files failed"), {
        status: 500,
      });
    }

    return NextResponse.json({
      files: data || [],
      canEdit: access.canEdit,
      isOwner: access.space.owner_id === user.id,
    });
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

    const body = await req.json().catch(() => ({}));
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId : "";
    const rawPath = typeof body?.path === "string" ? body.path : "";
    const path = rawPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    const language =
      typeof body?.language === "string" && body.language.trim()
        ? body.language.trim()
        : "text";

    if (!spaceId || !path) {
      return NextResponse.json({ error: "spaceId and path required" }, { status: 400 });
    }

    const access = await getSpaceAccess(spaceId, user.id);
    if (access.error) {
      return NextResponse.json(mapError(access.error, "access check failed"), {
        status: 500,
      });
    }
    if (!access.space || !access.canEdit) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { data: existing, error: findErr } = await supabaseAdmin
      .from("user_build_files")
      .select("id")
      .eq("space_id", spaceId)
      .eq("path", path)
      .maybeSingle();

    if (findErr) {
      return NextResponse.json(mapError(findErr, "create file failed"), {
        status: 500,
      });
    }

    if (existing?.id) {
      return NextResponse.json({ ok: true, path, existed: true });
    }

    const { error } = await supabaseAdmin.from("user_build_files").insert({
      space_id: spaceId,
      path,
      content: "",
      language,
      updated_by: user.id,
    });

    if (error) {
      return NextResponse.json(mapError(error, "create file failed"), {
        status: 500,
      });
    }

    return NextResponse.json({ ok: true, path, existed: false });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId : "";
    const rawPath = typeof body?.path === "string" ? body.path : "";
    const path = rawPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    const content = typeof body?.content === "string" ? body.content : "";
    const language =
      typeof body?.language === "string" && body.language.trim()
        ? body.language.trim()
        : "text";

    if (!spaceId || !path) {
      return NextResponse.json({ error: "spaceId and path required" }, { status: 400 });
    }

    const access = await getSpaceAccess(spaceId, user.id);
    if (access.error) {
      return NextResponse.json(mapError(access.error, "access check failed"), {
        status: 500,
      });
    }
    if (!access.space || !access.canEdit) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { error } = await supabaseAdmin.from("user_build_files").upsert(
      {
        space_id: spaceId,
        path,
        content,
        language,
        updated_by: user.id,
      },
      { onConflict: "space_id,path" }
    );

    if (error) {
      return NextResponse.json(mapError(error, "save file failed"), {
        status: 500,
      });
    }

    return NextResponse.json({ ok: true });
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

    const body = await req.json().catch(() => ({}));
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId : "";
    const rawPath = typeof body?.path === "string" ? body.path : "";
    const path = rawPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");

    if (!spaceId || !path) {
      return NextResponse.json({ error: "spaceId and path required" }, { status: 400 });
    }

    const access = await getSpaceAccess(spaceId, user.id);
    if (access.error) {
      return NextResponse.json(mapError(access.error, "access check failed"), {
        status: 500,
      });
    }
    if (!access.space || !access.canEdit) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { error } = await supabaseAdmin
      .from("user_build_files")
      .delete()
      .eq("space_id", spaceId)
      .eq("path", path);

    if (error) {
      return NextResponse.json(mapError(error, "delete file failed"), {
        status: 500,
      });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
