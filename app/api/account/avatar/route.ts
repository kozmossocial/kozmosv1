import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const AVATAR_BUCKET = "profile-pics";

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

function sanitizeUsername(input: string | null | undefined) {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "");
  return cleaned.slice(0, 32);
}

function buildFallbackUsername(user: { id: string; email?: string | null; user_metadata?: { username?: unknown } | null; }) {
  const metaUsername =
    typeof user.user_metadata?.username === "string"
      ? sanitizeUsername(user.user_metadata.username)
      : "";
  if (metaUsername) return metaUsername;

  const emailLocal = sanitizeUsername((user.email ?? "").split("@")[0] ?? "");
  if (emailLocal) return emailLocal;

  return `user_${user.id.slice(0, 8)}`;
}

async function ensureAvatarBucket() {
  const { data, error } = await supabaseAdmin.storage.getBucket(AVATAR_BUCKET);
  if (!error && data) return true;

  const { error: createErr } = await supabaseAdmin.storage.createBucket(
    AVATAR_BUCKET,
    {
      public: true,
      fileSizeLimit: 6_000_000,
      allowedMimeTypes: [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/avif",
      ],
    }
  );

  if (!createErr) return true;
  if (/already exists|duplicate/i.test(createErr.message)) return true;
  return false;
}

function getAvatarObjectPath(url: string | null) {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${AVATAR_BUCKET}/`;
  const markerIndex = url.indexOf(marker);
  if (markerIndex < 0) return null;
  const path = url
    .slice(markerIndex + marker.length)
    .split("?")[0]
    .trim();
  return path ? decodeURIComponent(path) : null;
}

function inferUploadExtension(fileName: string, contentType: string) {
  const fromName = fileName.split(".").pop()?.toLowerCase() ?? "";
  const cleanName = fromName.replace(/[^a-z0-9]/g, "");
  if (cleanName) return cleanName;

  const fromMime = contentType.split("/")[1]?.toLowerCase() ?? "";
  const cleanMime = fromMime.replace(/[^a-z0-9]/g, "");
  return cleanMime || "bin";
}

async function ensureProfileRow(user: {
  id: string;
  email?: string | null;
  user_metadata?: { username?: unknown } | null;
}) {
  const { data: existing, error: selectErr } = await supabaseAdmin
    .from("profileskozmos")
    .select("id, username, avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  if (selectErr && !/avatar_url/i.test(selectErr.message)) {
    return {
      profile: null,
      error: `profile load failed: ${selectErr.message}` as string | null,
    };
  }

  if (selectErr && /avatar_url/i.test(selectErr.message)) {
    const { data: fallbackProfile, error: fallbackErr } = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username")
      .eq("id", user.id)
      .maybeSingle();
    if (fallbackErr) {
      return {
        profile: null,
        error: `profile load failed: ${fallbackErr.message}` as string | null,
      };
    }
    if (fallbackProfile) {
      return {
        profile: { ...fallbackProfile, avatar_url: null },
        error: null,
      };
    }
  }

  if (existing) {
    return { profile: existing, error: null };
  }

  const base = buildFallbackUsername(user);
  const fallbackOptions = [
    base,
    `${base}_${user.id.slice(0, 4)}`,
    `user_${user.id.slice(0, 8)}`,
  ];

  let insertError: string | null = null;
  for (const candidate of fallbackOptions) {
    const { error } = await supabaseAdmin.from("profileskozmos").insert({
      id: user.id,
      username: candidate,
    });
    if (!error) {
      const { data: inserted } = await supabaseAdmin
        .from("profileskozmos")
        .select("id, username, avatar_url")
        .eq("id", user.id)
        .maybeSingle();
      return { profile: inserted ?? null, error: null };
    }
    insertError = error.message;
  }

  return {
    profile: null,
    error: insertError ?? "profile create failed",
  };
}

export async function POST(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const bucketReady = await ensureAvatarBucket();
    if (!bucketReady) {
      return NextResponse.json({ error: "avatar bucket unavailable" }, { status: 500 });
    }

    const formData = await req.formData();
    const filePart = formData.get("file");
    const contentTypePart = formData.get("contentType");

    if (!(filePart instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const contentType =
      typeof contentTypePart === "string" && contentTypePart.startsWith("image/")
        ? contentTypePart
        : filePart.type;

    if (!contentType.startsWith("image/")) {
      return NextResponse.json({ error: "image file required" }, { status: 400 });
    }

    const ensured = await ensureProfileRow(user);
    if (!ensured.profile) {
      return NextResponse.json(
        { error: ensured.error ?? "profile unavailable" },
        { status: 500 }
      );
    }

    const oldPath = getAvatarObjectPath(ensured.profile.avatar_url ?? null);
    const ext = inferUploadExtension(filePart.name || "avatar", contentType);
    const objectPath = `${user.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

    let uploadError: string | null = null;
    {
      const { error } = await supabaseAdmin.storage
        .from(AVATAR_BUCKET)
        .upload(objectPath, filePart, { upsert: false, contentType });
      if (error) {
        uploadError = error.message;
      }
    }

    if (uploadError && /bucket.*not found/i.test(uploadError)) {
      const retryReady = await ensureAvatarBucket();
      if (retryReady) {
        const { error } = await supabaseAdmin.storage
          .from(AVATAR_BUCKET)
          .upload(objectPath, filePart, { upsert: false, contentType });
        uploadError = error?.message ?? null;
      }
    }

    if (uploadError) {
      return NextResponse.json({ error: uploadError }, { status: 500 });
    }

    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from(AVATAR_BUCKET).getPublicUrl(objectPath);

    const { error: updateErr } = await supabaseAdmin
      .from("profileskozmos")
      .update({ avatar_url: publicUrl })
      .eq("id", user.id);

    if (updateErr) {
      await supabaseAdmin.storage.from(AVATAR_BUCKET).remove([objectPath]);
      if (/avatar_url/i.test(updateErr.message)) {
        return NextResponse.json(
          {
            error:
              "database missing avatar_url column; run migration 20260212_profiles_avatar.sql",
          },
          { status: 500 }
        );
      }
      return NextResponse.json(
        { error: `profile update failed: ${updateErr.message}` },
        { status: 500 }
      );
    }

    if (oldPath && oldPath !== objectPath) {
      await supabaseAdmin.storage.from(AVATAR_BUCKET).remove([oldPath]);
    }

    return NextResponse.json({ ok: true, avatarUrl: publicUrl });
  } catch {
    return NextResponse.json({ error: "avatar upload failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profileskozmos")
      .select("avatar_url")
      .eq("id", user.id)
      .maybeSingle();

    if (profileErr && !/avatar_url/i.test(profileErr.message)) {
      return NextResponse.json(
        { error: `profile load failed: ${profileErr.message}` },
        { status: 500 }
      );
    }

    const oldPath = getAvatarObjectPath(profile?.avatar_url ?? null);
    const { error: updateErr } = await supabaseAdmin
      .from("profileskozmos")
      .update({ avatar_url: null })
      .eq("id", user.id);

    if (updateErr) {
      if (/avatar_url/i.test(updateErr.message)) {
        return NextResponse.json(
          {
            error:
              "database missing avatar_url column; run migration 20260212_profiles_avatar.sql",
          },
          { status: 500 }
        );
      }
      return NextResponse.json(
        { error: `profile update failed: ${updateErr.message}` },
        { status: 500 }
      );
    }

    if (oldPath) {
      await supabaseAdmin.storage.from(AVATAR_BUCKET).remove([oldPath]);
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "avatar remove failed" }, { status: 500 });
  }
}
