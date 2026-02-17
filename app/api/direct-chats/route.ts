import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { authenticateUser } from "./_auth";

type DirectChatRow = {
  id: string;
  participant_a: string;
  participant_b: string;
  updated_at: string;
};

type ProfileRow = {
  id: string;
  username: string;
  avatar_url: string | null;
};

type DirectChatOrderRow = {
  chat_id: string;
  sort_order: number;
};

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { data: chats, error: chatsErr } = await supabaseAdmin
      .from("direct_chats")
      .select("id, participant_a, participant_b, updated_at")
      .or(`participant_a.eq.${user.id},participant_b.eq.${user.id}`)
      .order("updated_at", { ascending: false });

    if (chatsErr) {
      return NextResponse.json({ error: "chat query failed" }, { status: 500 });
    }

    const rows = (chats || []) as DirectChatRow[];
    const orderMap: Record<string, number> = {};

    if (rows.length > 0) {
      const chatIds = rows.map((row) => row.id);
      const { data: orders, error: orderErr } = await supabaseAdmin
        .from("direct_chat_orders")
        .select("chat_id, sort_order")
        .eq("user_id", user.id)
        .in("chat_id", chatIds);

      if (orderErr) {
        return NextResponse.json({ error: "chat order query failed" }, { status: 500 });
      }

      (orders as DirectChatOrderRow[] | null)?.forEach((row) => {
        orderMap[row.chat_id] = Number(row.sort_order) || 0;
      });
    }

    const otherIds = Array.from(
      new Set(
        rows
          .map((row) => (row.participant_a === user.id ? row.participant_b : row.participant_a))
          .filter((id) => id && id !== user.id)
      )
    );

    const profileMap: Record<string, ProfileRow> = {};

    if (otherIds.length > 0) {
      const { data: profiles, error: profileErr } = await supabaseAdmin
        .from("profileskozmos")
        .select("id, username, avatar_url")
        .in("id", otherIds);

      if (profileErr) {
        return NextResponse.json({ error: "profile query failed" }, { status: 500 });
      }

      (profiles as ProfileRow[] | null)?.forEach((profile) => {
        profileMap[profile.id] = profile;
      });
    }

    const list = rows
      .map((row) => {
        const otherUserId = row.participant_a === user.id ? row.participant_b : row.participant_a;
        const profile = profileMap[otherUserId];
        if (!profile?.username) return null;
        return {
          chat_id: row.id,
          other_user_id: otherUserId,
          username: profile.username,
          avatar_url: profile.avatar_url ?? null,
          updated_at: row.updated_at,
        };
      })
      .filter(
        (
          row
        ): row is {
          chat_id: string;
          other_user_id: string;
          username: string;
          avatar_url: string | null;
          updated_at: string;
        } => Boolean(row)
      )
      .sort((a, b) => {
        const orderA =
          typeof orderMap[a.chat_id] === "number"
            ? orderMap[a.chat_id]
            : Number.MAX_SAFE_INTEGER;
        const orderB =
          typeof orderMap[b.chat_id] === "number"
            ? orderMap[b.chat_id]
            : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        return Date.parse(b.updated_at) - Date.parse(a.updated_at);
      });

    return NextResponse.json({ chats: list });
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
    const targetUserId = String(body?.targetUserId ?? "").trim();

    if (!targetUserId) {
      return NextResponse.json({ error: "target user required" }, { status: 400 });
    }

    if (targetUserId === user.id) {
      return NextResponse.json({ error: "invalid target" }, { status: 400 });
    }

    const pairFilter = `and(requester_id.eq.${user.id},requested_id.eq.${targetUserId}),and(requester_id.eq.${targetUserId},requested_id.eq.${user.id})`;

    const { data: relation, error: relationErr } = await supabaseAdmin
      .from("keep_in_touch_requests")
      .select("id")
      .eq("status", "accepted")
      .or(pairFilter)
      .maybeSingle();

    if (relationErr) {
      return NextResponse.json({ error: "touch check failed" }, { status: 500 });
    }

    if (!relation?.id) {
      return NextResponse.json({ error: "not in touch" }, { status: 403 });
    }

    const [participantA, participantB] =
      user.id.localeCompare(targetUserId) <= 0
        ? [user.id, targetUserId]
        : [targetUserId, user.id];

    const nowIso = new Date().toISOString();

    const { data: chatRow, error: upsertErr } = await supabaseAdmin
      .from("direct_chats")
      .upsert(
        {
          participant_a: participantA,
          participant_b: participantB,
          updated_at: nowIso,
        },
        { onConflict: "participant_a,participant_b" }
      )
      .select("id, participant_a, participant_b, updated_at")
      .single();

    if (upsertErr || !chatRow) {
      return NextResponse.json({ error: "chat create failed" }, { status: 500 });
    }

    const { data: targetProfile } = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username, avatar_url")
      .eq("id", targetUserId)
      .maybeSingle();

    if (!targetProfile?.username) {
      return NextResponse.json({ error: "target profile missing" }, { status: 404 });
    }

    return NextResponse.json({
      chat: {
        chat_id: (chatRow as DirectChatRow).id,
        other_user_id: targetUserId,
        username: targetProfile.username,
        avatar_url: targetProfile.avatar_url ?? null,
        updated_at: (chatRow as DirectChatRow).updated_at,
      },
    });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
