import { createHash } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const RUNTIME_TOKEN_IDLE_MS = 30 * 60 * 1000; // 30 minutes

type RuntimeTokenRow = {
  user_id: string;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
};

export function extractBearerToken(req: Request) {
  const header =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function hashToken(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

function isExpired(row: RuntimeTokenRow) {
  const baseIso = row.last_used_at || row.created_at;
  const baseMs = Date.parse(baseIso);
  if (!Number.isFinite(baseMs)) return false;
  return Date.now() - baseMs > RUNTIME_TOKEN_IDLE_MS;
}

export async function resolveRuntimeToken(req: Request) {
  const token = extractBearerToken(req);
  if (!token) {
    return {
      ok: false as const,
      error: "missing token",
      status: 401,
      userId: null as string | null,
      tokenHash: null as string | null,
    };
  }

  const tokenHash = hashToken(token);
  const { data: runtimeToken, error: tokenErr } = await supabaseAdmin
    .from("runtime_user_tokens")
    .select("user_id, is_active, last_used_at, created_at")
    .eq("token_hash", tokenHash)
    .maybeSingle<RuntimeTokenRow>();

  if (tokenErr || !runtimeToken || !runtimeToken.is_active) {
    return {
      ok: false as const,
      error: "invalid token",
      status: 401,
      userId: null as string | null,
      tokenHash: null as string | null,
    };
  }

  if (isExpired(runtimeToken)) {
    await supabaseAdmin
      .from("runtime_user_tokens")
      .update({ is_active: false })
      .eq("token_hash", tokenHash);
    await supabaseAdmin.from("runtime_presence").delete().eq("user_id", runtimeToken.user_id);

    return {
      ok: false as const,
      error: "token expired",
      status: 401,
      userId: null as string | null,
      tokenHash: null as string | null,
    };
  }

  return {
    ok: true as const,
    error: null as string | null,
    status: 200,
    userId: runtimeToken.user_id,
    tokenHash,
  };
}

