import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const proxyAllowlist = String(process.env.KOZMOS_BUILD_PROXY_ALLOWLIST || "")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

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

type RateEntry = { windowStart: number; count: number };

const rateMap = (globalThis as { __kozmosBuildProxyRateMap?: Map<string, RateEntry> })
  .__kozmosBuildProxyRateMap || new Map<string, RateEntry>();
(globalThis as { __kozmosBuildProxyRateMap?: Map<string, RateEntry> }).__kozmosBuildProxyRateMap =
  rateMap;

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
  if (space.owner_id === userId) return { space, canRead: true, canEdit: true, error: null };

  const { data: accessRow, error: accessErr } = await supabaseAdmin
    .from("user_build_space_access")
    .select("can_edit")
    .eq("space_id", spaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (accessErr) return { space, canRead: false, canEdit: false, error: accessErr };
  const hasSharedAccess = Boolean(accessRow);
  return {
    space,
    canRead: space.is_public || hasSharedAccess,
    canEdit: Boolean(accessRow?.can_edit),
    error: null,
  };
}

function isHostAllowed(hostname: string) {
  if (proxyAllowlist.length === 0) return false;
  const host = hostname.toLowerCase();
  return proxyAllowlist.some((rule) => {
    if (!rule) return false;
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1); // ".example.com"
      return host.endsWith(suffix);
    }
    return host === rule;
  });
}

function allowedMethod(value: unknown) {
  const method = String(value || "GET").trim().toUpperCase();
  const whitelist = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
  return whitelist.has(method) ? method : "GET";
}

function buildForwardHeaders(input: unknown) {
  const out = new Headers();
  const candidate = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const allow = new Set([
    "accept",
    "content-type",
    "authorization",
    "x-api-key",
    "x-client-version",
  ]);
  Object.entries(candidate).forEach(([k, v]) => {
    const key = String(k || "").trim().toLowerCase();
    if (!allow.has(key)) return;
    const value = typeof v === "string" ? v : String(v ?? "");
    if (!value || value.length > 1024) return;
    out.set(key, value);
  });
  return out;
}

function readBodyPayload(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.slice(0, 40_000);
  try {
    return JSON.stringify(value).slice(0, 40_000);
  } catch {
    return undefined;
  }
}

function passRateLimit(userId: string) {
  const windowMs = 60_000;
  const maxPerWindow = 40;
  const now = Date.now();
  const key = String(userId || "");
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

export async function POST(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    if (!passRateLimit(user.id)) {
      return NextResponse.json({ error: "proxy rate limited" }, { status: 429 });
    }

    const body = await req.json().catch(() => ({}));
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim() : "";
    const rawUrl = typeof body?.url === "string" ? body.url.trim() : "";
    const method = allowedMethod(body?.method);
    const timeoutRaw = Number(body?.timeoutMs ?? 10_000);
    const timeoutMs = Number.isFinite(timeoutRaw)
      ? Math.max(1_500, Math.min(12_000, Math.round(timeoutRaw)))
      : 10_000;

    if (!spaceId || !rawUrl) {
      return NextResponse.json({ error: "spaceId and url required" }, { status: 400 });
    }

    const access = await getSpaceAccess(spaceId, user.id);
    if (access.error) {
      return NextResponse.json(mapError(access.error, "access check failed"), { status: 500 });
    }
    if (!access.space || !access.canRead) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (!["GET", "HEAD"].includes(method) && !access.canEdit) {
      return NextResponse.json({ error: "forbidden (write proxy requires edit access)" }, { status: 403 });
    }

    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      return NextResponse.json({ error: "invalid url" }, { status: 400 });
    }

    if (!["http:", "https:"].includes(target.protocol)) {
      return NextResponse.json({ error: "unsupported protocol" }, { status: 400 });
    }
    if (!isHostAllowed(target.hostname)) {
      return NextResponse.json({ error: "host not allowed by proxy policy" }, { status: 403 });
    }

    const headers = buildForwardHeaders(body?.headers);
    const payload = ["GET", "HEAD"].includes(method) ? undefined : readBodyPayload(body?.body);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(target.toString(), {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as { name?: string })?.name === "AbortError") {
        return NextResponse.json({ error: "proxy timeout" }, { status: 504 });
      }
      return NextResponse.json({ error: "proxy request failed" }, { status: 502 });
    } finally {
      clearTimeout(timer);
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const bodyText = (await response.text()).slice(0, 200_000);
    let jsonBody: unknown = null;
    if (contentType.includes("application/json")) {
      try {
        jsonBody = JSON.parse(bodyText);
      } catch {
        jsonBody = null;
      }
    }

    return NextResponse.json({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType,
      body: jsonBody ?? bodyText,
      truncated: bodyText.length >= 200_000,
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
