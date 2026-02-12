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

function sanitizeHexColor(input: string) {
  const color = input.trim();
  return /^#[0-9A-Fa-f]{6}$/.test(color) ? color.toLowerCase() : null;
}

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { data, error } = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username, orb_color")
      .eq("id", user.id)
      .maybeSingle();

    if (error || !data) {
      return NextResponse.json({ error: "profile not found" }, { status: 404 });
    }

    return NextResponse.json({
      profile: {
        id: data.id,
        username: data.username,
        orbColor: data.orb_color || "#7df9ff",
      },
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const orbColor =
      typeof body?.orbColor === "string" ? sanitizeHexColor(body.orbColor) : null;

    if (!orbColor) {
      return NextResponse.json({ error: "valid hex color required" }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from("profileskozmos")
      .update({ orb_color: orbColor })
      .eq("id", user.id)
      .select("id, username, orb_color")
      .maybeSingle();

    if (error || !data) {
      return NextResponse.json({ error: "update failed" }, { status: 500 });
    }

    return NextResponse.json({
      profile: {
        id: data.id,
        username: data.username,
        orbColor: data.orb_color || "#7df9ff",
      },
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
