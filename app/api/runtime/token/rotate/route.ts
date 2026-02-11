import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const bootstrapKey = process.env.RUNTIME_BOOTSTRAP_KEY;

function hashToken(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

export async function POST(req: Request) {
  try {
    if (!bootstrapKey) {
      return NextResponse.json({ error: "bootstrap disabled" }, { status: 503 });
    }

    const headerKey = req.headers.get("x-kozmos-bootstrap-key");
    if (!headerKey || headerKey !== bootstrapKey) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const oldToken = typeof body?.token === "string" ? body.token.trim() : "";
    const labelInput = typeof body?.label === "string" ? body.label.slice(0, 60) : "";

    if (!oldToken) {
      return NextResponse.json({ error: "missing token" }, { status: 400 });
    }

    const oldHash = hashToken(oldToken);
    const { data: oldRow, error: oldErr } = await supabaseAdmin
      .from("runtime_user_tokens")
      .select("user_id, label, is_active")
      .eq("token_hash", oldHash)
      .maybeSingle();

    if (oldErr || !oldRow || !oldRow.is_active) {
      return NextResponse.json({ error: "invalid token" }, { status: 401 });
    }

    const newToken = `kzrt_${randomBytes(24).toString("hex")}`;
    const newHash = hashToken(newToken);
    const label = labelInput || oldRow.label || "runtime";

    const { error: insertErr } = await supabaseAdmin.from("runtime_user_tokens").insert({
      user_id: oldRow.user_id,
      token_hash: newHash,
      label,
      is_active: true,
      last_used_at: new Date().toISOString(),
    });

    if (insertErr) {
      return NextResponse.json({ error: "rotate failed" }, { status: 500 });
    }

    await supabaseAdmin
      .from("runtime_user_tokens")
      .update({ is_active: false, last_used_at: new Date().toISOString() })
      .eq("token_hash", oldHash);

    return NextResponse.json({
      ok: true,
      token: newToken,
      note: "Store token now. Old token is revoked.",
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

