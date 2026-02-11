import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { hashSecret } from "@/lib/runtimeIdentity";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;

function extractBearerToken(req: Request) {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function resolveOrigin(req: Request) {
  if (siteUrl) return siteUrl.replace(/\/$/, "");
  const url = new URL(req.url);
  return url.origin.replace(/\/$/, "");
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export async function POST(req: Request) {
  try {
    const userJwt = extractBearerToken(req);
    if (!userJwt) {
      return NextResponse.json({ error: "missing session token" }, { status: 401 });
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey);
    const {
      data: { user },
      error: userErr,
    } = await authClient.auth.getUser(userJwt);

    if (userErr || !user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const ttlInput = Number(body?.ttlMinutes ?? 10);
    const ttlMinutes = Number.isFinite(ttlInput) ? clamp(ttlInput, 1, 60) : 10;

    const rawCode = `kzinv_${randomBytes(18).toString("hex")}`;
    const codeHash = hashSecret(rawCode);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

    const { error: insertErr } = await supabaseAdmin.from("runtime_invites").insert({
      code_hash: codeHash,
      created_by: user.id,
      expires_at: expiresAt,
      max_claims: 1,
      used_claims: 0,
      revoked: false,
    });

    if (insertErr) {
      const isMissingTable = insertErr.code === "42P01";
      return NextResponse.json(
        {
          error: isMissingTable
            ? "invite create failed: runtime_invites table missing"
            : "invite create failed",
          detail: insertErr.message,
          code: insertErr.code || null,
        },
        { status: 500 }
      );
    }

    const origin = resolveOrigin(req);
    const inviteUrl = `${origin}/runtime/connect?code=${encodeURIComponent(rawCode)}`;
    const specUrl = `${origin}/api/runtime/spec`;

    return NextResponse.json({
      code: rawCode,
      url: inviteUrl,
      specUrl,
      expiresAt,
    });
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      {
        error: "request failed",
        detail,
      },
      { status: 500 }
    );
  }
}
