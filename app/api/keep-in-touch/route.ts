import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { authenticateUser } from "./_auth";

type LinkRow = {
  id: number;
  requester_id: string;
  requested_id: string;
  status: "pending" | "accepted" | "declined";
};

type ProfileRow = {
  id: string;
  username: string;
  avatar_url: string | null;
};

type OrderRow = {
  contact_user_id: string;
  sort_order: number;
};

export async function GET(req: Request) {
  try {
    const user = await authenticateUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { data: links, error: linksErr } = await supabaseAdmin
      .from("keep_in_touch_requests")
      .select("id, requester_id, requested_id, status")
      .or(`requester_id.eq.${user.id},requested_id.eq.${user.id}`)
      .order("updated_at", { ascending: false });

    if (linksErr) {
      return NextResponse.json({ error: "links query failed" }, { status: 500 });
    }

    const touchIds = new Set<string>();
    const incomingRequests: Array<{ id: number; userId: string }> = [];

    (links as LinkRow[] | null)?.forEach((row) => {
      if (row.status === "accepted") {
        const otherId =
          row.requester_id === user.id ? row.requested_id : row.requester_id;
        if (otherId) {
          touchIds.add(otherId);
        }
      }

      if (row.status === "pending" && row.requested_id === user.id) {
        incomingRequests.push({ id: row.id, userId: row.requester_id });
      }
    });

    const profileIds = Array.from(
      new Set([...Array.from(touchIds), ...incomingRequests.map((r) => r.userId)])
    );

    const profilesMap: Record<string, ProfileRow> = {};

    if (profileIds.length > 0) {
      const { data: profiles, error: profileErr } = await supabaseAdmin
        .from("profileskozmos")
        .select("id, username, avatar_url")
        .in("id", profileIds);

      if (profileErr) {
        return NextResponse.json(
          { error: "profiles query failed" },
          { status: 500 }
        );
      }

      (profiles as ProfileRow[] | null)?.forEach((profile) => {
        profilesMap[profile.id] = profile;
      });
    }

    const touchIdList = Array.from(touchIds);
    const orderMap: Record<string, number> = {};

    if (touchIdList.length > 0) {
      const { data: orders, error: ordersErr } = await supabaseAdmin
        .from("keep_in_touch_orders")
        .select("contact_user_id, sort_order")
        .eq("user_id", user.id)
        .in("contact_user_id", touchIdList);

      if (ordersErr) {
        return NextResponse.json({ error: "orders query failed" }, { status: 500 });
      }

      (orders as OrderRow[] | null)?.forEach((row) => {
        orderMap[row.contact_user_id] = Number(row.sort_order) || 0;
      });
    }

    const inTouch = touchIdList
      .map((id) => profilesMap[id])
      .filter((row): row is ProfileRow => Boolean(row))
      .sort((a, b) => {
        const orderA =
          typeof orderMap[a.id] === "number" ? orderMap[a.id] : Number.MAX_SAFE_INTEGER;
        const orderB =
          typeof orderMap[b.id] === "number" ? orderMap[b.id] : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        return a.username.localeCompare(b.username, "en", { sensitivity: "base" });
      })
      .map((row) => ({
        id: row.id,
        username: row.username,
        avatar_url: row.avatar_url ?? null,
      }));

    const incoming = incomingRequests
      .map((reqRow) => {
        const profile = profilesMap[reqRow.userId];
        if (!profile?.username) return null;
        return {
          id: reqRow.id,
          username: profile.username,
          avatar_url: profile.avatar_url ?? null,
        };
      })
      .filter(
        (row): row is { id: number; username: string; avatar_url: string | null } =>
          Boolean(row)
      )
      .sort((a, b) => a.username.localeCompare(b.username, "en", { sensitivity: "base" }))
      .map((row) => ({
        id: row.id,
        username: row.username,
        avatar_url: row.avatar_url,
      }));

    return NextResponse.json({ inTouch, incoming });
  } catch {
    return NextResponse.json({ error: "request failed" }, { status: 500 });
  }
}
