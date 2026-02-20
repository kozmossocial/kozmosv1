import { createHash, randomInt } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const DELETE_MAIL_FROM = process.env.KOZMOS_EMAIL_FROM || "axy@kozmos.social";
const DELETE_CODE_TTL_MINUTES = 10;
const USER_WINDOW_MINUTES = 15;
const USER_WINDOW_MAX = 3;
const IP_WINDOW_MINUTES = 15;
const IP_WINDOW_MAX = 10;

function getRequestIp(req: Request) {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim();
  if (first) return first;
  return (req.headers.get("x-real-ip") || "").trim();
}

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

function generateCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

async function sendDeleteEmail(email: string, code: string) {
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <h2>Kozmos Account Delete Verification</h2>
      <p>Your verification code is:</p>
      <p style="font-size:24px;letter-spacing:4px;"><strong>${code}</strong></p>
      <p>This code expires in ${DELETE_CODE_TTL_MINUTES} minutes.</p>
      <p>If you did not request this, ignore this email.</p>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: DELETE_MAIL_FROM,
      to: [email],
      subject: "Kozmos account deletion verification code",
      html,
    }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`email send failed: ${msg || res.status}`);
  }
}

export async function POST(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!user.email) {
      return NextResponse.json({ error: "user email missing" }, { status: 400 });
    }
    if (!RESEND_API_KEY) {
      return NextResponse.json({ error: "email service not configured" }, { status: 500 });
    }
    const requestIp = getRequestIp(req) || "unknown";
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const { data: latest } = await supabaseAdmin
      .from("user_account_delete_codes")
      .select("created_at, locked_until")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const latestMs = Date.parse(String(latest?.created_at || ""));
    if (Number.isFinite(latestMs) && Date.now() - latestMs < 60_000) {
      return NextResponse.json({ error: "please wait before requesting a new code" }, { status: 429 });
    }
    const lockedUntilMs = Date.parse(String(latest?.locked_until || ""));
    if (Number.isFinite(lockedUntilMs) && lockedUntilMs > now) {
      return NextResponse.json({ error: "too many wrong attempts, try later" }, { status: 429 });
    }

    const userWindowIso = new Date(now - USER_WINDOW_MINUTES * 60_000).toISOString();
    const ipWindowIso = new Date(now - IP_WINDOW_MINUTES * 60_000).toISOString();
    const [userRate, ipRate] = await Promise.all([
      supabaseAdmin
        .from("user_account_delete_codes")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", userWindowIso),
      supabaseAdmin
        .from("user_account_delete_codes")
        .select("id", { count: "exact", head: true })
        .eq("request_ip", requestIp)
        .gte("created_at", ipWindowIso),
    ]);
    if (userRate.error || ipRate.error) {
      return NextResponse.json({ error: "rate check failed" }, { status: 500 });
    }
    if (Number(userRate.count || 0) >= USER_WINDOW_MAX) {
      return NextResponse.json({ error: "too many code requests for this account" }, { status: 429 });
    }
    if (Number(ipRate.count || 0) >= IP_WINDOW_MAX) {
      return NextResponse.json({ error: "too many code requests from this network" }, { status: 429 });
    }

    await supabaseAdmin
      .from("user_account_delete_codes")
      .update({ consumed_at: nowIso })
      .eq("user_id", user.id)
      .is("consumed_at", null)
      .gt("expires_at", nowIso);

    const code = generateCode();
    const codeHash = hashCode(user.id, code);
    const expiresAt = new Date(Date.now() + DELETE_CODE_TTL_MINUTES * 60_000).toISOString();

    const { error: insertErr } = await supabaseAdmin.from("user_account_delete_codes").insert({
      user_id: user.id,
      code_hash: codeHash,
      request_ip: requestIp,
      expires_at: expiresAt,
    });
    if (insertErr) {
      return NextResponse.json({ error: "code create failed" }, { status: 500 });
    }

    await sendDeleteEmail(user.email, code);
    return NextResponse.json({ ok: true, expiresAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
