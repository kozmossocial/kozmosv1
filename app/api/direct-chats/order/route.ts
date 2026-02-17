import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { authenticateUser } from "../_auth";

type DirectChatRow = {
  id: string;
  participant_a: string;
  participant_b: string;
};

export async function POST(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const orderedChatIds: string[] = Array.isArray(body?.orderedChatIds)
      ? body.orderedChatIds
          .map((value: unknown) => String(value ?? "").trim())
          .filter((value: string) => value.length > 0)
      : [];

    await supabaseAdmin.from("direct_chat_orders").delete().eq("user_id", user.id);

    if (orderedChatIds.length === 0) {
      return NextResponse.json({ ok: true });
    }

    const uniqueIds = Array.from(new Set<string>(orderedChatIds));

    const { data: chats, error: chatsErr } = await supabaseAdmin
      .from("direct_chats")
      .select("id, participant_a, participant_b")
      .in("id", uniqueIds)
      .or(`participant_a.eq.${user.id},participant_b.eq.${user.id}`);

    if (chatsErr) {
      return NextResponse.json({ error: "chat verification failed" }, { status: 500 });
    }

    const allowed = new Set<string>((chats as DirectChatRow[] | null)?.map((row) => row.id) || []);
    const sanitized = uniqueIds.filter((id) => allowed.has(id));

    if (sanitized.length === 0) {
      return NextResponse.json({ ok: true });
    }

    const rows = sanitized.map((chatId, index) => ({
      user_id: user.id,
      chat_id: chatId,
      sort_order: index,
    }));

    const { error: upsertErr } = await supabaseAdmin
      .from("direct_chat_orders")
      .upsert(rows, { onConflict: "user_id,chat_id" });

    if (upsertErr) {
      return NextResponse.json({ error: "order update failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
