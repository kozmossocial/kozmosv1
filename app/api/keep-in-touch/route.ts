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

    let profilesMap: Record<string, ProfileRow> = {};

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

    const inTouch = Array.from(touchIds)
      .map((id) => profilesMap[id])
      .filter((row): row is ProfileRow => Boolean(row))
      .sort((a, b) => a.username.localeCompare(b.username, "en", { sensitivity: "base" }))
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
