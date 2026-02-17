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
    const orderedUserIds: string[] = Array.isArray(body?.orderedUserIds)
      ? body.orderedUserIds
          .map((value: unknown) => String(value ?? "").trim())
          .filter((value: string) => value.length > 0)
      : [];

    if (orderedUserIds.length === 0) {
      await supabaseAdmin
        .from("keep_in_touch_orders")
        .delete()
        .eq("user_id", user.id);
      return NextResponse.json({ ok: true });
    }

    const uniqueIds = Array.from(new Set<string>(orderedUserIds));

    const pairFilter = uniqueIds
      .map((id) => `and(requester_id.eq.${user.id},requested_id.eq.${id}),status.eq.accepted`)
      .concat(
        uniqueIds.map(
          (id) => `and(requester_id.eq.${id},requested_id.eq.${user.id}),status.eq.accepted`
        )
      )
      .join(",");

    const { data: links, error: linksErr } = await supabaseAdmin
      .from("keep_in_touch_requests")
      .select("requester_id, requested_id")
      .or(pairFilter);

    if (linksErr) {
      return NextResponse.json({ error: "touch verification failed" }, { status: 500 });
    }

    const allowedIds = new Set<string>();
    (links || []).forEach((row) => {
      const requesterId = String((row as { requester_id: string }).requester_id);
      const requestedId = String((row as { requested_id: string }).requested_id);
      const otherId = requesterId === user.id ? requestedId : requesterId;
      if (otherId && otherId !== user.id) {
        allowedIds.add(otherId);
      }
    });

    const sanitized = uniqueIds.filter((id) => allowedIds.has(id));

    await supabaseAdmin
      .from("keep_in_touch_orders")
      .delete()
      .eq("user_id", user.id);

    if (sanitized.length === 0) {
      return NextResponse.json({ ok: true });
    }

    const rows = sanitized.map((contactUserId, idx) => ({
      user_id: user.id,
      contact_user_id: contactUserId,
      sort_order: idx,
    }));

    const { error: upsertErr } = await supabaseAdmin
      .from("keep_in_touch_orders")
      .upsert(rows, { onConflict: "user_id,contact_user_id" });

    if (upsertErr) {
      return NextResponse.json({ error: "order update failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
