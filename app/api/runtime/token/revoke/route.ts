import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const bootstrapKey = process.env.RUNTIME_BOOTSTRAP_KEY;

function hashToken(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

async function resolveUserIdByUsername(username: string) {
  const { data } = await supabaseAdmin
    .from("profileskozmos")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  return data?.id ?? null;
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
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const tokenHashInput =
      typeof body?.tokenHash === "string" ? body.tokenHash.trim() : "";
    const usernameInput =
      typeof body?.username === "string" ? body.username.trim() : "";
    const userIdInput =
      typeof body?.userId === "string" ? body.userId.trim() : "";
    const revokeAllForUser = body?.revokeAllForUser === true;

    const tokenHash = token ? hashToken(token) : tokenHashInput;

    if (tokenHash) {
      const { error, count } = await supabaseAdmin
        .from("runtime_user_tokens")
        .update({ is_active: false })
        .eq("token_hash", tokenHash)
        .eq("is_active", true)
        .select("id", { count: "exact" });

      if (error) {
        return NextResponse.json({ error: "revoke failed" }, { status: 500 });
      }

      return NextResponse.json({ ok: true, revoked: count ?? 0 });
    }

    if (!revokeAllForUser) {
      return NextResponse.json(
        { error: "provide token/tokenHash or revokeAllForUser + user target" },
        { status: 400 }
      );
    }

    let targetUserId = userIdInput;
    if (!targetUserId && usernameInput) {
      targetUserId = (await resolveUserIdByUsername(usernameInput)) ?? "";
    }

    if (!targetUserId) {
      return NextResponse.json(
        { error: "missing user target" },
        { status: 400 }
      );
    }

    const { error, count } = await supabaseAdmin
      .from("runtime_user_tokens")
      .update({ is_active: false })
      .eq("user_id", targetUserId)
      .eq("is_active", true)
      .select("id", { count: "exact" });

    if (error) {
      return NextResponse.json({ error: "revoke failed" }, { status: 500 });
    }

    await supabaseAdmin
      .from("runtime_presence")
      .delete()
      .eq("user_id", targetUserId);

    return NextResponse.json({ ok: true, revoked: count ?? 0 });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

