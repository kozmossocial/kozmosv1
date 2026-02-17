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

  const username = typeof profile?.username === "string" ? profile.username.trim() : "";
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
  const allowed = await hasRuntimeCapability(actor.userId, capability);
  if (!allowed) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  return { ok: true, actor };
}

