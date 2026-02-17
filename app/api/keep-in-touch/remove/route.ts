import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { authenticateUser } from "../_auth";

export async function POST(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const targetUserId = String(body?.targetUserId ?? "").trim();

    if (!targetUserId) {
      return NextResponse.json({ error: "target user required" }, { status: 400 });
    }

    if (targetUserId === user.id) {
      return NextResponse.json({ error: "invalid target" }, { status: 400 });
    }

    const pairFilter = `and(requester_id.eq.${user.id},requested_id.eq.${targetUserId}),and(requester_id.eq.${targetUserId},requested_id.eq.${user.id})`;

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from("keep_in_touch_requests")
      .select("id")
      .or(pairFilter)
      .maybeSingle();

    if (existingErr) {
      return NextResponse.json({ error: "lookup failed" }, { status: 500 });
    }

    if (!existing?.id) {
      return NextResponse.json({ ok: true });
    }

    const { error: deleteErr } = await supabaseAdmin
      .from("keep_in_touch_requests")
      .delete()
      .eq("id", existing.id);

    if (deleteErr) {
      return NextResponse.json({ error: "remove failed" }, { status: 500 });
    }

    await supabaseAdmin
      .from("keep_in_touch_orders")
      .delete()
      .eq("user_id", user.id)
      .eq("contact_user_id", targetUserId);

    await supabaseAdmin
      .from("keep_in_touch_orders")
      .delete()
      .eq("user_id", targetUserId)
      .eq("contact_user_id", user.id);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
