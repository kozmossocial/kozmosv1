import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveRuntimeToken } from "@/app/api/runtime/_tokenAuth";

export type RuntimeActor = {
  userId: string;
  username: string;
  tokenHash: string;
};

type CapabilityCheckResult =
  | { ok: true; actor: RuntimeActor }
  | { ok: false; status: number; error: string };

function getAxySuperAllowlist() {
  const raw = process.env.AXY_SUPER_ALLOWED_USER_IDS || "";
  return new Set(
    raw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
  );
}

function normalizeUsernameCandidate(input: unknown) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return "";
  const normalized = raw
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 24);
  return normalized.length >= 3 ? normalized : "";
}

function buildProfileUsernameCandidates(userId: string, values: unknown[]) {
  const seen = new Set<string>();
  const out: string[] = [];

  values.forEach((value) => {
    const normalized = normalizeUsernameCandidate(value);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  });

  const userFallback = `user_${userId.replace(/-/g, "").slice(0, 8)}`;
  const normalizedFallback = normalizeUsernameCandidate(userFallback);
  if (normalizedFallback && !seen.has(normalizedFallback.toLowerCase())) {
    out.push(normalizedFallback);
  }

  return out;
}

async function ensureRuntimeProfileUsername(userId: string) {
  const { data: profile } = await supabaseAdmin
    .from("profileskozmos")
    .select("id, username")
    .eq("id", userId)
    .maybeSingle();

  const existingUsername = normalizeUsernameCandidate(profile?.username);
  if (profile?.id && existingUsername) {
    return existingUsername;
  }

  const { data: presence } = await supabaseAdmin
    .from("runtime_presence")
    .select("username")
    .eq("user_id", userId)
    .maybeSingle();

  const authUserRes = await supabaseAdmin.auth.admin.getUserById(userId);
  const authUser = authUserRes.data?.user;
  const emailLocal =
    typeof authUser?.email === "string" ? authUser.email.split("@")[0] : "";
  const metadataUsername =
    authUser?.user_metadata && typeof authUser.user_metadata === "object"
      ? (authUser.user_metadata as { username?: unknown }).username
      : "";

  const candidates = buildProfileUsernameCandidates(userId, [
    profile?.username,
    presence?.username,
    metadataUsername,
    emailLocal,
  ]);

  if (profile?.id) {
    for (const candidate of candidates) {
      const { data: updated, error: updateErr } = await supabaseAdmin
        .from("profileskozmos")
        .update({ username: candidate })
        .eq("id", userId)
        .select("username")
        .maybeSingle();

      if (!updateErr) {
        const updatedUsername = normalizeUsernameCandidate(updated?.username);
        if (updatedUsername) return updatedUsername;
      } else if (updateErr.code !== "23505") {
        break;
      }
    }
  } else {
    for (const candidate of candidates) {
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from("profileskozmos")
        .insert({ id: userId, username: candidate })
        .select("username")
        .maybeSingle();

      if (!insertErr) {
        const insertedUsername = normalizeUsernameCandidate(inserted?.username);
        if (insertedUsername) return insertedUsername;
      } else if (insertErr.code !== "23505") {
        break;
      }
    }
  }

  const { data: reloaded } = await supabaseAdmin
    .from("profileskozmos")
    .select("username")
    .eq("id", userId)
    .maybeSingle();

  return normalizeUsernameCandidate(reloaded?.username);
}

export async function hasRuntimeCapability(userId: string, capability: string) {
  const { data, error } = await supabaseAdmin
    .from("runtime_capabilities")
    .select("id")
    .eq("user_id", userId)
    .eq("capability", capability)
    .eq("enabled", true)
    .limit(1)
    .maybeSingle();

  if (error) return false;
  return Boolean(data?.id);
}

export async function resolveRuntimeActor(req: Request): Promise<CapabilityCheckResult> {
  const resolved = await resolveRuntimeToken(req);
  if (!resolved.userId || !resolved.tokenHash) {
    return {
      ok: false,
      status: resolved.status || 401,
      error: resolved.error || "invalid token",
    };
  }

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from("profileskozmos")
    .select("username")
    .eq("id", resolved.userId)
    .maybeSingle();

  let username = normalizeUsernameCandidate(profile?.username);
  if (!profileErr && !username) {
    username = await ensureRuntimeProfileUsername(resolved.userId);
  }

  if (profileErr || !username) {
    return { ok: false, status: 404, error: "profile not found" };
  }

  return {
    ok: true,
    actor: {
      userId: resolved.userId,
      username,
      tokenHash: resolved.tokenHash,
    },
  };
}

export async function requireRuntimeCapability(
  req: Request,
  capability: string
): Promise<CapabilityCheckResult> {
  const actorResult = await resolveRuntimeActor(req);
  if (!actorResult.ok) return actorResult;

  const actor = actorResult.actor;
  if (capability === "axy.super") {
    const allowlist = getAxySuperAllowlist();
    if (!allowlist.has(actor.userId)) {
      return { ok: false, status: 403, error: "forbidden" };
    }
  }

  const allowed = await hasRuntimeCapability(actor.userId, capability);
  if (!allowed) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  return { ok: true, actor };
}
