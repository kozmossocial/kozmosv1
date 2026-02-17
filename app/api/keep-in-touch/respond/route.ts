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
    const requestId = Number(body?.requestId ?? 0);
    const decision = String(body?.decision ?? "").toLowerCase();

    if (!Number.isFinite(requestId) || requestId <= 0) {
      return NextResponse.json({ error: "invalid request id" }, { status: 400 });
    }

    if (decision !== "accept" && decision !== "decline") {
      return NextResponse.json({ error: "invalid decision" }, { status: 400 });
    }

    const { data: row, error: rowErr } = await supabaseAdmin
      .from("keep_in_touch_requests")
      .select("id, requester_id, requested_id, status")
      .eq("id", requestId)
      .maybeSingle();

    if (rowErr || !row) {
      return NextResponse.json({ error: "request not found" }, { status: 404 });
    }

    const link = row as LinkRow;

    if (link.requested_id !== user.id) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    if (link.status !== "pending") {
      return NextResponse.json(
        { error: "request already resolved" },
        { status: 409 }
      );
    }

    const nextStatus = decision === "accept" ? "accepted" : "declined";
    const nowIso = new Date().toISOString();

    const { error: updateErr } = await supabaseAdmin
      .from("keep_in_touch_requests")
      .update({
        status: nextStatus,
        responded_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", link.id);

    if (updateErr) {
      return NextResponse.json({ error: "update failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, status: nextStatus });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
