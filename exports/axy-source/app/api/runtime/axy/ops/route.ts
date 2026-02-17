import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireRuntimeCapability, type RuntimeActor } from "@/app/api/runtime/_capabilities";

const AXY_SUPER_CAPABILITY = "axy.super";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MATRIX_WORLD_LIMIT = 14;

type TouchLinkRow = {
  id: number;
  requester_id: string;
  requested_id: string;
  status: "pending" | "accepted" | "declined";
  updated_at?: string;
};

type ProfileRow = {
  id: string;
  username: string;
  avatar_url: string | null;
};

type DirectChatRow = {
  id: string;
  participant_a: string;
  participant_b: string;
  updated_at: string;
};

type DirectChatMessageRow = {
  id: number;
  chat_id: string;
  sender_id: string;
  content: string;
  created_at: string;
};

type HushChatRow = {
  id: string;
  created_by: string;
  status: "open" | "closed";
  created_at: string;
};

type HushMemberRow = {
  id: number;
  chat_id: string;
  user_id: string;
  role: "owner" | "member";
  status: "invited" | "accepted" | "declined" | "left" | "removed" | "requested";
  display_name: string | null;
  created_at: string;
};

type HushMessageRow = {
  id: string;
  chat_id: string;
  user_id: string;
  content: string;
  created_at: string;
};

type BuildSpaceRow = {
  id: string;
  owner_id: string;
  title: string;
  is_public: boolean;
  language_pref: string;
  description: string;
  updated_at: string;
};

type BuildSpaceAccessRow = {
  space_id: string;
  user_id: string;
  can_edit: boolean;
};

type BuildFileRow = {
  id: number;
  path: string;
  content: string;
  language: string;
  updated_at: string;
};

type RuntimePresenceMatrixRow = {
  user_id: string;
  last_seen_at: string;
  matrix_x: number | null;
  matrix_z: number | null;
  matrix_updated_at: string | null;
};

function isUuid(input: string) {
  return UUID_RE.test(input);
}

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asSafeUuid(value: unknown) {
  const raw = asTrimmedString(value);
  return isUuid(raw) ? raw : "";
}

function asSafeBool(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeBuildPath(input: unknown) {
  return asTrimmedString(input).replace(/\\/g, "/").replace(/^\/+/, "");
}

function sanitizeHexColor(input: string) {
  const color = input.trim();
  return /^#[0-9A-Fa-f]{6}$/.test(color) ? color.toLowerCase() : null;
}

function clampMatrix(value: number) {
  return Math.max(-MATRIX_WORLD_LIMIT, Math.min(MATRIX_WORLD_LIMIT, value));
}

function isHushActiveMemberStatus(status: string) {
  return status !== "declined" && status !== "removed" && status !== "left";
}

function isHushLabelStatus(status: string) {
  return status !== "declined" && status !== "requested" && status !== "removed" && status !== "left";
}

async function listNotes(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("notes")
    .select("id, content, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw new Error("notes list failed");
  return data || [];
}

async function createNote(userId: string, content: string) {
  if (!content) {
    throw new Error("note content required");
  }

  const { data, error } = await supabaseAdmin
    .from("notes")
    .insert({
      user_id: userId,
      content: content.slice(0, 4000),
    })
    .select("id, content, created_at")
    .single();

  if (error || !data) throw new Error("note create failed");
  return data;
}

async function deleteNote(userId: string, noteId: string) {
  if (!noteId) {
    throw new Error("note id required");
  }

  const { error } = await supabaseAdmin
    .from("notes")
    .delete()
    .eq("id", noteId)
    .eq("user_id", userId);

  if (error) throw new Error("note delete failed");
  return { ok: true };
}

async function loadHushContext(userId: string) {
  const { data: chats, error: chatsErr } = await supabaseAdmin
    .from("hush_chats")
    .select("id, created_by, status, created_at")
    .eq("status", "open")
    .order("created_at", { ascending: false });

  if (chatsErr) throw new Error("hush chat list failed");
  const openChats = (chats || []) as HushChatRow[];
  if (openChats.length === 0) {
    return {
      chats: [] as HushChatRow[],
      members: [] as HushMemberRow[],
      userMap: {} as Record<string, string>,
      myMembershipMap: {} as Record<string, HushMemberRow>,
      invitesForMe: [] as HushMemberRow[],
      requestsForMyChats: [] as HushMemberRow[],
    };
  }

  const chatIds = openChats.map((chat) => chat.id);
  const { data: members, error: membersErr } = await supabaseAdmin
    .from("hush_chat_members")
    .select("id, chat_id, user_id, role, status, display_name, created_at")
    .in("chat_id", chatIds);

  if (membersErr) throw new Error("hush member list failed");
  const allMembers = (members || []) as HushMemberRow[];

  const userMap: Record<string, string> = {};
  allMembers.forEach((member) => {
    if (member.display_name) {
      userMap[member.user_id] = member.display_name;
    }
  });

  const allUserIds = Array.from(new Set(allMembers.map((m) => m.user_id)));
  const missingIds = allUserIds.filter((id) => !userMap[id]);
  if (missingIds.length > 0) {
    const { data: profiles, error: profileErr } = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username")
      .in("id", missingIds);
    if (profileErr) throw new Error("hush profile list failed");
    (profiles || []).forEach((profile) => {
      const profileId = String((profile as { id: string }).id);
      const profileUsername = String((profile as { username: string }).username);
      userMap[profileId] = profileUsername;
    });
  }

  const myMembershipMap: Record<string, HushMemberRow> = {};
  allMembers.forEach((member) => {
    if (member.user_id === userId) {
      myMembershipMap[member.chat_id] = member;
    }
  });

  const myHushChatIds = openChats.filter((chat) => chat.created_by === userId).map((chat) => chat.id);
  const invitesForMe = allMembers.filter(
    (member) => member.user_id === userId && member.status === "invited"
  );
  const requestsForMyChats = allMembers.filter(
    (member) => member.status === "requested" && myHushChatIds.includes(member.chat_id)
  );

  return {
    chats: openChats,
    members: allMembers,
    userMap,
    myMembershipMap,
    invitesForMe,
    requestsForMyChats,
  };
}

function getHushChatLabel(chatId: string, members: HushMemberRow[], userMap: Record<string, string>) {
  const activeMembers = members.filter(
    (member) => member.chat_id === chatId && isHushLabelStatus(member.status)
  );
  const names = activeMembers
    .map((member) => userMap[member.user_id] || "user")
    .filter(Boolean);
  return names.length > 0 ? names.join(" + ") : "hush";
}

async function listHush(userId: string) {
  const ctx = await loadHushContext(userId);

  const chats = ctx.chats.map((chat) => {
    const myMembership = ctx.myMembershipMap[chat.id] || null;
    const canRequestJoin = !myMembership
      ? true
      : myMembership.status === "declined" ||
        myMembership.status === "left" ||
        myMembership.status === "removed";

    return {
      id: chat.id,
      created_by: chat.created_by,
      status: chat.status,
      created_at: chat.created_at,
      label: getHushChatLabel(chat.id, ctx.members, ctx.userMap),
      membership_status: myMembership?.status || null,
      membership_role: myMembership?.role || null,
      can_request_join: canRequestJoin,
    };
  });

  const invitesForMe = ctx.invitesForMe.map((invite) => ({
    id: invite.id,
    chat_id: invite.chat_id,
    from: getHushChatLabel(invite.chat_id, ctx.members, ctx.userMap),
  }));

  const requestsForMe = ctx.requestsForMyChats.map((reqRow) => ({
    id: reqRow.id,
    chat_id: reqRow.chat_id,
    user_id: reqRow.user_id,
    username: ctx.userMap[reqRow.user_id] || "user",
  }));

  return { chats, invitesForMe, requestsForMe };
}

async function createHushWith(userId: string, targetUserId: string) {
  if (!targetUserId || !isUuid(targetUserId)) throw new Error("invalid target user id");
  if (targetUserId === userId) throw new Error("invalid target");

  const { data: profiles, error: profileErr } = await supabaseAdmin
    .from("profileskozmos")
    .select("id, username")
    .in("id", [userId, targetUserId]);

  if (profileErr) throw new Error("profile lookup failed");
  const profileMap: Record<string, string> = {};
  (profiles || []).forEach((row) => {
    const profileId = String((row as { id: string }).id);
    const profileUsername = String((row as { username: string }).username);
    profileMap[profileId] = profileUsername;
  });

  if (!profileMap[userId] || !profileMap[targetUserId]) {
    throw new Error("target user not found");
  }

  const { data: chat, error: chatErr } = await supabaseAdmin
    .from("hush_chats")
    .insert({ created_by: userId })
    .select("id, created_by, status, created_at")
    .single();

  if (chatErr || !chat?.id) throw new Error("hush create failed");

  const { error: memberErr } = await supabaseAdmin.from("hush_chat_members").insert([
    {
      chat_id: chat.id,
      user_id: userId,
      role: "owner",
      status: "accepted",
      display_name: profileMap[userId],
    },
    {
      chat_id: chat.id,
      user_id: targetUserId,
      role: "member",
      status: "invited",
      display_name: profileMap[targetUserId],
    },
  ]);

  if (memberErr) throw new Error("hush member insert failed");

  return chat;
}

async function inviteToHush(userId: string, chatId: string, targetUserId: string) {
  if (!chatId) throw new Error("chat id required");
  if (!targetUserId || !isUuid(targetUserId)) throw new Error("invalid target user id");
  if (targetUserId === userId) throw new Error("invalid target");

  const { data: ownerMember, error: ownerErr } = await supabaseAdmin
    .from("hush_chat_members")
    .select("id, role, status")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .maybeSingle();

  if (ownerErr || !ownerMember) throw new Error("forbidden");
  if (
    String((ownerMember as { role?: string }).role) !== "owner" ||
    String((ownerMember as { status?: string }).status) !== "accepted"
  ) {
    throw new Error("forbidden");
  }

  const { data: targetProfile, error: targetErr } = await supabaseAdmin
    .from("profileskozmos")
    .select("id, username")
    .eq("id", targetUserId)
    .maybeSingle();

  if (targetErr || !targetProfile?.id) throw new Error("target user not found");

  const { error: inviteErr } = await supabaseAdmin
    .from("hush_chat_members")
    .upsert(
      {
        chat_id: chatId,
        user_id: targetUserId,
        role: "member",
        status: "invited",
        display_name: targetProfile.username || "user",
      },
      { onConflict: "chat_id,user_id" }
    );

  if (inviteErr) throw new Error("hush invite failed");
  return { ok: true };
}

async function requestHushJoin(userId: string, chatId: string) {
  if (!chatId) throw new Error("chat id required");

  const { data: myMembership, error: membershipErr } = await supabaseAdmin
    .from("hush_chat_members")
    .select("id, status")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .maybeSingle();

  if (membershipErr) throw new Error("hush membership check failed");

  const myStatus = String((myMembership as { status?: string } | null)?.status || "");
  const canRequest =
    !myMembership || myStatus === "declined" || myStatus === "left" || myStatus === "removed";
  if (!canRequest) throw new Error("cannot request join");

  const { data: actorProfile, error: actorErr } = await supabaseAdmin
    .from("profileskozmos")
    .select("id, username")
    .eq("id", userId)
    .maybeSingle();

  if (actorErr || !actorProfile?.id) throw new Error("profile not found");

  const { error: upsertErr } = await supabaseAdmin.from("hush_chat_members").upsert(
    {
      chat_id: chatId,
      user_id: userId,
      role: "member",
      status: "requested",
      display_name: actorProfile.username || "user",
    },
    { onConflict: "chat_id,user_id" }
  );

  if (upsertErr) throw new Error("hush request failed");
  return { ok: true };
}

async function resolveHushRequest(
  userId: string,
  chatId: string,
  memberUserId: string,
  accept: boolean
) {
  if (!chatId) throw new Error("chat id required");
  if (!memberUserId || !isUuid(memberUserId)) throw new Error("invalid member user id");

  const { data: ownerMember, error: ownerErr } = await supabaseAdmin
    .from("hush_chat_members")
    .select("id, role, status")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .maybeSingle();

  if (ownerErr || !ownerMember) throw new Error("forbidden");
  if (
    String((ownerMember as { role?: string }).role) !== "owner" ||
    String((ownerMember as { status?: string }).status) !== "accepted"
  ) {
    throw new Error("forbidden");
  }

  const { data: targetMember, error: targetErr } = await supabaseAdmin
    .from("hush_chat_members")
    .select("id, status")
    .eq("chat_id", chatId)
    .eq("user_id", memberUserId)
    .maybeSingle();

  if (targetErr || !targetMember) throw new Error("request not found");
  if (String((targetMember as { status?: string }).status) !== "requested") {
    throw new Error("request not pending");
  }

  const { error: updateErr } = await supabaseAdmin
    .from("hush_chat_members")
    .update({ status: accept ? "accepted" : "declined" })
    .eq("chat_id", chatId)
    .eq("user_id", memberUserId);

  if (updateErr) throw new Error("hush request update failed");
  return { ok: true, status: accept ? "accepted" : "declined" };
}

async function respondToHushInvite(userId: string, chatId: string, accept: boolean) {
  if (!chatId) throw new Error("chat id required");

  const { data: row, error: rowErr } = await supabaseAdmin
    .from("hush_chat_members")
    .select("id, status")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .maybeSingle();

  if (rowErr || !row) throw new Error("invite not found");
  if (String((row as { status?: string }).status) !== "invited") {
    throw new Error("invite not pending");
  }

  const { error: updateErr } = await supabaseAdmin
    .from("hush_chat_members")
    .update({ status: accept ? "accepted" : "declined" })
    .eq("chat_id", chatId)
    .eq("user_id", userId);

  if (updateErr) throw new Error("hush invite update failed");
  return { ok: true, status: accept ? "accepted" : "declined" };
}

async function leaveHushChat(userId: string, chatId: string) {
  if (!chatId) throw new Error("chat id required");

  const { data: myMembership, error: myErr } = await supabaseAdmin
    .from("hush_chat_members")
    .select("id, role, status")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .maybeSingle();

  if (myErr || !myMembership) throw new Error("membership not found");

  const { data: members, error: membersErr } = await supabaseAdmin
    .from("hush_chat_members")
    .select("id, status")
    .eq("chat_id", chatId);

  if (membersErr) throw new Error("hush member list failed");
  const activeMembers = (members as Array<{ id: number; status: string }> | null)?.filter((m) =>
    isHushActiveMemberStatus(m.status)
  ) || [];

  const { error: leaveErr } = await supabaseAdmin
    .from("hush_chat_members")
    .update({ status: "left" })
    .eq("chat_id", chatId)
    .eq("user_id", userId);

  if (leaveErr) throw new Error("hush leave failed");

  if (
    String((myMembership as { role?: string }).role) === "owner" &&
    activeMembers.length <= 2
  ) {
    await supabaseAdmin
      .from("hush_chats")
      .update({ status: "closed" })
      .eq("id", chatId);
  }

  return { ok: true };
}

async function removeHushMember(userId: string, chatId: string, memberUserId: string) {
  if (!chatId) throw new Error("chat id required");
  if (!memberUserId || !isUuid(memberUserId)) throw new Error("invalid member user id");
  if (memberUserId === userId) throw new Error("cannot remove self");

  const { data: ownerMember, error: ownerErr } = await supabaseAdmin
    .from("hush_chat_members")
    .select("id, role, status")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .maybeSingle();

  if (ownerErr || !ownerMember) throw new Error("forbidden");
  if (
    String((ownerMember as { role?: string }).role) !== "owner" ||
    String((ownerMember as { status?: string }).status) !== "accepted"
  ) {
    throw new Error("forbidden");
  }

  const { error: updateErr } = await supabaseAdmin
    .from("hush_chat_members")
    .update({ status: "removed" })
    .eq("chat_id", chatId)
    .eq("user_id", memberUserId);

  if (updateErr) throw new Error("hush remove member failed");
  return { ok: true };
}

async function listHushMessages(userId: string, chatId: string, limit: number) {
  if (!chatId) throw new Error("chat id required");
  const safeLimit = Math.max(1, Math.min(300, Math.floor(limit || 200)));

  const { data: myMembership, error: memberErr } = await supabaseAdmin
    .from("hush_chat_members")
    .select("id, status")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .maybeSingle();

  if (memberErr || !myMembership) throw new Error("forbidden");
  if (String((myMembership as { status?: string }).status) !== "accepted") {
    throw new Error("forbidden");
  }

  const { data: messages, error: msgErr } = await supabaseAdmin
    .from("hush_chat_messages")
    .select("id, chat_id, user_id, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(safeLimit);

  if (msgErr) throw new Error("hush message list failed");

  const rows = (messages || []) as HushMessageRow[];
  const userIds = Array.from(new Set(rows.map((row) => row.user_id)));
  const memberNames: Record<string, string> = {};

  if (userIds.length > 0) {
    const { data: memberships } = await supabaseAdmin
      .from("hush_chat_members")
      .select("user_id, display_name")
      .eq("chat_id", chatId)
      .in("user_id", userIds);

    (memberships || []).forEach((member) => {
      const mUserId = String((member as { user_id: string }).user_id);
      const displayName = asTrimmedString((member as { display_name?: unknown }).display_name);
      if (displayName) memberNames[mUserId] = displayName;
    });

    const missing = userIds.filter((id) => !memberNames[id]);
    if (missing.length > 0) {
      const { data: profiles } = await supabaseAdmin
        .from("profileskozmos")
        .select("id, username")
        .in("id", missing);

      (profiles || []).forEach((profile) => {
        const pId = String((profile as { id: string }).id);
        memberNames[pId] = String((profile as { username: string }).username);
      });
    }
  }

  return rows.map((row) => ({
    ...row,
    username: memberNames[row.user_id] || "user",
  }));
}

async function sendHushMessage(userId: string, chatId: string, content: string) {
  if (!chatId) throw new Error("chat id required");
  if (!content) throw new Error("content required");

  const { data: myMembership, error: memberErr } = await supabaseAdmin
    .from("hush_chat_members")
    .select("id, status")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .maybeSingle();

  if (memberErr || !myMembership) throw new Error("forbidden");
  if (String((myMembership as { status?: string }).status) !== "accepted") {
    throw new Error("forbidden");
  }

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("hush_chat_messages")
    .insert({
      chat_id: chatId,
      user_id: userId,
      content: content.slice(0, 2000),
    })
    .select("id, chat_id, user_id, content, created_at")
    .single();

  if (insertErr || !inserted) throw new Error("hush send failed");
  return inserted;
}

const KOZMOS_PLAY_CATALOG = [
  {
    id: "signal-drift",
    title: "signal drift",
    status: "active",
    objective: "catch the pulse",
  },
  {
    id: "slow-orbit",
    title: "slow orbit",
    status: "active",
    objective: "sync at the pulse",
  },
  {
    id: "hush-puzzle",
    title: "hush puzzle",
    status: "active",
    objective: "align the quiet pattern",
  },
] as const;

type BuildSpaceAccessCheck = {
  space: { id: string; owner_id: string; is_public: boolean } | null;
  canRead: boolean;
  canEdit: boolean;
  isOwner: boolean;
};

async function getBuildSpaceAccess(spaceId: string, userId: string): Promise<BuildSpaceAccessCheck> {
  const { data: space, error: spaceErr } = await supabaseAdmin
    .from("user_build_spaces")
    .select("id, owner_id, is_public")
    .eq("id", spaceId)
    .maybeSingle();

  if (spaceErr) throw new Error("build access check failed");
  if (!space) return { space: null, canRead: false, canEdit: false, isOwner: false };

  const isOwner = String((space as { owner_id: string }).owner_id) === userId;
  if (isOwner) {
    return { space, canRead: true, canEdit: true, isOwner: true };
  }

  const { data: accessRow, error: accessErr } = await supabaseAdmin
    .from("user_build_space_access")
    .select("can_edit")
    .eq("space_id", spaceId)
    .eq("user_id", userId)
    .maybeSingle();

  if (accessErr) throw new Error("build access check failed");

  const hasSharedAccess = Boolean(accessRow);
  const canRead = Boolean((space as { is_public: boolean }).is_public) || hasSharedAccess;
  const canEdit = Boolean((accessRow as { can_edit?: boolean } | null)?.can_edit);
  return { space, canRead, canEdit, isOwner: false };
}

async function assertBuildOwner(spaceId: string, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_build_spaces")
    .select("id")
    .eq("id", spaceId)
    .eq("owner_id", userId)
    .maybeSingle();

  if (error) throw new Error("build owner check failed");
  if (!data?.id) throw new Error("forbidden");
}

async function resolveProfileIdByUsername(username: string) {
  if (!username) return null;

  let { data: profile, error } = await supabaseAdmin
    .from("profileskozmos")
    .select("id")
    .eq("username", username)
    .maybeSingle();

  if (error) throw new Error("profile lookup failed");

  if (!profile?.id) {
    const fallback = await supabaseAdmin
      .from("profileskozmos")
      .select("id")
      .ilike("username", username)
      .limit(1)
      .maybeSingle();
    if (fallback.error) throw new Error("profile lookup failed");
    profile = fallback.data;
  }

  return profile?.id ? String(profile.id) : null;
}

async function listBuildSpaces(userId: string) {
  const select =
    "id, owner_id, title, is_public, language_pref, description, updated_at";

  const { data: own, error: ownErr } = await supabaseAdmin
    .from("user_build_spaces")
    .select(select)
    .eq("owner_id", userId);
  if (ownErr) throw new Error("build spaces load failed");

  const { data: publicRows, error: publicErr } = await supabaseAdmin
    .from("user_build_spaces")
    .select(select)
    .eq("is_public", true)
    .neq("owner_id", userId);
  if (publicErr) throw new Error("build spaces load failed");

  const { data: sharedAccess, error: sharedErr } = await supabaseAdmin
    .from("user_build_space_access")
    .select("space_id, can_edit")
    .eq("user_id", userId);
  if (sharedErr) throw new Error("build spaces load failed");

  const sharedEditMap = new Map<string, boolean>();
  (sharedAccess as BuildSpaceAccessRow[] | null)?.forEach((row) => {
    if (!row.space_id) return;
    sharedEditMap.set(row.space_id, row.can_edit === true);
  });

  const sharedIds = Array.from(
    new Set((sharedAccess || []).map((row) => row.space_id).filter(Boolean))
  );

  let sharedSpaces: BuildSpaceRow[] = [];
  if (sharedIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("user_build_spaces")
      .select(select)
      .in("id", sharedIds);
    if (error) throw new Error("build spaces load failed");
    sharedSpaces = (data || []) as BuildSpaceRow[];
  }

  const merged = new Map<string, BuildSpaceRow>();
  [...((own || []) as BuildSpaceRow[]), ...((publicRows || []) as BuildSpaceRow[]), ...sharedSpaces].forEach(
    (row) => {
      merged.set(row.id, row);
    }
  );

  const rows = Array.from(merged.values()).sort((a, b) =>
    (b.updated_at || "").localeCompare(a.updated_at || "")
  );

  const ownerIds = Array.from(new Set(rows.map((row) => row.owner_id)));
  const ownerMap: Record<string, string> = {};
  if (ownerIds.length > 0) {
    const { data: owners, error: ownersErr } = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username")
      .in("id", ownerIds);
    if (ownersErr) throw new Error("build owner lookup failed");
    (owners || []).forEach((owner) => {
      const ownerId = String((owner as { id: string }).id);
      ownerMap[ownerId] = String((owner as { username: string }).username);
    });
  }

  return rows.map((row) => ({
    ...row,
    owner_username: ownerMap[row.owner_id] || "user",
    can_edit: row.owner_id === userId || sharedEditMap.get(row.id) === true,
  }));
}

async function createBuildSpace(
  userId: string,
  titleInput: string,
  languagePrefInput: string,
  descriptionInput: string
) {
  const title = titleInput || "subspace";
  const languagePref = languagePrefInput || "auto";
  const description = descriptionInput;

  const { data, error } = await supabaseAdmin
    .from("user_build_spaces")
    .insert({
      owner_id: userId,
      title,
      language_pref: languagePref,
      description,
    })
    .select("id, owner_id, title, is_public, language_pref, description, updated_at")
    .single();

  if (error || !data) throw new Error("build space create failed");
  return { ...data, can_edit: true };
}

async function updateBuildSpace(
  userId: string,
  spaceId: string,
  updates: {
    title?: string;
    languagePref?: string;
    description?: string;
    isPublic?: boolean;
  }
) {
  if (!spaceId) throw new Error("space id required");
  await assertBuildOwner(spaceId, userId);

  const patch: Record<string, unknown> = {};
  if (typeof updates.title === "string") patch.title = updates.title || "subspace";
  if (typeof updates.languagePref === "string") patch.language_pref = updates.languagePref || "auto";
  if (typeof updates.description === "string") patch.description = updates.description;
  if (typeof updates.isPublic === "boolean") patch.is_public = updates.isPublic;
  if (Object.keys(patch).length === 0) throw new Error("no updates provided");

  const { data, error } = await supabaseAdmin
    .from("user_build_spaces")
    .update(patch)
    .eq("id", spaceId)
    .select("id, owner_id, title, is_public, language_pref, description, updated_at")
    .single();

  if (error || !data) throw new Error("build space update failed");
  return { ...data, can_edit: true };
}

async function deleteBuildSpace(userId: string, spaceId: string) {
  if (!spaceId) throw new Error("space id required");
  await assertBuildOwner(spaceId, userId);

  const { error } = await supabaseAdmin
    .from("user_build_spaces")
    .delete()
    .eq("id", spaceId);

  if (error) throw new Error("build space delete failed");
  return { ok: true };
}

async function listBuildFiles(userId: string, spaceId: string) {
  if (!spaceId) throw new Error("space id required");
  const access = await getBuildSpaceAccess(spaceId, userId);
  if (!access.space || !access.canRead) throw new Error("forbidden");

  const { data, error } = await supabaseAdmin
    .from("user_build_files")
    .select("id, path, content, language, updated_at")
    .eq("space_id", spaceId)
    .order("updated_at", { ascending: false });

  if (error) throw new Error("build files load failed");
  return {
    files: (data || []) as BuildFileRow[],
    can_edit: access.canEdit,
    is_owner: access.isOwner,
  };
}

async function createBuildFile(
  userId: string,
  spaceId: string,
  pathInput: string,
  languageInput: string
) {
  if (!spaceId) throw new Error("space id required");
  const path = normalizeBuildPath(pathInput);
  if (!path) throw new Error("path required");

  const access = await getBuildSpaceAccess(spaceId, userId);
  if (!access.space || !access.canEdit) throw new Error("forbidden");

  const { data: existing, error: existingErr } = await supabaseAdmin
    .from("user_build_files")
    .select("id")
    .eq("space_id", spaceId)
    .eq("path", path)
    .maybeSingle();
  if (existingErr) throw new Error("build file create failed");

  if (existing?.id) return { ok: true, existed: true, path };

  const { error } = await supabaseAdmin.from("user_build_files").insert({
    space_id: spaceId,
    path,
    content: "",
    language: languageInput || "text",
    updated_by: userId,
  });

  if (error) throw new Error("build file create failed");
  return { ok: true, existed: false, path };
}

async function saveBuildFile(
  userId: string,
  spaceId: string,
  pathInput: string,
  content: string,
  languageInput: string
) {
  if (!spaceId) throw new Error("space id required");
  const path = normalizeBuildPath(pathInput);
  if (!path) throw new Error("path required");

  const access = await getBuildSpaceAccess(spaceId, userId);
  if (!access.space || !access.canEdit) throw new Error("forbidden");

  const { error } = await supabaseAdmin.from("user_build_files").upsert(
    {
      space_id: spaceId,
      path,
      content,
      language: languageInput || "text",
      updated_by: userId,
    },
    { onConflict: "space_id,path" }
  );

  if (error) throw new Error("build file save failed");
  return { ok: true, path };
}

async function deleteBuildFile(userId: string, spaceId: string, pathInput: string) {
  if (!spaceId) throw new Error("space id required");
  const path = normalizeBuildPath(pathInput);
  if (!path) throw new Error("path required");

  const access = await getBuildSpaceAccess(spaceId, userId);
  if (!access.space || !access.canEdit) throw new Error("forbidden");

  const { error } = await supabaseAdmin
    .from("user_build_files")
    .delete()
    .eq("space_id", spaceId)
    .eq("path", path);

  if (error) throw new Error("build file delete failed");
  return { ok: true };
}

async function listBuildAccess(userId: string, spaceId: string) {
  if (!spaceId) throw new Error("space id required");
  await assertBuildOwner(spaceId, userId);

  const { data, error } = await supabaseAdmin
    .from("user_build_space_access")
    .select("user_id, can_edit")
    .eq("space_id", spaceId)
    .order("created_at", { ascending: false });
  if (error) throw new Error("build access list failed");

  const userIds = Array.from(new Set((data || []).map((row) => row.user_id).filter(Boolean)));
  const nameMap = new Map<string, { username: string; avatar_url: string | null }>();
  if (userIds.length > 0) {
    const { data: profiles, error: profilesErr } = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username, avatar_url")
      .in("id", userIds);
    if (profilesErr) throw new Error("build access list failed");
    (profiles || []).forEach((profile) => {
      const id = String((profile as { id: string }).id);
      const username = String((profile as { username: string }).username);
      const avatarUrl = (profile as { avatar_url?: string | null }).avatar_url ?? null;
      nameMap.set(id, { username, avatar_url: avatarUrl });
    });
  }

  return (data || []).map((row) => {
    const userIdValue = String((row as { user_id: string }).user_id);
    const profile = nameMap.get(userIdValue);
    return {
      user_id: userIdValue,
      username: profile?.username || "user",
      avatar_url: profile?.avatar_url ?? null,
      can_edit: Boolean((row as { can_edit?: boolean }).can_edit),
    };
  });
}

async function grantBuildAccess(
  userId: string,
  spaceId: string,
  targetUsername: string,
  canEdit: boolean
) {
  if (!spaceId) throw new Error("space id required");
  if (!targetUsername) throw new Error("target username required");
  await assertBuildOwner(spaceId, userId);

  const targetUserId = await resolveProfileIdByUsername(targetUsername);
  if (!targetUserId) throw new Error("target user not found");
  if (targetUserId === userId) throw new Error("cannot grant yourself");

  const { error } = await supabaseAdmin
    .from("user_build_space_access")
    .upsert(
      {
        space_id: spaceId,
        user_id: targetUserId,
        can_edit: canEdit,
        granted_by: userId,
      },
      { onConflict: "space_id,user_id" }
    );

  if (error) throw new Error("build access grant failed");
  return { ok: true };
}

async function revokeBuildAccess(userId: string, spaceId: string, targetUsername: string) {
  if (!spaceId) throw new Error("space id required");
  if (!targetUsername) throw new Error("target username required");
  await assertBuildOwner(spaceId, userId);

  const targetUserId = await resolveProfileIdByUsername(targetUsername);
  if (!targetUserId) throw new Error("target user not found");

  const { error } = await supabaseAdmin
    .from("user_build_space_access")
    .delete()
    .eq("space_id", spaceId)
    .eq("user_id", targetUserId);

  if (error) throw new Error("build access revoke failed");
  return { ok: true };
}

async function buildSpaceSnapshot(userId: string, spaceId: string) {
  if (!spaceId) throw new Error("space id required");
  const access = await getBuildSpaceAccess(spaceId, userId);
  if (!access.space || !access.canRead) throw new Error("forbidden");

  const { data: space, error: spaceErr } = await supabaseAdmin
    .from("user_build_spaces")
    .select("id, owner_id, title, is_public, language_pref, description, updated_at")
    .eq("id", spaceId)
    .maybeSingle();
  if (spaceErr || !space) throw new Error("build space not found");

  const files = await listBuildFiles(userId, spaceId);
  const accessEntries = access.isOwner ? await listBuildAccess(userId, spaceId) : [];

  return {
    space,
    files: files.files,
    can_edit: files.can_edit,
    is_owner: files.is_owner,
    access: accessEntries,
  };
}

async function getMatrixProfile(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("profileskozmos")
    .select("id, username, orb_color")
    .eq("id", userId)
    .maybeSingle();

  if (error || !data) throw new Error("matrix profile load failed");
  return {
    id: String(data.id),
    username: String(data.username),
    orb_color: String(data.orb_color || "#7df9ff"),
  };
}

async function updateMatrixColor(userId: string, orbColorInput: string) {
  const orbColor = sanitizeHexColor(orbColorInput);
  if (!orbColor) throw new Error("valid hex color required");

  const { data, error } = await supabaseAdmin
    .from("profileskozmos")
    .update({ orb_color: orbColor })
    .eq("id", userId)
    .select("id, username, orb_color")
    .maybeSingle();

  if (error || !data) throw new Error("matrix color update failed");
  return {
    id: String(data.id),
    username: String(data.username),
    orb_color: String(data.orb_color || orbColor),
  };
}

async function getMatrixPosition(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("runtime_presence")
    .select("user_id, matrix_x, matrix_z, matrix_updated_at, last_seen_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    const msg = String(error.message || "");
    if (/matrix_x|matrix_z|matrix_updated_at/i.test(msg)) {
      throw new Error("matrix move schema missing (run migration)");
    }
    throw new Error("matrix position load failed");
  }

  return {
    x: Number((data as RuntimePresenceMatrixRow | null)?.matrix_x ?? 0),
    z: Number((data as RuntimePresenceMatrixRow | null)?.matrix_z ?? 0),
    updated_at: (data as RuntimePresenceMatrixRow | null)?.matrix_updated_at || null,
    last_seen_at: (data as RuntimePresenceMatrixRow | null)?.last_seen_at || null,
  };
}

async function moveMatrix(
  userId: string,
  payload: { x?: unknown; z?: unknown; dx?: unknown; dz?: unknown }
) {
  const current = await getMatrixPosition(userId);

  const hasAbsX = typeof payload.x === "number" && Number.isFinite(payload.x);
  const hasAbsZ = typeof payload.z === "number" && Number.isFinite(payload.z);
  const hasDeltaX = typeof payload.dx === "number" && Number.isFinite(payload.dx);
  const hasDeltaZ = typeof payload.dz === "number" && Number.isFinite(payload.dz);

  if (!hasAbsX && !hasAbsZ && !hasDeltaX && !hasDeltaZ) {
    throw new Error("matrix move requires x/z or dx/dz");
  }

  const baseX = current.x;
  const baseZ = current.z;
  const nextX = clampMatrix(
    hasAbsX ? Number(payload.x) : baseX + (hasDeltaX ? Number(payload.dx) : 0)
  );
  const nextZ = clampMatrix(
    hasAbsZ ? Number(payload.z) : baseZ + (hasDeltaZ ? Number(payload.dz) : 0)
  );
  const nowIso = new Date().toISOString();

  const { error } = await supabaseAdmin.from("runtime_presence").upsert({
    user_id: userId,
    last_seen_at: nowIso,
    matrix_x: nextX,
    matrix_z: nextZ,
    matrix_updated_at: nowIso,
  });

  if (error) {
    const msg = String(error.message || "");
    if (/matrix_x|matrix_z|matrix_updated_at/i.test(msg)) {
      throw new Error("matrix move schema missing (run migration)");
    }
    throw new Error("matrix move failed");
  }

  return { x: nextX, z: nextZ, updated_at: nowIso };
}

async function enterMatrix(userId: string, payload: { x?: unknown; z?: unknown }) {
  const hasX = typeof payload.x === "number" && Number.isFinite(payload.x);
  const hasZ = typeof payload.z === "number" && Number.isFinite(payload.z);
  const nextX = clampMatrix(hasX ? Number(payload.x) : 0);
  const nextZ = clampMatrix(hasZ ? Number(payload.z) : 0);
  const nowIso = new Date().toISOString();

  const { error } = await supabaseAdmin.from("runtime_presence").upsert({
    user_id: userId,
    last_seen_at: nowIso,
    matrix_x: nextX,
    matrix_z: nextZ,
    matrix_updated_at: nowIso,
  });

  if (error) {
    const msg = String(error.message || "");
    if (/matrix_x|matrix_z|matrix_updated_at/i.test(msg)) {
      throw new Error("matrix move schema missing (run migration)");
    }
    throw new Error("matrix enter failed");
  }

  return { x: nextX, z: nextZ, updated_at: nowIso, visible: true };
}

async function exitMatrix(userId: string) {
  const nowIso = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("runtime_presence")
    .update({
      last_seen_at: nowIso,
      matrix_updated_at: null,
    })
    .eq("user_id", userId);

  if (error) {
    const msg = String(error.message || "");
    if (/matrix_updated_at/i.test(msg)) {
      throw new Error("matrix move schema missing (run migration)");
    }
    throw new Error("matrix exit failed");
  }

  return { ok: true, visible: false, updated_at: nowIso };
}

async function listPresentRuntimeUsers() {
  const thresholdIso = new Date(Date.now() - 90 * 1000).toISOString();
  const { data: rows, error } = await supabaseAdmin
    .from("runtime_presence")
    .select("user_id, username, last_seen_at")
    .gte("last_seen_at", thresholdIso)
    .order("last_seen_at", { ascending: false })
    .limit(300);

  if (error) throw new Error("present users load failed");

  const userIds = Array.from(
    new Set(
      (rows || [])
        .map((row) =>
          typeof (row as { user_id?: unknown }).user_id === "string"
            ? (row as { user_id: string }).user_id
            : ""
        )
        .filter(Boolean)
    )
  );
  const profileMap: Record<string, string> = {};

  if (userIds.length > 0) {
    const { data: profiles, error: profileErr } = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username")
      .in("id", userIds);

    if (profileErr) throw new Error("present users profile load failed");
    (profiles || []).forEach((profile) => {
      const id = String((profile as { id: string }).id);
      profileMap[id] = String((profile as { username: string }).username);
    });
  }

  const out = (rows || []).map((row) => {
    const userId =
      typeof (row as { user_id?: unknown }).user_id === "string"
        ? (row as { user_id: string }).user_id
        : "";
    const rowName = asTrimmedString((row as { username?: unknown }).username);
    return {
      user_id: userId,
      username: rowName || profileMap[userId] || "user",
      last_seen_at:
        typeof (row as { last_seen_at?: unknown }).last_seen_at === "string"
          ? (row as { last_seen_at: string }).last_seen_at
          : null,
    };
  });

  const dedup = new Map<string, { user_id: string; username: string; last_seen_at: string | null }>();
  out.forEach((row) => {
    if (!row.user_id) return;
    if (!dedup.has(row.user_id)) dedup.set(row.user_id, row);
  });

  return Array.from(dedup.values());
}

async function listMatrixRuntimeWorld() {
  const { data, error } = await supabaseAdmin
    .from("runtime_presence")
    .select("user_id, last_seen_at, matrix_x, matrix_z, matrix_updated_at")
    .not("matrix_updated_at", "is", null)
    .gte("last_seen_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .order("matrix_updated_at", { ascending: false })
    .limit(200);

  if (error) {
    const msg = String(error.message || "");
    if (/matrix_x|matrix_z|matrix_updated_at/i.test(msg)) {
      throw new Error("matrix move schema missing (run migration)");
    }
    throw new Error("matrix world load failed");
  }

  const rows = (data || []) as RuntimePresenceMatrixRow[];
  if (rows.length === 0) return [];

  const userIds = rows.map((row) => row.user_id);
  const { data: profiles, error: profilesErr } = await supabaseAdmin
    .from("profileskozmos")
    .select("id, username, orb_color")
    .in("id", userIds);
  if (profilesErr) throw new Error("matrix world profile load failed");

  const profileMap: Record<string, { username: string; orb_color: string }> = {};
  (profiles || []).forEach((profile) => {
    const id = String((profile as { id: string }).id);
    const username = String((profile as { username: string }).username || "user");
    const orbColor = String((profile as { orb_color?: string }).orb_color || "#7df9ff");
    profileMap[id] = { username, orb_color: orbColor };
  });

  return rows.map((row) => ({
    user_id: row.user_id,
    username: profileMap[row.user_id]?.username || "user",
    orb_color: profileMap[row.user_id]?.orb_color || "#7df9ff",
    x: Number(row.matrix_x ?? 0),
    z: Number(row.matrix_z ?? 0),
    updated_at: row.matrix_updated_at,
    last_seen_at: row.last_seen_at,
  }));
}

function listKozmosPlay() {
  return KOZMOS_PLAY_CATALOG.map((game) => ({ ...game }));
}

function getKozmosPlayHint(gameIdInput: string) {
  const gameId = asTrimmedString(gameIdInput).toLowerCase();
  const selected =
    KOZMOS_PLAY_CATALOG.find((game) => game.id === gameId) || KOZMOS_PLAY_CATALOG[0];

  const hintByGame: Record<string, string> = {
    "signal-drift": "keep a steady rhythm; short, precise corrections beat fast reactions.",
    "slow-orbit": "move less and commit to timing; over-correction breaks sync.",
    "hush-puzzle": "reduce noise first, then align one quiet pattern at a time.",
  };

  return {
    game: selected,
    hint: hintByGame[selected.id] || "focus on timing and intentional motion.",
  };
}

async function listTouch(userId: string) {
  const { data: links, error: linksErr } = await supabaseAdmin
    .from("keep_in_touch_requests")
    .select("id, requester_id, requested_id, status")
    .or(`requester_id.eq.${userId},requested_id.eq.${userId}`)
    .order("updated_at", { ascending: false });

  if (linksErr) throw new Error("touch list failed");

  const touchIds = new Set<string>();
  const incomingRequests: Array<{ id: number; userId: string }> = [];

  (links as TouchLinkRow[] | null)?.forEach((row) => {
    if (row.status === "accepted") {
      const other = row.requester_id === userId ? row.requested_id : row.requester_id;
      if (other) touchIds.add(other);
    }
    if (row.status === "pending" && row.requested_id === userId) {
      incomingRequests.push({ id: row.id, userId: row.requester_id });
    }
  });

  const profileIds = Array.from(
    new Set([...Array.from(touchIds), ...incomingRequests.map((r) => r.userId)])
  );

  const profileMap: Record<string, ProfileRow> = {};
  if (profileIds.length > 0) {
    const { data: profiles, error: profileErr } = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username, avatar_url")
      .in("id", profileIds);

    if (profileErr) throw new Error("touch profile load failed");
    (profiles as ProfileRow[] | null)?.forEach((p) => {
      profileMap[p.id] = p;
    });
  }

  const touchIdList = Array.from(touchIds);
  const orderMap: Record<string, number> = {};

  if (touchIdList.length > 0) {
    const { data: orders, error: orderErr } = await supabaseAdmin
      .from("keep_in_touch_orders")
      .select("contact_user_id, sort_order")
      .eq("user_id", userId)
      .in("contact_user_id", touchIdList);

    if (orderErr) throw new Error("touch order load failed");
    (orders || []).forEach((row) => {
      const contactUserId =
        typeof (row as { contact_user_id?: unknown }).contact_user_id === "string"
          ? (row as { contact_user_id: string }).contact_user_id
          : "";
      const sortOrder =
        Number((row as { sort_order?: unknown }).sort_order) || Number.MAX_SAFE_INTEGER;
      if (contactUserId) orderMap[contactUserId] = sortOrder;
    });
  }

  const inTouch = touchIdList
    .map((id) => profileMap[id])
    .filter((v): v is ProfileRow => Boolean(v))
    .sort((a, b) => {
      const orderA = typeof orderMap[a.id] === "number" ? orderMap[a.id] : Number.MAX_SAFE_INTEGER;
      const orderB = typeof orderMap[b.id] === "number" ? orderMap[b.id] : Number.MAX_SAFE_INTEGER;
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
      const profile = profileMap[reqRow.userId];
      if (!profile?.username) return null;
      return {
        id: reqRow.id,
        user_id: reqRow.userId,
        username: profile.username,
        avatar_url: profile.avatar_url ?? null,
      };
    })
    .filter(
      (
        row
      ): row is { id: number; user_id: string; username: string; avatar_url: string | null } =>
        Boolean(row)
    )
    .sort((a, b) => a.username.localeCompare(b.username, "en", { sensitivity: "base" }));

  return { inTouch, incoming };
}

async function requestTouch(userId: string, targetUsername: string) {
  if (!targetUsername) throw new Error("target username required");

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

  if (targetErr || !target?.id) throw new Error("user not found");
  if (target.id === userId) throw new Error("cannot keep in touch with yourself");

  const pairFilter = `and(requester_id.eq.${userId},requested_id.eq.${target.id}),and(requester_id.eq.${target.id},requested_id.eq.${userId})`;

  const { data: existing, error: existingErr } = await supabaseAdmin
    .from("keep_in_touch_requests")
    .select("id, requester_id, requested_id, status")
    .or(pairFilter)
    .maybeSingle();

  if (existingErr) throw new Error("touch lookup failed");
  const nowIso = new Date().toISOString();

  if (!existing) {
    const { error: insertErr } = await supabaseAdmin.from("keep_in_touch_requests").insert({
      requester_id: userId,
      requested_id: target.id,
      status: "pending",
      responded_at: null,
    });
    if (insertErr) throw new Error("touch request failed");
    return { ok: true, status: "pending" };
  }

  const row = existing as TouchLinkRow;
  if (row.status === "accepted") return { ok: true, status: "accepted" };

  if (row.status === "pending") {
    if (row.requester_id === userId) return { ok: true, status: "pending" };

    const { error: acceptErr } = await supabaseAdmin
      .from("keep_in_touch_requests")
      .update({
        status: "accepted",
        responded_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", row.id);

    if (acceptErr) throw new Error("touch accept failed");
    return { ok: true, status: "accepted" };
  }

  const { error: reopenErr } = await supabaseAdmin
    .from("keep_in_touch_requests")
    .update({
      requester_id: userId,
      requested_id: target.id,
      status: "pending",
      responded_at: null,
      updated_at: nowIso,
    })
    .eq("id", row.id);

  if (reopenErr) throw new Error("touch request failed");
  return { ok: true, status: "pending" };
}

async function respondTouch(userId: string, requestId: number, accept: boolean) {
  if (!Number.isFinite(requestId) || requestId <= 0) {
    throw new Error("invalid request id");
  }

  const { data: row, error: rowErr } = await supabaseAdmin
    .from("keep_in_touch_requests")
    .select("id, requester_id, requested_id, status")
    .eq("id", requestId)
    .maybeSingle();

  if (rowErr || !row) throw new Error("request not found");

  const link = row as TouchLinkRow;
  if (link.requested_id !== userId) throw new Error("forbidden");
  if (link.status !== "pending") throw new Error("request already resolved");

  const nextStatus = accept ? "accepted" : "declined";
  const nowIso = new Date().toISOString();

  const { error: updateErr } = await supabaseAdmin
    .from("keep_in_touch_requests")
    .update({
      status: nextStatus,
      responded_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", requestId);

  if (updateErr) throw new Error("request update failed");
  return { ok: true, status: nextStatus };
}

async function removeTouch(userId: string, targetUserId: string) {
  if (!targetUserId || !isUuid(targetUserId)) throw new Error("invalid target user id");
  if (targetUserId === userId) throw new Error("invalid target");

  const pairFilter = `and(requester_id.eq.${userId},requested_id.eq.${targetUserId}),and(requester_id.eq.${targetUserId},requested_id.eq.${userId})`;

  const { data: existing, error: existingErr } = await supabaseAdmin
    .from("keep_in_touch_requests")
    .select("id")
    .or(pairFilter)
    .maybeSingle();

  if (existingErr) throw new Error("touch lookup failed");

  if (existing?.id) {
    const { error: deleteErr } = await supabaseAdmin
      .from("keep_in_touch_requests")
      .delete()
      .eq("id", existing.id);
    if (deleteErr) throw new Error("touch remove failed");
  }

  await supabaseAdmin
    .from("keep_in_touch_orders")
    .delete()
    .eq("user_id", userId)
    .eq("contact_user_id", targetUserId);

  await supabaseAdmin
    .from("keep_in_touch_orders")
    .delete()
    .eq("user_id", targetUserId)
    .eq("contact_user_id", userId);

  return { ok: true };
}

async function updateTouchOrder(userId: string, orderedUserIds: string[]) {
  const uniqueIds = Array.from(
    new Set(orderedUserIds.map((id) => id.trim()).filter((id) => isUuid(id)))
  );

  if (uniqueIds.length === 0) {
    await supabaseAdmin.from("keep_in_touch_orders").delete().eq("user_id", userId);
    return { ok: true };
  }

  const pairFilter = uniqueIds
    .map((id) => `and(requester_id.eq.${userId},requested_id.eq.${id}),status.eq.accepted`)
    .concat(
      uniqueIds.map(
        (id) => `and(requester_id.eq.${id},requested_id.eq.${userId}),status.eq.accepted`
      )
    )
    .join(",");

  const { data: links, error: linksErr } = await supabaseAdmin
    .from("keep_in_touch_requests")
    .select("requester_id, requested_id")
    .or(pairFilter);

  if (linksErr) throw new Error("touch verification failed");

  const allowed = new Set<string>();
  (links || []).forEach((row) => {
    const requester = String((row as { requester_id: string }).requester_id);
    const requested = String((row as { requested_id: string }).requested_id);
    const otherId = requester === userId ? requested : requester;
    if (otherId && otherId !== userId) allowed.add(otherId);
  });

  const sanitized = uniqueIds.filter((id) => allowed.has(id));

  await supabaseAdmin.from("keep_in_touch_orders").delete().eq("user_id", userId);

  if (sanitized.length === 0) return { ok: true };

  const rows = sanitized.map((contactUserId, idx) => ({
    user_id: userId,
    contact_user_id: contactUserId,
    sort_order: idx,
  }));

  const { error: upsertErr } = await supabaseAdmin
    .from("keep_in_touch_orders")
    .upsert(rows, { onConflict: "user_id,contact_user_id" });

  if (upsertErr) throw new Error("touch order update failed");
  return { ok: true };
}

async function listDirectChats(userId: string) {
  const { data: chats, error: chatsErr } = await supabaseAdmin
    .from("direct_chats")
    .select("id, participant_a, participant_b, updated_at")
    .or(`participant_a.eq.${userId},participant_b.eq.${userId}`)
    .order("updated_at", { ascending: false });

  if (chatsErr) throw new Error("direct chats query failed");

  const rows = (chats || []) as DirectChatRow[];
  const chatIds = rows.map((row) => row.id);
  const orderMap: Record<string, number> = {};

  if (chatIds.length > 0) {
    const { data: orders, error: orderErr } = await supabaseAdmin
      .from("direct_chat_orders")
      .select("chat_id, sort_order")
      .eq("user_id", userId)
      .in("chat_id", chatIds);

    if (orderErr) throw new Error("direct chat order query failed");

    (orders || []).forEach((row) => {
      const chatId = String((row as { chat_id: string }).chat_id);
      orderMap[chatId] = Number((row as { sort_order: number }).sort_order) || 0;
    });
  }

  const otherIds = Array.from(
    new Set(
      rows
        .map((row) => (row.participant_a === userId ? row.participant_b : row.participant_a))
        .filter((id) => id && id !== userId)
    )
  );

  const profileMap: Record<string, ProfileRow> = {};
  if (otherIds.length > 0) {
    const { data: profiles, error: profileErr } = await supabaseAdmin
      .from("profileskozmos")
      .select("id, username, avatar_url")
      .in("id", otherIds);

    if (profileErr) throw new Error("direct chat profile query failed");
    (profiles as ProfileRow[] | null)?.forEach((profile) => {
      profileMap[profile.id] = profile;
    });
  }

  return rows
    .map((row) => {
      const otherUserId = row.participant_a === userId ? row.participant_b : row.participant_a;
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
}

async function openDirectChat(userId: string, targetUserId: string) {
  if (!targetUserId || !isUuid(targetUserId)) throw new Error("invalid target user id");
  if (targetUserId === userId) throw new Error("invalid target");

  const pairFilter = `and(requester_id.eq.${userId},requested_id.eq.${targetUserId}),and(requester_id.eq.${targetUserId},requested_id.eq.${userId})`;

  const { data: relation, error: relationErr } = await supabaseAdmin
    .from("keep_in_touch_requests")
    .select("id")
    .eq("status", "accepted")
    .or(pairFilter)
    .maybeSingle();

  if (relationErr) throw new Error("touch check failed");
  if (!relation?.id) throw new Error("not in touch");

  const [participantA, participantB] =
    userId.localeCompare(targetUserId) <= 0
      ? [userId, targetUserId]
      : [targetUserId, userId];

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

  if (upsertErr || !chatRow) throw new Error("chat create failed");

  const { data: targetProfile, error: profileErr } = await supabaseAdmin
    .from("profileskozmos")
    .select("id, username, avatar_url")
    .eq("id", targetUserId)
    .maybeSingle();

  if (profileErr || !targetProfile?.username) throw new Error("target profile missing");

  return {
    chat_id: (chatRow as DirectChatRow).id,
    other_user_id: targetUserId,
    username: targetProfile.username,
    avatar_url: targetProfile.avatar_url ?? null,
    updated_at: (chatRow as DirectChatRow).updated_at,
  };
}

async function listDirectMessages(userId: string, chatId: string, limit: number) {
  if (!chatId || !isUuid(chatId)) throw new Error("invalid chat id");
  const safeLimit = Math.max(1, Math.min(300, Math.floor(limit || 200)));

  const { data: chat, error: chatErr } = await supabaseAdmin
    .from("direct_chats")
    .select("id, participant_a, participant_b")
    .eq("id", chatId)
    .maybeSingle();

  if (chatErr || !chat) throw new Error("chat not found");

  const row = chat as DirectChatRow;
  if (row.participant_a !== userId && row.participant_b !== userId) {
    throw new Error("forbidden");
  }

  const { data: messages, error: messageErr } = await supabaseAdmin
    .from("direct_chat_messages")
    .select("id, chat_id, sender_id, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(safeLimit);

  if (messageErr) throw new Error("message query failed");
  return (messages || []) as DirectChatMessageRow[];
}

async function sendDirectMessage(userId: string, chatId: string, content: string) {
  if (!chatId || !isUuid(chatId)) throw new Error("invalid chat id");
  if (!content) throw new Error("content required");

  const { data: chat, error: chatErr } = await supabaseAdmin
    .from("direct_chats")
    .select("id, participant_a, participant_b")
    .eq("id", chatId)
    .maybeSingle();

  if (chatErr || !chat) throw new Error("chat not found");
  const row = chat as DirectChatRow;
  if (row.participant_a !== userId && row.participant_b !== userId) {
    throw new Error("forbidden");
  }

  const nowIso = new Date().toISOString();
  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("direct_chat_messages")
    .insert({
      chat_id: chatId,
      sender_id: userId,
      content: content.slice(0, 2000),
    })
    .select("id, chat_id, sender_id, content, created_at")
    .single();

  if (insertErr || !inserted) throw new Error("send failed");

  await supabaseAdmin.from("direct_chats").update({ updated_at: nowIso }).eq("id", chatId);

  return inserted;
}

async function removeDirectChat(userId: string, chatId: string) {
  if (!chatId || !isUuid(chatId)) throw new Error("invalid chat id");

  const { data: chat, error: chatErr } = await supabaseAdmin
    .from("direct_chats")
    .select("id, participant_a, participant_b")
    .eq("id", chatId)
    .maybeSingle();

  if (chatErr || !chat) throw new Error("chat not found");
  const row = chat as DirectChatRow;
  if (row.participant_a !== userId && row.participant_b !== userId) {
    throw new Error("forbidden");
  }

  const { error: deleteErr } = await supabaseAdmin
    .from("direct_chats")
    .delete()
    .eq("id", chatId);

  if (deleteErr) throw new Error("chat remove failed");
  return { ok: true };
}

async function updateDirectChatOrder(userId: string, orderedChatIds: string[]) {
  const uniqueIds = Array.from(
    new Set(orderedChatIds.map((id) => id.trim()).filter((id) => isUuid(id)))
  );

  await supabaseAdmin.from("direct_chat_orders").delete().eq("user_id", userId);
  if (uniqueIds.length === 0) return { ok: true };

  const { data: chats, error: chatsErr } = await supabaseAdmin
    .from("direct_chats")
    .select("id, participant_a, participant_b")
    .in("id", uniqueIds)
    .or(`participant_a.eq.${userId},participant_b.eq.${userId}`);

  if (chatsErr) throw new Error("chat verification failed");

  const allowed = new Set<string>((chats as DirectChatRow[] | null)?.map((row) => row.id) || []);
  const sanitized = uniqueIds.filter((id) => allowed.has(id));

  if (sanitized.length === 0) return { ok: true };

  const rows = sanitized.map((chatId, index) => ({
    user_id: userId,
    chat_id: chatId,
    sort_order: index,
  }));

  const { error: upsertErr } = await supabaseAdmin
    .from("direct_chat_orders")
    .upsert(rows, { onConflict: "user_id,chat_id" });

  if (upsertErr) throw new Error("chat order update failed");
  return { ok: true };
}

async function buildSnapshot(actor: RuntimeActor) {
  const [notes, touch, chats, hush, matrix, matrixPosition, present] = await Promise.all([
    listNotes(actor.userId),
    listTouch(actor.userId),
    listDirectChats(actor.userId),
    listHush(actor.userId),
    getMatrixProfile(actor.userId),
    getMatrixPosition(actor.userId),
    listPresentRuntimeUsers(),
  ]);

  return {
    actor: {
      user_id: actor.userId,
      username: actor.username,
    },
    notes,
    touch,
    chats,
    hush,
    matrix,
    matrix_position: matrixPosition,
    present_users: present,
    play: listKozmosPlay(),
  };
}

export async function POST(req: Request) {
  try {
    const auth = await requireRuntimeCapability(req, AXY_SUPER_CAPABILITY);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const actor = auth.actor;
    const body = await req.json().catch(() => ({}));
    const action = asTrimmedString(body?.action);
    const payload = body?.payload ?? {};

    if (!action) {
      return NextResponse.json({ error: "action required" }, { status: 400 });
    }

    if (action === "context.snapshot") {
      const snapshot = await buildSnapshot(actor);
      return NextResponse.json({ ok: true, action, data: snapshot });
    }

    if (action === "notes.list") {
      const notes = await listNotes(actor.userId);
      return NextResponse.json({ ok: true, action, data: notes });
    }

    if (action === "notes.create") {
      const content = asTrimmedString((payload as { content?: unknown })?.content);
      const note = await createNote(actor.userId, content);
      return NextResponse.json({ ok: true, action, data: note });
    }

    if (action === "notes.delete") {
      const noteId = asTrimmedString((payload as { noteId?: unknown })?.noteId);
      const result = await deleteNote(actor.userId, noteId);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "touch.list") {
      const list = await listTouch(actor.userId);
      return NextResponse.json({ ok: true, action, data: list });
    }

    if (action === "touch.request") {
      const targetUsername = asTrimmedString(
        (payload as { targetUsername?: unknown })?.targetUsername
      );
      const result = await requestTouch(actor.userId, targetUsername);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "touch.respond") {
      const requestId = Number((payload as { requestId?: unknown })?.requestId);
      const accept = Boolean((payload as { accept?: unknown })?.accept);
      const result = await respondTouch(actor.userId, requestId, accept);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "touch.remove") {
      const targetUserId = asSafeUuid((payload as { targetUserId?: unknown })?.targetUserId);
      const result = await removeTouch(actor.userId, targetUserId);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "touch.order") {
      const orderedUserIds = Array.isArray((payload as { orderedUserIds?: unknown }).orderedUserIds)
        ? ((payload as { orderedUserIds: unknown[] }).orderedUserIds || []).map((value) =>
            String(value ?? "")
          )
        : [];
      const result = await updateTouchOrder(actor.userId, orderedUserIds);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "hush.list") {
      const hush = await listHush(actor.userId);
      return NextResponse.json({ ok: true, action, data: hush });
    }

    if (action === "hush.create_with") {
      const targetUserId = asSafeUuid((payload as { targetUserId?: unknown })?.targetUserId);
      const chat = await createHushWith(actor.userId, targetUserId);
      return NextResponse.json({ ok: true, action, data: chat });
    }

    if (action === "hush.invite") {
      const chatId = asSafeUuid((payload as { chatId?: unknown })?.chatId);
      const targetUserId = asSafeUuid((payload as { targetUserId?: unknown })?.targetUserId);
      const result = await inviteToHush(actor.userId, chatId, targetUserId);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "hush.request_join") {
      const chatId = asSafeUuid((payload as { chatId?: unknown })?.chatId);
      const result = await requestHushJoin(actor.userId, chatId);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "hush.accept_request") {
      const chatId = asSafeUuid((payload as { chatId?: unknown })?.chatId);
      const memberUserId = asSafeUuid((payload as { memberUserId?: unknown })?.memberUserId);
      const result = await resolveHushRequest(actor.userId, chatId, memberUserId, true);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "hush.decline_request") {
      const chatId = asSafeUuid((payload as { chatId?: unknown })?.chatId);
      const memberUserId = asSafeUuid((payload as { memberUserId?: unknown })?.memberUserId);
      const result = await resolveHushRequest(actor.userId, chatId, memberUserId, false);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "hush.accept_invite") {
      const chatId = asSafeUuid((payload as { chatId?: unknown })?.chatId);
      const result = await respondToHushInvite(actor.userId, chatId, true);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "hush.decline_invite") {
      const chatId = asSafeUuid((payload as { chatId?: unknown })?.chatId);
      const result = await respondToHushInvite(actor.userId, chatId, false);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "hush.leave") {
      const chatId = asSafeUuid((payload as { chatId?: unknown })?.chatId);
      const result = await leaveHushChat(actor.userId, chatId);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "hush.remove_member") {
      const chatId = asSafeUuid((payload as { chatId?: unknown })?.chatId);
      const memberUserId = asSafeUuid((payload as { memberUserId?: unknown })?.memberUserId);
      const result = await removeHushMember(actor.userId, chatId, memberUserId);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "hush.messages") {
      const chatId = asSafeUuid((payload as { chatId?: unknown })?.chatId);
      const limit = Number((payload as { limit?: unknown })?.limit ?? 200);
      const messages = await listHushMessages(actor.userId, chatId, limit);
      return NextResponse.json({ ok: true, action, data: messages });
    }

    if (action === "hush.send") {
      const chatId = asSafeUuid((payload as { chatId?: unknown })?.chatId);
      const content = asTrimmedString((payload as { content?: unknown })?.content);
      const message = await sendHushMessage(actor.userId, chatId, content);
      return NextResponse.json({ ok: true, action, data: message });
    }

    if (action === "build.spaces.list") {
      const spaces = await listBuildSpaces(actor.userId);
      return NextResponse.json({ ok: true, action, data: spaces });
    }

    if (action === "build.spaces.create") {
      const title = asTrimmedString((payload as { title?: unknown })?.title);
      const languagePref = asTrimmedString(
        (payload as { languagePref?: unknown })?.languagePref
      );
      const description = typeof (payload as { description?: unknown })?.description === "string"
        ? ((payload as { description: string }).description || "").slice(0, 4000)
        : "";
      const space = await createBuildSpace(actor.userId, title, languagePref, description);
      return NextResponse.json({ ok: true, action, data: space });
    }

    if (action === "build.spaces.update") {
      const spaceId = asSafeUuid((payload as { spaceId?: unknown })?.spaceId);
      const updates = {
        title:
          typeof (payload as { title?: unknown })?.title === "string"
            ? asTrimmedString((payload as { title: string }).title)
            : undefined,
        languagePref:
          typeof (payload as { languagePref?: unknown })?.languagePref === "string"
            ? asTrimmedString((payload as { languagePref: string }).languagePref)
            : undefined,
        description:
          typeof (payload as { description?: unknown })?.description === "string"
            ? String((payload as { description: string }).description).slice(0, 4000)
            : undefined,
        isPublic:
          typeof (payload as { isPublic?: unknown })?.isPublic === "boolean"
            ? asSafeBool((payload as { isPublic?: unknown }).isPublic)
            : undefined,
      };
      const space = await updateBuildSpace(actor.userId, spaceId, updates);
      return NextResponse.json({ ok: true, action, data: space });
    }

    if (action === "build.spaces.delete") {
      const spaceId = asSafeUuid((payload as { spaceId?: unknown })?.spaceId);
      const result = await deleteBuildSpace(actor.userId, spaceId);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "build.space.snapshot") {
      const spaceId = asSafeUuid((payload as { spaceId?: unknown })?.spaceId);
      const snapshot = await buildSpaceSnapshot(actor.userId, spaceId);
      return NextResponse.json({ ok: true, action, data: snapshot });
    }

    if (action === "build.files.list") {
      const spaceId = asSafeUuid((payload as { spaceId?: unknown })?.spaceId);
      const files = await listBuildFiles(actor.userId, spaceId);
      return NextResponse.json({ ok: true, action, data: files });
    }

    if (action === "build.files.create") {
      const spaceId = asSafeUuid((payload as { spaceId?: unknown })?.spaceId);
      const path = normalizeBuildPath((payload as { path?: unknown })?.path);
      const language = asTrimmedString((payload as { language?: unknown })?.language);
      const result = await createBuildFile(actor.userId, spaceId, path, language);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "build.files.save") {
      const spaceId = asSafeUuid((payload as { spaceId?: unknown })?.spaceId);
      const path = normalizeBuildPath((payload as { path?: unknown })?.path);
      const content =
        typeof (payload as { content?: unknown })?.content === "string"
          ? (payload as { content: string }).content
          : "";
      const language = asTrimmedString((payload as { language?: unknown })?.language);
      const result = await saveBuildFile(actor.userId, spaceId, path, content, language);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "build.files.delete") {
      const spaceId = asSafeUuid((payload as { spaceId?: unknown })?.spaceId);
      const path = normalizeBuildPath((payload as { path?: unknown })?.path);
      const result = await deleteBuildFile(actor.userId, spaceId, path);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "build.access.list") {
      const spaceId = asSafeUuid((payload as { spaceId?: unknown })?.spaceId);
      const access = await listBuildAccess(actor.userId, spaceId);
      return NextResponse.json({ ok: true, action, data: access });
    }

    if (action === "build.access.grant") {
      const spaceId = asSafeUuid((payload as { spaceId?: unknown })?.spaceId);
      const targetUsername = asTrimmedString(
        (payload as { targetUsername?: unknown })?.targetUsername
      );
      const canEdit = asSafeBool((payload as { canEdit?: unknown })?.canEdit, false);
      const result = await grantBuildAccess(actor.userId, spaceId, targetUsername, canEdit);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "build.access.revoke") {
      const spaceId = asSafeUuid((payload as { spaceId?: unknown })?.spaceId);
      const targetUsername = asTrimmedString(
        (payload as { targetUsername?: unknown })?.targetUsername
      );
      const result = await revokeBuildAccess(actor.userId, spaceId, targetUsername);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "matrix.profile") {
      const profile = await getMatrixProfile(actor.userId);
      return NextResponse.json({ ok: true, action, data: profile });
    }

    if (action === "matrix.set_color") {
      const orbColor = asTrimmedString((payload as { orbColor?: unknown })?.orbColor);
      const profile = await updateMatrixColor(actor.userId, orbColor);
      return NextResponse.json({ ok: true, action, data: profile });
    }

    if (action === "matrix.position") {
      const position = await getMatrixPosition(actor.userId);
      return NextResponse.json({ ok: true, action, data: position });
    }

    if (action === "matrix.enter") {
      const x = (payload as { x?: unknown })?.x;
      const z = (payload as { z?: unknown })?.z;
      const position = await enterMatrix(actor.userId, { x, z });
      return NextResponse.json({ ok: true, action, data: position });
    }

    if (action === "matrix.exit") {
      const result = await exitMatrix(actor.userId);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "matrix.move") {
      const position = await moveMatrix(actor.userId, payload as Record<string, unknown>);
      return NextResponse.json({ ok: true, action, data: position });
    }

    if (action === "matrix.world") {
      const world = await listMatrixRuntimeWorld();
      return NextResponse.json({ ok: true, action, data: world });
    }

    if (action === "presence.list") {
      const present = await listPresentRuntimeUsers();
      return NextResponse.json({ ok: true, action, data: present });
    }

    if (action === "play.catalog") {
      return NextResponse.json({ ok: true, action, data: listKozmosPlay() });
    }

    if (action === "play.hint") {
      const gameId = asTrimmedString((payload as { gameId?: unknown })?.gameId);
      const hint = getKozmosPlayHint(gameId);
      return NextResponse.json({ ok: true, action, data: hint });
    }

    if (action === "dm.list") {
      const chats = await listDirectChats(actor.userId);
      return NextResponse.json({ ok: true, action, data: chats });
    }

    if (action === "dm.open") {
      const targetUserId = asSafeUuid((payload as { targetUserId?: unknown })?.targetUserId);
      const chat = await openDirectChat(actor.userId, targetUserId);
      return NextResponse.json({ ok: true, action, data: chat });
    }

    if (action === "dm.messages") {
      const chatId = asSafeUuid((payload as { chatId?: unknown })?.chatId);
      const limit = Number((payload as { limit?: unknown })?.limit ?? 200);
      const messages = await listDirectMessages(actor.userId, chatId, limit);
      return NextResponse.json({ ok: true, action, data: messages });
    }

    if (action === "dm.send") {
      const chatId = asSafeUuid((payload as { chatId?: unknown })?.chatId);
      const content = asTrimmedString((payload as { content?: unknown })?.content);
      const message = await sendDirectMessage(actor.userId, chatId, content);
      return NextResponse.json({ ok: true, action, data: message });
    }

    if (action === "dm.remove") {
      const chatId = asSafeUuid((payload as { chatId?: unknown })?.chatId);
      const result = await removeDirectChat(actor.userId, chatId);
      return NextResponse.json({ ok: true, action, data: result });
    }

    if (action === "dm.order") {
      const orderedChatIds = Array.isArray((payload as { orderedChatIds?: unknown }).orderedChatIds)
        ? ((payload as { orderedChatIds: unknown[] }).orderedChatIds || []).map((value) =>
            String(value ?? "")
          )
        : [];
      const result = await updateDirectChatOrder(actor.userId, orderedChatIds);
      return NextResponse.json({ ok: true, action, data: result });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : "unknown";
    const status =
      /forbidden/i.test(detail) || /not in touch/i.test(detail)
        ? 403
        : /not found/i.test(detail)
        ? 404
        : /required|invalid|unknown action|cannot|no updates|schema missing|requires/i.test(detail)
        ? 400
        : 500;

    return NextResponse.json({ error: detail }, { status });
  }
}
