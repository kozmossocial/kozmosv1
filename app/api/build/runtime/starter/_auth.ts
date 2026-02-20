import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type StarterUserRow = {
  id: string;
  space_id: string;
  username: string;
  username_key: string;
  password_salt: string;
  password_hash: string;
  display_name: string;
  profile: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type StarterSessionRow = {
  id: string;
  space_id: string;
  starter_user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
};

export type StarterActor = {
  user: StarterUserRow;
  session: StarterSessionRow;
  token: string;
};

const STARTER_PASSWORD_BYTES = 64;
const STARTER_TOKEN_BYTES = 32;
const DEFAULT_SESSION_DAYS = 30;
const DEFAULT_INACTIVITY_MINUTES = 30;

export function normalizeStarterUsername(value: unknown) {
  const username = typeof value === "string" ? value.trim() : "";
  const normalized = username
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .slice(0, 32);
  if (normalized.length < 3) return { username: "", usernameKey: "" };
  return { username: username.slice(0, 32), usernameKey: normalized };
}

export function extractStarterToken(req: Request, fallback?: unknown) {
  const headerToken =
    req.headers.get("x-kozmos-starter-token") ||
    req.headers.get("x-starter-token") ||
    req.headers.get("X-Kozmos-Starter-Token") ||
    req.headers.get("X-Starter-Token");
  const token = String(headerToken || fallback || "").trim();
  return token || "";
}

function hashStarterToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashStarterPassword(password: string, salt: string) {
  return scryptSync(password, salt, STARTER_PASSWORD_BYTES).toString("hex");
}

function verifyStarterPassword(password: string, salt: string, storedHash: string) {
  const computed = hashStarterPassword(password, salt);
  const left = Buffer.from(computed, "hex");
  const right = Buffer.from(String(storedHash || ""), "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function sessionDurationDays() {
  const raw = Number(process.env.KOZMOS_STARTER_SESSION_DAYS || DEFAULT_SESSION_DAYS);
  if (!Number.isFinite(raw)) return DEFAULT_SESSION_DAYS;
  return Math.max(1, Math.min(120, Math.round(raw)));
}

function sessionExpiryIso() {
  const ms = sessionDurationDays() * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ms).toISOString();
}

function sessionInactivityMinutes() {
  const raw = Number(process.env.KOZMOS_STARTER_INACTIVITY_MINUTES || DEFAULT_INACTIVITY_MINUTES);
  if (!Number.isFinite(raw)) return DEFAULT_INACTIVITY_MINUTES;
  return Math.max(5, Math.min(24 * 60, Math.round(raw)));
}

function isSessionInactive(lastSeenAt: string | null | undefined, nowMs: number) {
  const lastSeenMs = Date.parse(String(lastSeenAt || ""));
  if (!Number.isFinite(lastSeenMs)) return true;
  const inactivityMs = sessionInactivityMinutes() * 60 * 1000;
  return nowMs - lastSeenMs > inactivityMs;
}

export async function createStarterUser(params: {
  spaceId: string;
  username: string;
  password: string;
  displayName?: string;
  profile?: Record<string, unknown>;
}) {
  const { spaceId, username, password } = params;
  const normalized = normalizeStarterUsername(username);
  if (!normalized.usernameKey) {
    return { error: "invalid username", user: null as StarterUserRow | null };
  }
  const passwordValue = String(password || "");
  if (passwordValue.length < 6 || passwordValue.length > 200) {
    return { error: "password must be 6-200 chars", user: null as StarterUserRow | null };
  }

  const salt = randomBytes(16).toString("hex");
  const hash = hashStarterPassword(passwordValue, salt);
  const displayName = String(params.displayName || "").trim().slice(0, 64);
  const profile = params.profile && typeof params.profile === "object" ? params.profile : {};

  const { data, error } = await supabaseAdmin
    .from("user_build_starter_users")
    .insert({
      space_id: spaceId,
      username: normalized.username,
      username_key: normalized.usernameKey,
      password_salt: salt,
      password_hash: hash,
      display_name: displayName,
      profile,
    })
    .select(
      "id, space_id, username, username_key, password_salt, password_hash, display_name, profile, created_at, updated_at"
    )
    .single();

  if (error || !data) {
    const detail = `${error?.code || ""}:${error?.message || ""}`.toLowerCase();
    if (detail.includes("duplicate") || detail.includes("unique")) {
      return { error: "username already exists", user: null as StarterUserRow | null };
    }
    return { error: "starter user create failed", user: null as StarterUserRow | null };
  }

  return { error: null, user: data as StarterUserRow };
}

export async function findStarterUserByUsername(spaceId: string, username: string) {
  const normalized = normalizeStarterUsername(username);
  if (!normalized.usernameKey) {
    return { error: "invalid username", user: null as StarterUserRow | null };
  }

  const { data, error } = await supabaseAdmin
    .from("user_build_starter_users")
    .select(
      "id, space_id, username, username_key, password_salt, password_hash, display_name, profile, created_at, updated_at"
    )
    .eq("space_id", spaceId)
    .eq("username_key", normalized.usernameKey)
    .maybeSingle();

  if (error) return { error: "starter user lookup failed", user: null as StarterUserRow | null };
  return { error: null, user: (data as StarterUserRow | null) || null };
}

export async function verifyStarterLogin(spaceId: string, username: string, password: string) {
  const lookup = await findStarterUserByUsername(spaceId, username);
  if (lookup.error || !lookup.user) {
    return { error: "invalid username or password", user: null as StarterUserRow | null };
  }
  const ok = verifyStarterPassword(password, lookup.user.password_salt, lookup.user.password_hash);
  if (!ok) return { error: "invalid username or password", user: null as StarterUserRow | null };
  return { error: null, user: lookup.user };
}

export async function createStarterSession(spaceId: string, starterUserId: string) {
  const rawToken = randomBytes(STARTER_TOKEN_BYTES).toString("base64url");
  const tokenHash = hashStarterToken(rawToken);
  const expiresAt = sessionExpiryIso();

  const { data, error } = await supabaseAdmin
    .from("user_build_starter_sessions")
    .insert({
      space_id: spaceId,
      starter_user_id: starterUserId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    })
    .select("id, space_id, starter_user_id, token_hash, expires_at, created_at, updated_at, last_seen_at")
    .single();

  if (error || !data) {
    return { error: "starter session create failed", session: null as StarterSessionRow | null, token: "" };
  }
  return { error: null, session: data as StarterSessionRow, token: rawToken };
}

export async function resolveStarterActor(spaceId: string, token: string) {
  const tokenValue = String(token || "").trim();
  if (!tokenValue) {
    return { error: "starter token required", actor: null as StarterActor | null };
  }
  const tokenHash = hashStarterToken(tokenValue);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const { data: session, error: sessionErr } = await supabaseAdmin
    .from("user_build_starter_sessions")
    .select("id, space_id, starter_user_id, token_hash, expires_at, created_at, updated_at, last_seen_at")
    .eq("space_id", spaceId)
    .eq("token_hash", tokenHash)
    .gt("expires_at", nowIso)
    .maybeSingle();
  if (sessionErr) return { error: "starter session lookup failed", actor: null as StarterActor | null };
  if (!session) return { error: "starter session invalid", actor: null as StarterActor | null };
  if (isSessionInactive((session as StarterSessionRow).last_seen_at, nowMs)) {
    await supabaseAdmin.from("user_build_starter_sessions").delete().eq("id", (session as StarterSessionRow).id);
    return { error: "starter session inactive", actor: null as StarterActor | null };
  }

  const { data: user, error: userErr } = await supabaseAdmin
    .from("user_build_starter_users")
    .select(
      "id, space_id, username, username_key, password_salt, password_hash, display_name, profile, created_at, updated_at"
    )
    .eq("space_id", spaceId)
    .eq("id", (session as StarterSessionRow).starter_user_id)
    .maybeSingle();
  if (userErr) return { error: "starter user lookup failed", actor: null as StarterActor | null };
  if (!user) return { error: "starter user missing", actor: null as StarterActor | null };

  await supabaseAdmin
    .from("user_build_starter_sessions")
    .update({ last_seen_at: nowIso })
    .eq("id", (session as StarterSessionRow).id);

  return {
    error: null,
    actor: {
      user: user as StarterUserRow,
      session: session as StarterSessionRow,
      token: tokenValue,
    },
  };
}

export async function revokeStarterSession(spaceId: string, token: string) {
  const tokenValue = String(token || "").trim();
  if (!tokenValue) return { error: "starter token required" };
  const tokenHash = hashStarterToken(tokenValue);
  const { error } = await supabaseAdmin
    .from("user_build_starter_sessions")
    .delete()
    .eq("space_id", spaceId)
    .eq("token_hash", tokenHash);
  if (error) return { error: "starter logout failed" };
  return { error: null };
}
