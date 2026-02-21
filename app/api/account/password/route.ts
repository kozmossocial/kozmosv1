import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const MAX_WRONG_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

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

function hashCode(userId: string, code: string) {
  return createHash("sha256")
    .update(`${userId}:${code}`, "utf8")
    .digest("hex");
}

export async function POST(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const newPassword = String(body?.newPassword || "").trim();
    const verificationCode = String(body?.verificationCode || "").trim();

    if (!newPassword) {
      return NextResponse.json({ error: "new password required" }, { status: 400 });
    }
    if (newPassword.length < 8) {
      return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
    }
    if (!verificationCode || !/^\d{6}$/.test(verificationCode)) {
      return NextResponse.json({ error: "verification code required" }, { status: 400 });
    }

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const codeHash = hashCode(user.id, verificationCode);

    const { data: activeRow, error: activeErr } = await supabaseAdmin
      .from("user_password_change_codes")
      .select("id, code_hash, expires_at, consumed_at, attempt_count, locked_until")
      .eq("user_id", user.id)
      .is("consumed_at", null)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activeErr) {
      return NextResponse.json({ error: "verification check failed" }, { status: 500 });
    }
    if (!activeRow) {
      return NextResponse.json({ error: "invalid or expired verification code" }, { status: 400 });
    }

    const lockedUntilMs = Date.parse(String(activeRow.locked_until || ""));
    if (Number.isFinite(lockedUntilMs) && lockedUntilMs > nowMs) {
      return NextResponse.json({ error: "too many wrong attempts, try later" }, { status: 429 });
    }

    if (activeRow.code_hash !== codeHash) {
      const nextAttempts = Number(activeRow.attempt_count || 0) + 1;
      const patch: { attempt_count: number; locked_until?: string } = {
        attempt_count: nextAttempts,
      };
      if (nextAttempts >= MAX_WRONG_ATTEMPTS) {
        patch.locked_until = new Date(nowMs + LOCK_MINUTES * 60_000).toISOString();
      }
      await supabaseAdmin
        .from("user_password_change_codes")
        .update(patch)
        .eq("id", activeRow.id);
      if (nextAttempts >= MAX_WRONG_ATTEMPTS) {
        return NextResponse.json({ error: "too many wrong attempts, try later" }, { status: 429 });
      }
      return NextResponse.json({ error: "invalid or expired verification code" }, { status: 400 });
    }

    const { data: codeRow, error: codeErr } = await supabaseAdmin
      .from("user_password_change_codes")
      .select("id, expires_at, consumed_at, attempt_count")
      .eq("user_id", user.id)
      .eq("code_hash", codeHash)
      .gt("expires_at", nowIso)
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (codeErr) {
      return NextResponse.json({ error: "verification check failed" }, { status: 500 });
    }
    if (!codeRow) {
      return NextResponse.json({ error: "invalid or expired verification code" }, { status: 400 });
    }

    await supabaseAdmin
      .from("user_password_change_codes")
      .update({
        consumed_at: nowIso,
        attempt_count: Number(codeRow.attempt_count || 0) + 1,
      })
      .eq("id", codeRow.id);

    const authClient = createClient(supabaseUrl, supabaseAnonKey);
    const { error: updateErr } = await authClient.auth.updateUser({
      password: newPassword,
    });

    if (updateErr) {
      return NextResponse.json(
        { error: `password change failed: ${updateErr.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
