import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export type BuildRuntimeSpaceAccess = {
  space: {
    id: string;
    owner_id: string;
    is_public: boolean;
    title: string;
  } | null;
  canRead: boolean;
  canEdit: boolean;
  error: { code?: string; message?: string } | null;
};

type RateEntry = { windowStart: number; count: number };

const rateMap = (
  globalThis as {
    __kozmosBuildStarterRateMap?: Map<string, RateEntry>;
  }
).__kozmosBuildStarterRateMap || new Map<string, RateEntry>();

(
  globalThis as {
    __kozmosBuildStarterRateMap?: Map<string, RateEntry>;
  }
).__kozmosBuildStarterRateMap = rateMap;

export function extractBearerToken(req: Request) {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export async function authenticateBuildRuntimeUser(req: Request) {
  const token = extractBearerToken(req);
  if (!token) return null;
  const authClient = createClient(supabaseUrl, supabaseAnonKey);
  const {
    data: { user },
  } = await authClient.auth.getUser(token);
  return user ?? null;
}

export async function authenticateBuildRuntimeUserOptional(req: Request) {
  return authenticateBuildRuntimeUser(req);
}

export function mapBuildRuntimeError(
  error: { code?: string; message?: string } | null,
  fallback: string
) {
  if (!error) return { error: fallback };
  const detail = [error.code, error.message].filter(Boolean).join(": ");
  return { error: detail || fallback };
}

export async function getBuildRuntimeSpaceAccess(
  spaceId: string,
  userId: string
): Promise<BuildRuntimeSpaceAccess> {
  const { data: space, error: spaceErr } = await supabaseAdmin
    .from("user_build_spaces")
    .select("id, owner_id, is_public, title")
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

export async function getBuildRuntimePublicSpace(spaceId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_build_spaces")
    .select("id, owner_id, is_public, title")
    .eq("id", spaceId)
    .maybeSingle();
  if (error) return { space: null, error };
  return { space: data || null, error: null };
}

export async function getBuildRuntimeRequestContext(req: Request, spaceId: string) {
  const user = await authenticateBuildRuntimeUserOptional(req);
  if (user?.id) {
    const access = await getBuildRuntimeSpaceAccess(spaceId, user.id);
    return {
      user,
      access,
      rateIdentity: user.id,
    };
  }
  const spaceRes = await getBuildRuntimePublicSpace(spaceId);
  const access: BuildRuntimeSpaceAccess = {
    space: spaceRes.space,
    canRead: Boolean(spaceRes.space?.is_public),
    canEdit: false,
    error: spaceRes.error,
  };
  return {
    user: null,
    access,
    rateIdentity: getAnonymousRateIdentity(req),
  };
}

export function getAnonymousRateIdentity(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for") || req.headers.get("X-Forwarded-For");
  const ip = String(forwarded || "")
    .split(",")[0]
    .trim()
    .slice(0, 80);
  return ip ? `anon:${ip}` : "anon:unknown";
}

export async function getStarterMode(spaceId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_build_backend_modes")
    .select(
      "space_id, enabled, posts_quota, comments_quota, likes_quota, dm_threads_quota, dm_messages_quota, starter_users_quota, friend_requests_quota, friendships_quota, updated_at"
    )
    .eq("space_id", spaceId)
    .maybeSingle();
  if (error) return { mode: null, error };
  return {
    mode:
      data || {
        space_id: spaceId,
        enabled: false,
        posts_quota: 2000,
        comments_quota: 10000,
        likes_quota: 40000,
        dm_threads_quota: 500,
        dm_messages_quota: 60000,
        starter_users_quota: 3000,
        friend_requests_quota: 12000,
        friendships_quota: 12000,
      },
    error: null,
  };
}

export function passStarterRateLimit(
  userId: string,
  spaceId: string,
  scope: string,
  maxPerWindow = 90,
  windowMs = 60_000
) {
  const now = Date.now();
  const key = `${String(userId)}:${String(spaceId)}:${String(scope)}`;
  const current = rateMap.get(key);
  if (!current || now - current.windowStart >= windowMs) {
    rateMap.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (current.count >= maxPerWindow) return false;
  current.count += 1;
  rateMap.set(key, current);
  return true;
}

export function clampLimit(input: unknown, fallback = 50, min = 1, max = 200) {
  const value = Number(input);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function sanitizeJsonValue(input: unknown) {
  if (input === null || input === undefined) return {};
  if (typeof input !== "object") return {};
  try {
    const text = JSON.stringify(input);
    if (text.length > 16000) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}
