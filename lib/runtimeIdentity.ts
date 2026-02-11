import { createHash, randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export function hashSecret(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

function normalizeUsername(input: string) {
  return input.trim().toLowerCase();
}

function isValidUsername(input: string) {
  return /^[a-z0-9._-]{3,24}$/.test(input);
}

function buildCandidateBase(input: string) {
  const normalized = normalizeUsername(input).replace(/[^a-z0-9._-]/g, "");
  if (normalized.length >= 3) return normalized.slice(0, 24);
  return `user_${randomBytes(2).toString("hex")}`;
}

async function findAvailableUsername(base: string) {
  const { data: rows } = await supabaseAdmin
    .from("profileskozmos")
    .select("username")
    .ilike("username", `${base}%`)
    .limit(200);

  const used = new Set((rows || []).map((r) => String(r.username).toLowerCase()));
  if (!used.has(base)) return base;

  for (let i = 2; i < 5000; i += 1) {
    const candidate = `${base}_${i}`.slice(0, 24);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }

  return `${base}_${randomBytes(2).toString("hex")}`.slice(0, 24);
}

export async function createRuntimeIdentity(options: {
  requestedUsername?: string;
  label?: string;
}) {
  const requested = options.requestedUsername ?? "user";
  const label = (options.label || "runtime").slice(0, 60);

  const rawBase = buildCandidateBase(requested);
  const base = isValidUsername(rawBase) ? rawBase : "user";
  const username = await findAvailableUsername(base);

  const placeholderEmail = `runtime_${randomBytes(12).toString("hex")}@kozmos.local`;
  const placeholderPassword = `${randomBytes(24).toString("hex")}Aa1!`;

  const { data: authData, error: authErr } =
    await supabaseAdmin.auth.admin.createUser({
      email: placeholderEmail,
      password: placeholderPassword,
      email_confirm: true,
      user_metadata: {
        runtime: true,
        username,
      },
    });

  const userId = authData.user?.id;
  if (authErr || !userId) {
    throw new Error("auth user create failed");
  }

  const { error: profileErr } = await supabaseAdmin.from("profileskozmos").insert({
    id: userId,
    username,
  });

  if (profileErr) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new Error("profile create failed");
  }

  const runtimeToken = `kzrt_${randomBytes(24).toString("hex")}`;
  const tokenHash = hashSecret(runtimeToken);

  const { error: tokenErr } = await supabaseAdmin.from("runtime_user_tokens").insert({
    user_id: userId,
    token_hash: tokenHash,
    label,
    is_active: true,
    last_used_at: new Date().toISOString(),
  });

  if (tokenErr) {
    await supabaseAdmin.from("profileskozmos").delete().eq("id", userId);
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new Error("token create failed");
  }

  await supabaseAdmin.from("runtime_presence").upsert({
    user_id: userId,
    username,
    last_seen_at: new Date().toISOString(),
  });

  return {
    user: { id: userId, username },
    token: runtimeToken,
  };
}

