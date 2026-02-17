import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { authenticateUser } from "../_auth";

type ChatRow = {
  id: string;
  participant_a: string;
  participant_b: string;
};

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const chatId = String(searchParams.get("chatId") || "").trim();

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

    const row = chat as ChatRow;
    if (row.participant_a !== user.id && row.participant_b !== user.id) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { data: messages, error: messageErr } = await supabaseAdmin
      .from("direct_chat_messages")
      .select("id, chat_id, sender_id, content, created_at")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true })
      .limit(200);

    if (messageErr) {
      return NextResponse.json({ error: "message query failed" }, { status: 500 });
    }

    return NextResponse.json({ messages: messages || [] });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const chatId = String(body?.chatId ?? "").trim();
    const content = String(body?.content ?? "").trim();

    if (!chatId) {
      return NextResponse.json({ error: "chat id required" }, { status: 400 });
    }

    if (!content) {
      return NextResponse.json({ error: "content required" }, { status: 400 });
    }

    const { data: chat, error: chatErr } = await supabaseAdmin
      .from("direct_chats")
      .select("id, participant_a, participant_b")
      .eq("id", chatId)
      .maybeSingle();

    if (chatErr || !chat) {
      return NextResponse.json({ error: "chat not found" }, { status: 404 });
    }

    const row = chat as ChatRow;
    if (row.participant_a !== user.id && row.participant_b !== user.id) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const nowIso = new Date().toISOString();

    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from("direct_chat_messages")
      .insert({
        chat_id: chatId,
        sender_id: user.id,
        content,
      })
      .select("id, chat_id, sender_id, content, created_at")
      .single();

    if (insertErr || !inserted) {
      return NextResponse.json({ error: "send failed" }, { status: 500 });
    }

    await supabaseAdmin
      .from("direct_chats")
      .update({ updated_at: nowIso })
      .eq("id", chatId);

    return NextResponse.json({ message: inserted });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
