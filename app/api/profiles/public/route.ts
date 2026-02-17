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

    const { searchParams } = new URL(req.url);
    const raw = searchParams.get("usernames") ?? "";
    const usernames = Array.from(
      new Set(
        raw
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      )
    ).slice(0, 100);

    if (usernames.length === 0) {
      return NextResponse.json({ rows: [] });
    }

    const { data, error } = await supabaseAdmin
      .from("profileskozmos")
      .select("username, avatar_url")
      .in("username", usernames);

    if (error) {
      return NextResponse.json({ error: "query failed" }, { status: 500 });
    }

    const rows = (data || []).map((row) => ({
      username: row.username,
      avatar_url: row.avatar_url ?? null,
    }));

    // Ensure requester can always see own avatar even if username casing differs.
    const { data: selfRow } = await supabaseAdmin
      .from("profileskozmos")
      .select("username, avatar_url")
      .eq("id", user.id)
      .maybeSingle();

    if (selfRow?.username) {
      const hasSelfRow = rows.some(
        (row) =>
          typeof row.username === "string" &&
          row.username.toLowerCase() === selfRow.username.toLowerCase()
      );

      if (!hasSelfRow) {
        rows.push({
          username: selfRow.username,
          avatar_url: selfRow.avatar_url ?? null,
        });
      }
    }

    return NextResponse.json({
      rows,
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
