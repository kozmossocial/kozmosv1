import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

type SpaceRow = {
  id: string;
  owner_id: string;
  title: string;
  is_public: boolean;
  language_pref: string;
  description: string;
  updated_at: string;
};

type SpaceResponseRow = SpaceRow & {
  can_edit: boolean;
  owner_username?: string;
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

function normalizeSpaces(rows: SpaceRow[]) {
  const byId = new Map<string, SpaceRow>();
  rows.forEach((row) => byId.set(row.id, row));
  return Array.from(byId.values()).sort((a, b) =>
    (b.updated_at || "").localeCompare(a.updated_at || "")
  );
}

async function listAccessibleSpaces(userId: string) {
  const select =
    "id, owner_id, title, is_public, language_pref, description, updated_at";

  const { data: own, error: ownErr } = await supabaseAdmin
    .from("user_build_spaces")
    .select(select)
    .eq("owner_id", userId)
    .order("updated_at", { ascending: false });
  if (ownErr) return { spaces: [] as SpaceRow[], error: ownErr };

  const { data: publicRows, error: publicErr } = await supabaseAdmin
    .from("user_build_spaces")
    .select(select)
    .eq("is_public", true)
    .neq("owner_id", userId)
    .order("updated_at", { ascending: false });
  if (publicErr) return { spaces: [] as SpaceRow[], error: publicErr };

  const { data: sharedAccess, error: sharedErr } = await supabaseAdmin
    .from("user_build_space_access")
    .select("space_id, can_edit")
    .eq("user_id", userId);
  if (sharedErr) return { spaces: [] as SpaceRow[], error: sharedErr };

  const sharedEditMap = new Map<string, boolean>();
  (sharedAccess || []).forEach((row) => {
    if (!row.space_id) return;
    sharedEditMap.set(row.space_id, row.can_edit === true);
  });

  const sharedIds = Array.from(
    new Set((sharedAccess || []).map((row) => row.space_id).filter(Boolean))
  );

  let sharedSpaces: SpaceRow[] = [];
  if (sharedIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("user_build_spaces")
      .select(select)
      .in("id", sharedIds);
    if (error) return { spaces: [] as SpaceRow[], error };
    sharedSpaces = (data || []) as SpaceRow[];
  }

  const spaces = normalizeSpaces([
    ...((own || []) as SpaceRow[]),
    ...((publicRows || []) as SpaceRow[]),
    ...sharedSpaces,
  ]).map((space) => ({
    ...space,
    can_edit: space.owner_id === userId || sharedEditMap.get(space.id) === true,
  })) as SpaceResponseRow[];

  const ownerIds = Array.from(new Set(spaces.map((space) => space.owner_id).filter(Boolean)));
  let ownerNameMap = new Map<string, string>();
  if (ownerIds.length > 0) {
    const { data: owners, error: ownersErr } = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username")
      .in("id", ownerIds);
    if (ownersErr) return { spaces: [] as SpaceResponseRow[], error: ownersErr };
    ownerNameMap = new Map(
      (owners || []).map((row) => [String((row as { id: string }).id), String((row as { username?: string }).username || "user")])
    );
  }

  const withOwner = spaces.map((space) => ({
    ...space,
    owner_username: ownerNameMap.get(space.owner_id) || "user",
  }));

  return { spaces: withOwner, error: null };
}

async function assertOwner(spaceId: string, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_build_spaces")
    .select("id")
    .eq("id", spaceId)
    .eq("owner_id", userId)
    .maybeSingle();
  if (error) return { ok: false, error };
  return { ok: Boolean(data?.id), error: null };
}

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { spaces, error } = await listAccessibleSpaces(user.id);
    if (error) {
      return NextResponse.json(mapError(error, "load spaces failed"), {
        status: 500,
      });
    }

    return NextResponse.json({ spaces });
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
    const rawTitle = typeof body?.title === "string" ? body.title.trim() : "";
    const title = rawTitle || "subspace";
    const languagePref =
      typeof body?.languagePref === "string" && body.languagePref.trim()
        ? body.languagePref.trim()
        : "auto";
    const description =
      typeof body?.description === "string" ? body.description : "";

    const { data, error } = await supabaseAdmin
      .from("user_build_spaces")
      .insert({
        owner_id: user.id,
        title,
        language_pref: languagePref,
        description,
      })
      .select(
        "id, owner_id, title, is_public, language_pref, description, updated_at"
      )
      .single();

    if (error || !data) {
      return NextResponse.json(mapError(error, "create space failed"), {
        status: 500,
      });
    }

    return NextResponse.json({ space: { ...data, can_edit: true } });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId : "";
    if (!spaceId) {
      return NextResponse.json({ error: "spaceId required" }, { status: 400 });
    }

    const ownerCheck = await assertOwner(spaceId, user.id);
    if (ownerCheck.error) {
      return NextResponse.json(mapError(ownerCheck.error, "owner check failed"), {
        status: 500,
      });
    }
    if (!ownerCheck.ok) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const updates: Record<string, unknown> = {};
    if (typeof body?.title === "string") updates.title = body.title.trim() || "subspace";
    if (typeof body?.description === "string") updates.description = body.description;
    if (typeof body?.languagePref === "string") {
      updates.language_pref = body.languagePref.trim() || "auto";
    }
    if (typeof body?.isPublic === "boolean") updates.is_public = body.isPublic;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "no updates provided" }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from("user_build_spaces")
      .update(updates)
      .eq("id", spaceId)
      .select(
        "id, owner_id, title, is_public, language_pref, description, updated_at"
      )
      .single();

    if (error || !data) {
      return NextResponse.json(mapError(error, "update space failed"), {
        status: 500,
      });
    }

    return NextResponse.json({ space: { ...data, can_edit: true } });
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
    if (!spaceId) {
      return NextResponse.json({ error: "spaceId required" }, { status: 400 });
    }

    const ownerCheck = await assertOwner(spaceId, user.id);
    if (ownerCheck.error) {
      return NextResponse.json(mapError(ownerCheck.error, "owner check failed"), {
        status: 500,
      });
    }
    if (!ownerCheck.ok) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { error } = await supabaseAdmin
      .from("user_build_spaces")
      .delete()
      .eq("id", spaceId);

    if (error) {
      return NextResponse.json(mapError(error, "delete space failed"), {
        status: 500,
      });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
