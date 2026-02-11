import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createRuntimeIdentity, hashSecret } from "@/lib/runtimeIdentity";

type RuntimeInviteRow = {
  id: number;
  expires_at: string;
  max_claims: number;
  used_claims: number;
  revoked: boolean;
};

function isExpired(expiresAt: string) {
  return new Date(expiresAt).getTime() <= Date.now();
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const requestedUsername =
      typeof body?.username === "string" ? body.username : "";
    const label = typeof body?.label === "string" ? body.label : "runtime";

    if (!code) {
      return NextResponse.json({ error: "missing invite code" }, { status: 400 });
    }

    const codeHash = hashSecret(code);
    const { data: invite, error: inviteErr } = await supabaseAdmin
      .from("runtime_invites")
      .select("id, expires_at, max_claims, used_claims, revoked")
      .eq("code_hash", codeHash)
      .maybeSingle();

    const inviteRow = invite as RuntimeInviteRow | null;
    if (inviteErr || !inviteRow || inviteRow.revoked) {
      return NextResponse.json({ error: "invalid invite" }, { status: 401 });
    }

    if (
      isExpired(inviteRow.expires_at) ||
      inviteRow.used_claims >= inviteRow.max_claims
    ) {
      return NextResponse.json({ error: "invite expired" }, { status: 410 });
    }

    const nextClaims = inviteRow.used_claims + 1;
    const now = new Date().toISOString();
    const { data: reservedRows, error: reserveErr } = await supabaseAdmin
      .from("runtime_invites")
      .update({
        used_claims: nextClaims,
        used_at: now,
        revoked: nextClaims >= inviteRow.max_claims,
      })
      .eq("id", inviteRow.id)
      .eq("used_claims", inviteRow.used_claims)
      .select("id");

    if (reserveErr || !reservedRows || reservedRows.length === 0) {
      return NextResponse.json({ error: "invite already used" }, { status: 409 });
    }

    try {
      const result = await createRuntimeIdentity({
        requestedUsername,
        label,
      });

      return NextResponse.json({
        user: result.user,
        token: result.token,
        note: "Store token now. It will not be shown again.",
      });
    } catch {
      await supabaseAdmin
        .from("runtime_invites")
        .update({
          used_claims: inviteRow.used_claims,
          used_at: inviteRow.used_claims > 0 ? now : null,
          revoked: false,
        })
        .eq("id", inviteRow.id);

      return NextResponse.json({ error: "claim failed" }, { status: 500 });
    }
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

