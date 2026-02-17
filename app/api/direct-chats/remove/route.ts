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
    const chatId = String(body?.chatId ?? "").trim();

    if (!chatId) {
      return NextResponse.json({ error: "chat id required" }, { status: 400 });
    }

    const { data: chat, error: chatErr } = await supabaseAdmin
      .from("direct_chats")
      .select("id, participant_a, participant_b")
      .eq("id", chatId)
      .maybeSingle();

    if (chatErr || !chat) {
      return NextResponse.json({ error: "chat not found" }, { status: 404 });
    }

    const row = chat as DirectChatRow;
    if (row.participant_a !== user.id && row.participant_b !== user.id) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { error: deleteErr } = await supabaseAdmin
      .from("direct_chats")
      .delete()
      .eq("id", chatId);

    if (deleteErr) {
      return NextResponse.json({ error: "remove failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
