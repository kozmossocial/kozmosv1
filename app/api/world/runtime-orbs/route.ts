import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

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

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const activeSince = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const { data: presenceRows, error: presenceErr } = await supabaseAdmin
      .from("runtime_presence")
      .select("user_id, matrix_x, matrix_z, matrix_updated_at, last_seen_at")
      .not("matrix_updated_at", "is", null)
      .gte("last_seen_at", activeSince)
      .order("matrix_updated_at", { ascending: false })
      .limit(200);

    if (presenceErr) {
      return NextResponse.json({ error: "runtime orbs load failed" }, { status: 500 });
    }

    const userIds = Array.from(
      new Set((presenceRows || []).map((row) => row.user_id).filter(Boolean))
    );
    if (userIds.length === 0) {
      return NextResponse.json({ orbs: [] });
    }

    const { data: profiles, error: profilesErr } = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username, orb_color")
      .in("id", userIds);

    if (profilesErr) {
      return NextResponse.json({ error: "runtime orb profiles failed" }, { status: 500 });
    }

    const profileMap: Record<string, { username: string; orb_color: string }> = {};
    (profiles || []).forEach((profile) => {
      const id = String((profile as { id: string }).id);
      profileMap[id] = {
        username: String((profile as { username?: string }).username || "user"),
        orb_color: String((profile as { orb_color?: string }).orb_color || "#7df9ff"),
      };
    });

    const orbs = (presenceRows || [])
      .map((row) => {
        const userId = String((row as { user_id: string }).user_id);
        if (!profileMap[userId]) return null;
        return {
          userId,
          username: profileMap[userId].username,
          color: profileMap[userId].orb_color,
          x: Number((row as { matrix_x?: number | null }).matrix_x ?? 0),
          z: Number((row as { matrix_z?: number | null }).matrix_z ?? 0),
          ts: Date.parse(
            String(
              (row as { matrix_updated_at?: string | null }).matrix_updated_at ||
                (row as { last_seen_at?: string }).last_seen_at ||
                new Date().toISOString()
            )
          ),
        };
      })
      .filter(Boolean);

    return NextResponse.json({ orbs });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

