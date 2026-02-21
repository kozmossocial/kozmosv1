import { NextResponse } from "next/server";
import { authenticateUser } from "../../keep-in-touch/_auth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function areUsersInTouch(a: string, b: string) {
  const pairFilter = `and(requester_id.eq.${a},requested_id.eq.${b}),and(requester_id.eq.${b},requested_id.eq.${a})`;
  const { data, error } = await supabaseAdmin
    .from("keep_in_touch_requests")
    .select("id")
    .eq("status", "accepted")
    .or(pairFilter)
    .limit(1);
  if (error) return { ok: false, error };
  return { ok: Array.isArray(data) && data.length > 0, error: null };
}

export async function POST(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      targetUserId?: unknown;
      amount?: unknown;
    };

    const targetUserId = String(body.targetUserId || "").trim();
    const amount = Number(body.amount);

    if (!targetUserId) {
      return NextResponse.json({ error: "target user required" }, { status: 400 });
    }
    if (targetUserId === user.id) {
      return NextResponse.json({ error: "cannot send to yourself" }, { status: 400 });
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      return NextResponse.json({ error: "amount must be a positive integer" }, { status: 400 });
    }

    const inTouch = await areUsersInTouch(user.id, targetUserId);
    if (inTouch.error) {
      return NextResponse.json({ error: "in-touch check failed" }, { status: 500 });
    }
    if (!inTouch.ok) {
      return NextResponse.json({ error: "user is not in touch" }, { status: 403 });
    }

    const refKey = `spc_transfer:${user.id}:${targetUserId}:${Date.now()}`;
    const { data, error } = await supabaseAdmin.rpc("spice_transfer", {
      p_from_user_id: user.id,
      p_to_user_id: targetUserId,
      p_amount: amount,
      p_ref_key: refKey,
      p_metadata: {
        source: "api.spice.transfer",
      },
    });

    if (error) {
      return NextResponse.json(
        { error: `spc transfer failed: ${error.message}` },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json(
        { error: "transfer failed (insufficient SPC or invalid request)" },
        { status: 400 }
      );
    }

    const { data: wallet } = await supabaseAdmin
      .from("spice_wallets")
      .select("balance")
      .eq("user_id", user.id)
      .maybeSingle();

    const balanceRaw = (wallet as { balance?: number | string } | null)?.balance;
    const balanceValue =
      typeof balanceRaw === "number" ? balanceRaw : Number(balanceRaw ?? 0);

    return NextResponse.json({
      ok: true,
      balance: Number.isFinite(balanceValue) ? balanceValue : 0,
      amount,
      targetUserId,
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
