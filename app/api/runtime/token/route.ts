import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function extractBearerToken(req: Request) {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function hashToken(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
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
    const label = typeof body?.label === "string" ? body.label.slice(0, 60) : "runtime";

    const rawToken = `kzrt_${randomBytes(24).toString("hex")}`;
    const tokenHash = hashToken(rawToken);

    const { error: insertErr } = await supabaseAdmin.from("runtime_user_tokens").insert({
      user_id: user.id,
      token_hash: tokenHash,
      label,
      is_active: true,
    });

    if (insertErr) {
      return NextResponse.json({ error: "token create failed" }, { status: 500 });
    }

    return NextResponse.json({
      token: rawToken,
      note: "Store this token now. It will not be shown again.",
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

