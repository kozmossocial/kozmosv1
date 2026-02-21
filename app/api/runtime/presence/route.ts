import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveRuntimeToken } from "@/app/api/runtime/_tokenAuth";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function extractBearerToken(req: Request) {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
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

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const activeSince = new Date(Date.now() - 45 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
      .from("runtime_presence")
      .select("user_id, username, last_seen_at")
      .gte("last_seen_at", activeSince)
      .order("last_seen_at", { ascending: false })
      .limit(200);

    if (error) {
      return NextResponse.json({ error: "presence list failed" }, { status: 500 });
    }

    const seen = new Set<string>();
    const users = (data || [])
      .map((row) => ({
        userId: String((row as { user_id?: string }).user_id || "").trim(),
        username: String((row as { username?: string }).username || "").trim(),
        lastSeenAt: String((row as { last_seen_at?: string }).last_seen_at || "").trim(),
      }))
      .filter((row) => {
        if (!row.username) return false;
        const key = row.userId || row.username.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    return NextResponse.json({ users });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const resolved = await resolveRuntimeToken(req);
    if (!resolved.userId || !resolved.tokenHash) {
      return NextResponse.json(
        { error: resolved.error || "invalid token" },
        { status: resolved.status || 401 }
      );
    }

    const { data: profile } = await supabaseAdmin
      .from("profileskozmos")
      .select("username")
      .eq("id", resolved.userId)
      .maybeSingle();

    const { error: presenceErr } = await supabaseAdmin.from("runtime_presence").upsert({
      user_id: resolved.userId,
      username: profile?.username || "user",
      last_seen_at: new Date().toISOString(),
    });
    if (presenceErr) {
      return NextResponse.json({ error: "presence update failed" }, { status: 500 });
    }

    await supabaseAdmin
      .from("runtime_user_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("token_hash", resolved.tokenHash);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const resolved = await resolveRuntimeToken(req);
    if (!resolved.userId || !resolved.tokenHash) {
      return NextResponse.json(
        { error: resolved.error || "invalid token" },
        { status: resolved.status || 401 }
      );
    }

    const { error: presenceDeleteErr } = await supabaseAdmin
      .from("runtime_presence")
      .delete()
      .eq("user_id", resolved.userId);
    if (presenceDeleteErr) {
      return NextResponse.json({ error: "presence clear failed" }, { status: 500 });
    }

    await supabaseAdmin
      .from("runtime_user_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("token_hash", resolved.tokenHash);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
