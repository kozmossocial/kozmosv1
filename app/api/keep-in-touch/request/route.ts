import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { authenticateUser } from "../_auth";

type LinkRow = {
  id: number;
  requester_id: string;
  requested_id: string;
  status: "pending" | "accepted" | "declined";
};

export async function POST(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const targetUsername = String(body?.targetUsername ?? "").trim();

    if (!targetUsername) {
      return NextResponse.json(
        { error: "target username required" },
        { status: 400 }
      );
    }

    let { data: target, error: targetErr } = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username")
      .eq("username", targetUsername)
      .maybeSingle();

    if (!target && !targetErr) {
      const fallback = await supabaseAdmin
        .from("profileskozmos")
        .select("id, username")
        .ilike("username", targetUsername)
        .limit(1)
        .maybeSingle();
      target = fallback.data;
      targetErr = fallback.error;
    }

    if (targetErr || !target) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }

    if (target.id === user.id) {
      return NextResponse.json(
        { error: "cannot keep in touch with yourself" },
        { status: 400 }
      );
    }

    const pairFilter = `and(requester_id.eq.${user.id},requested_id.eq.${target.id}),and(requester_id.eq.${target.id},requested_id.eq.${user.id})`;

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from("keep_in_touch_requests")
      .select("id, requester_id, requested_id, status")
      .or(pairFilter)
      .maybeSingle();

    if (existingErr) {
      return NextResponse.json({ error: "lookup failed" }, { status: 500 });
    }

    const nowIso = new Date().toISOString();

    if (!existing) {
      const { error: insertErr } = await supabaseAdmin
        .from("keep_in_touch_requests")
        .insert({
          requester_id: user.id,
          requested_id: target.id,
          status: "pending",
          responded_at: null,
        });

      if (insertErr) {
        return NextResponse.json({ error: "request failed" }, { status: 500 });
      }

      return NextResponse.json({ ok: true, status: "pending" });
    }

    const row = existing as LinkRow;

    if (row.status === "accepted") {
      return NextResponse.json({ ok: true, status: "accepted" });
    }

    if (row.status === "pending") {
      if (row.requester_id === user.id) {
        return NextResponse.json({ ok: true, status: "pending" });
      }

      const { error: acceptErr } = await supabaseAdmin
        .from("keep_in_touch_requests")
        .update({
          status: "accepted",
          responded_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", row.id);

      if (acceptErr) {
        return NextResponse.json({ error: "accept failed" }, { status: 500 });
      }

      return NextResponse.json({ ok: true, status: "accepted" });
    }

    const { error: reopenErr } = await supabaseAdmin
      .from("keep_in_touch_requests")
      .update({
        requester_id: user.id,
        requested_id: target.id,
        status: "pending",
        responded_at: null,
        updated_at: nowIso,
      })
      .eq("id", row.id);

    if (reopenErr) {
      return NextResponse.json({ error: "request failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, status: "pending" });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
