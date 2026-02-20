import { NextResponse } from "next/server";
import {
  getBuildRuntimeRequestContext,
  getStarterMode,
  mapBuildRuntimeError,
  passStarterRateLimit,
  sanitizeJsonValue,
} from "@/app/api/build/runtime/_shared";
import {
  createStarterSession,
  createStarterUser,
  extractStarterToken,
  resolveStarterActor,
  revokeStarterSession,
  verifyStarterLogin,
} from "@/app/api/build/runtime/starter/_auth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function scrubStarterUser(user: {
  id: string;
  username: string;
  display_name: string;
  profile: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || "",
    profile: user.profile || {},
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

async function enforceStarterUsersQuota(spaceId: string) {
  const [modeRes, countRes] = await Promise.all([
    getStarterMode(spaceId),
    supabaseAdmin
      .from("user_build_starter_users")
      .select("id", { count: "exact", head: true })
      .eq("space_id", spaceId),
  ]);
  if (modeRes.error) return { error: "mode load failed", blocked: true };
  if (!modeRes.mode?.enabled) return { error: "starter mode disabled", blocked: true };
  if (countRes.error) return { error: "starter users count failed", blocked: true };
  const quota = Number(modeRes.mode?.starter_users_quota || 3000);
  if (Number(countRes.count || 0) >= quota) {
    return { error: "starter quota exceeded: users", blocked: true };
  }
  return { error: null, blocked: false };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const spaceId = String(url.searchParams.get("spaceId") || "").trim();
    if (!spaceId) {
      return NextResponse.json({ error: "spaceId required" }, { status: 400 });
    }
    const ctx = await getBuildRuntimeRequestContext(req, spaceId);
    if (ctx.access.error) {
      return NextResponse.json(mapBuildRuntimeError(ctx.access.error, "access check failed"), {
        status: 500,
      });
    }
    if (!ctx.access.space || !ctx.access.canRead) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (!passStarterRateLimit(ctx.rateIdentity, spaceId, "starter.auth.read", 200)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
    }

    const modeRes = await getStarterMode(spaceId);
    if (modeRes.error) {
      return NextResponse.json(mapBuildRuntimeError(modeRes.error, "mode load failed"), {
        status: 500,
      });
    }
    if (!modeRes.mode?.enabled) {
      return NextResponse.json({ error: "starter mode disabled" }, { status: 409 });
    }

    const token = extractStarterToken(req);
    const actorRes = await resolveStarterActor(spaceId, token);
    if (actorRes.error || !actorRes.actor) {
      return NextResponse.json({ user: null, authenticated: false });
    }

    return NextResponse.json({
      authenticated: true,
      user: scrubStarterUser(actorRes.actor.user),
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = typeof body?.action === "string" ? body.action.trim().toLowerCase() : "";
    const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim() : "";
    if (!spaceId) {
      return NextResponse.json({ error: "spaceId required" }, { status: 400 });
    }
    const ctx = await getBuildRuntimeRequestContext(req, spaceId);
    if (ctx.access.error) {
      return NextResponse.json(mapBuildRuntimeError(ctx.access.error, "access check failed"), {
        status: 500,
      });
    }
    if (!ctx.access.space || !ctx.access.canRead) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (!passStarterRateLimit(ctx.rateIdentity, spaceId, "starter.auth.write", 140)) {
      return NextResponse.json({ error: "starter rate limited" }, { status: 429 });
    }

    const modeRes = await getStarterMode(spaceId);
    if (modeRes.error) {
      return NextResponse.json(mapBuildRuntimeError(modeRes.error, "mode load failed"), {
        status: 500,
      });
    }
    if (!modeRes.mode?.enabled) {
      return NextResponse.json({ error: "starter mode disabled" }, { status: 409 });
    }

    if (action === "register") {
      const username = typeof body?.username === "string" ? body.username : "";
      const password = typeof body?.password === "string" ? body.password : "";
      const displayName = typeof body?.displayName === "string" ? body.displayName : "";
      const profile = sanitizeJsonValue(body?.profile);

      const quotaRes = await enforceStarterUsersQuota(spaceId);
      if (quotaRes.blocked) {
        const status = quotaRes.error?.includes("quota") ? 429 : 409;
        return NextResponse.json({ error: quotaRes.error }, { status });
      }

      const created = await createStarterUser({
        spaceId,
        username,
        password,
        displayName,
        profile,
      });
      if (created.error || !created.user) {
        const status = created.error?.includes("exists") ? 409 : 400;
        return NextResponse.json({ error: created.error || "register failed" }, { status });
      }

      const sessionRes = await createStarterSession(spaceId, created.user.id);
      if (sessionRes.error || !sessionRes.session || !sessionRes.token) {
        return NextResponse.json({ error: sessionRes.error || "session create failed" }, { status: 500 });
      }

      return NextResponse.json({
        ok: true,
        action,
        user: scrubStarterUser(created.user),
        starterToken: sessionRes.token,
        expiresAt: sessionRes.session.expires_at,
      });
    }

    if (action === "login") {
      const username = typeof body?.username === "string" ? body.username : "";
      const password = typeof body?.password === "string" ? body.password : "";
      const loginRes = await verifyStarterLogin(spaceId, username, password);
      if (loginRes.error || !loginRes.user) {
        return NextResponse.json({ error: loginRes.error || "login failed" }, { status: 401 });
      }

      const sessionRes = await createStarterSession(spaceId, loginRes.user.id);
      if (sessionRes.error || !sessionRes.session || !sessionRes.token) {
        return NextResponse.json({ error: sessionRes.error || "session create failed" }, { status: 500 });
      }

      return NextResponse.json({
        ok: true,
        action,
        user: scrubStarterUser(loginRes.user),
        starterToken: sessionRes.token,
        expiresAt: sessionRes.session.expires_at,
      });
    }

    if (action === "logout") {
      const token = extractStarterToken(req, body?.starterToken);
      const revokeRes = await revokeStarterSession(spaceId, token);
      if (revokeRes.error) {
        return NextResponse.json({ error: revokeRes.error }, { status: 400 });
      }
      return NextResponse.json({ ok: true, action });
    }

    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
