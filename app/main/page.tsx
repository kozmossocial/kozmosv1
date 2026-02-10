"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Message = {
  id: string;
  user_id: string;
  username: string;
  content: string;
};

type HushChat = {
  id: string;
  created_by: string;
  status: "open" | "closed";
  created_at: string;
};

type HushMember = {
  id: number;
  chat_id: string;
  user_id: string;
  role: "owner" | "member";
  status:
    | "invited"
    | "accepted"
    | "declined"
    | "left"
    | "removed"
    | "requested";
  display_name?: string | null;
  created_at: string;
};

type HushMessage = {
  id: string;
  chat_id: string;
  user_id: string;
  content: string;
  created_at: string;
};

export default function Main() {
  const router = useRouter();

  const [username, setUsername] = useState("user");
  const [userId, setUserId] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);

  /* AXY */
  const [showAxy, setShowAxy] = useState(false);
  const [openAxy, setOpenAxy] = useState(false);
  const [axyInput, setAxyInput] = useState("");
  const [axyReply, setAxyReply] = useState<string | null>(null);
  const [axyLoading, setAxyLoading] = useState(false);

  /* AXY reflection (messages) */
  const [axyMsgReflection, setAxyMsgReflection] = useState<
    Record<string, string>
  >({});
  const [axyMsgLoadingId, setAxyMsgLoadingId] = useState<string | null>(null);
  const [axyMsgPulseId, setAxyMsgPulseId] = useState<string | null>(null);
  const [axyMsgFadeId, setAxyMsgFadeId] = useState<string | null>(null);
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null);
  const [hoveredHushChatId, setHoveredHushChatId] = useState<string | null>(
    null
  );
  const [hoveredHushMemberId, setHoveredHushMemberId] = useState<number | null>(
    null
  );
  const [requestingChatId, setRequestingChatId] = useState<string | null>(null);

  /* HUSH */
  const [hushChats, setHushChats] = useState<HushChat[]>([]);
  const [hushMembers, setHushMembers] = useState<HushMember[]>([]);
  const [hushUsers, setHushUsers] = useState<Record<string, string>>({});
  const [selectedHushChatId, setSelectedHushChatId] = useState<string | null>(
    null
  );
  const [hushMessages, setHushMessages] = useState<HushMessage[]>([]);
  const [hushInput, setHushInput] = useState("");
  const [hushLoading, setHushLoading] = useState(false);
  const [hushSending, setHushSending] = useState(false);
  const [hushInviteTarget, setHushInviteTarget] = useState<{
    userId: string;
    username: string;
    chatId?: string;
  } | null>(null);
  const [playOpen, setPlayOpen] = useState(false);
  const hushPanelRef = useRef<HTMLDivElement | null>(null);
  const [playClosedHeight, setPlayClosedHeight] = useState<number | null>(null);

  /* delayed presence */
  useEffect(() => {
    const t = setTimeout(() => setShowAxy(true), 3000);
    return () => clearTimeout(t);
  }, []);

  /*  load user + messages */
  useEffect(() => {
    async function load() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push("/login");
        return;
      }

      setUserId(user.id);

      const { data: profile } = await supabase
        .from("profileskozmos")
        .select("username")
        .eq("id", user.id)
        .maybeSingle();

      setUsername(profile?.username ?? "user");

      const { data } = await supabase
        .from("main_messages")
        .select("id, user_id, username, content")
        .order("created_at", { ascending: true });

      setMessages(data || []);
    }

    load();
  }, [router]);

  async function loadHush() {
    const { data: chats } = await supabase
      .from("hush_chats")
      .select("id, created_by, status, created_at")
      .eq("status", "open")
      .order("created_at", { ascending: false });

    setHushChats(chats || []);

    if (!chats || chats.length === 0) {
      setHushMembers([]);
      setHushUsers({});
      setHushMessages([]);
      setSelectedHushChatId(null);
      return;
    }

    if (
      selectedHushChatId &&
      !chats.some((chat) => chat.id === selectedHushChatId)
    ) {
      setSelectedHushChatId(null);
    }

    const chatIds = chats.map((chat) => chat.id);
    const { data: members } = await supabase
      .from("hush_chat_members")
      .select("id, chat_id, user_id, role, status, display_name, created_at")
      .in("chat_id", chatIds);

    setHushMembers(members || []);

    const map: Record<string, string> = {};
    (members || []).forEach((member) => {
      if (member.display_name) {
        map[member.user_id] = member.display_name;
      }
    });

    const userIds = Array.from(
      new Set((members || []).map((member) => member.user_id))
    );

    if (userIds.length === 0) {
      setHushUsers(map);
      return;
    }

    const missingUserIds = userIds.filter((id) => !map[id]);
    if (missingUserIds.length === 0) {
      setHushUsers(map);
      return;
    }

    const { data: profiles } = await supabase
      .from("profileskozmos")
      .select("id, username")
      .in("id", missingUserIds);

    (profiles || []).forEach((profile) => {
      map[profile.id] = profile.username;
    });

    setHushUsers(map);
  }

  async function loadHushMessages(chatId: string) {
    const { data } = await supabase
      .from("hush_chat_messages")
      .select("id, chat_id, user_id, content, created_at")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true });

    setHushMessages(data || []);
  }

  function getHushUserName(id: string) {
    return hushUsers[id] || "user";
  }

  function getHushChatLabel(chatId: string) {
    const activeMembers = hushMembers.filter(
      (member) =>
        member.chat_id === chatId &&
        member.status !== "declined" &&
        member.status !== "requested" &&
        member.status !== "removed" &&
        member.status !== "left"
    );

    const names = activeMembers.map((member) =>
      getHushUserName(member.user_id)
    );

    return names.length ? names.join(" + ") : "hush";
  }

  function canRequestHush(chatId: string) {
    const myMember = getMyHushMembership(chatId);
    if (!myMember) return true;
    return (
      myMember.status === "declined" ||
      myMember.status === "left" ||
      myMember.status === "removed"
    );
  }

  function getMyHushMembership(chatId: string) {
    if (!userId) return null;
    return hushMembers.find(
      (member) => member.chat_id === chatId && member.user_id === userId
    );
  }

  useEffect(() => {
    if (!userId) return;
    loadHush();
  }, [userId]);

  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel("hush-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "hush_chats" },
        () => {
          loadHush();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "hush_chat_members" },
        () => {
          loadHush();
          if (selectedHushChatId) {
            loadHushMessages(selectedHushChatId);
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "hush_chat_messages" },
        (payload) => {
          const next = payload.new as HushMessage | null;
          const prev = payload.old as HushMessage | null;
          const chatId = next?.chat_id || prev?.chat_id;

          if (selectedHushChatId && chatId === selectedHushChatId) {
            loadHushMessages(selectedHushChatId);
          }
        }
      )
      .subscribe();

    const poll = setInterval(() => {
      loadHush();
      if (selectedHushChatId) {
        loadHushMessages(selectedHushChatId);
      }
    }, 6000);

    return () => {
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [userId, selectedHushChatId]);

  useEffect(() => {
    if (!selectedHushChatId || !userId) {
      setHushMessages([]);
      return;
    }

    const myMembership = getMyHushMembership(selectedHushChatId);
    if (!myMembership || myMembership.status !== "accepted") {
      setHushMessages([]);
      return;
    }

    loadHushMessages(selectedHushChatId);
  }, [selectedHushChatId, userId, hushMembers]);

  useEffect(() => {
    const el = hushPanelRef.current;
    if (!el) return;

    const update = () => {
      if (!playOpen) {
        setPlayClosedHeight(el.getBoundingClientRect().height);
      }
    };

    update();

    const observer = new ResizeObserver(() => update());
    observer.observe(el);

    return () => observer.disconnect();
  }, [playOpen]);

  /*  REALTIME (insert + delete) */
  useEffect(() => {
    const channel = supabase
      .channel("main-messages-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "main_messages" },
        (payload) => {
          const msg = payload.new as Message;
          setMessages((prev) =>
            prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]
          );
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "main_messages" },
        (payload) => {
          const id = payload.old.id;
          setMessages((prev) => prev.filter((m) => m.id !== id));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  /*  send */
  async function sendMessage() {
    if (!input.trim() || !userId) return;

    setLoading(true);

    await supabase.from("main_messages").insert({
      user_id: userId,
      username,
      content: input,
    });

    setInput("");
    setLoading(false);
  }

  /*  delete */
  async function deleteMessage(id: string) {
    await supabase.from("main_messages").delete().eq("id", id);
  }

  /* AXY ask */
  async function askAxy() {
    if (!axyInput.trim()) return;

    setAxyLoading(true);
    setAxyReply(null);

    try {
      const res = await fetch("/api/axy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: axyInput }),
      });

      const data = await res.json();
      setAxyReply(data.reply);
    } catch {
      setAxyReply("...");
    }

    setAxyInput("");
    setAxyLoading(false);
  }

  /* AXY reflect (message) */
  async function askAxyOnMessage(messageId: string, content: string) {
    setAxyMsgLoadingId(messageId);

    try {
      const res = await fetch("/api/axy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Reflect on this message in one calm sentence:\n\n${content}`,
        }),
      });

      const data = await res.json();

      setAxyMsgReflection((prev) => ({
        ...prev,
        [messageId]: data.reply,
      }));
    } catch {
      setAxyMsgReflection((prev) => ({
        ...prev,
        [messageId]: "...",
      }));
    }

    setAxyMsgLoadingId(null);
  }

  async function createHushWith(targetUserId: string) {
    if (!userId || hushLoading) return;

    setHushLoading(true);

    const { data: chat, error: chatError } = await supabase
      .from("hush_chats")
      .insert({ created_by: userId })
      .select("id, created_by, status, created_at")
      .single();

    if (chatError || !chat) {
      setHushLoading(false);
      return;
    }

    const { error: memberError } = await supabase
      .from("hush_chat_members")
      .insert([
        {
          chat_id: chat.id,
          user_id: userId,
          role: "owner",
          status: "accepted",
          display_name: username,
        },
        {
          chat_id: chat.id,
          user_id: targetUserId,
          role: "member",
          status: "invited",
          display_name: hushInviteTarget?.username ?? "user",
        },
      ]);

    if (!memberError) {
      setSelectedHushChatId(chat.id);
      setHushInviteTarget(null);
      await loadHush();
    }

    setHushLoading(false);
  }

  async function inviteToHushChat(chatId: string, targetUserId: string) {
    if (!userId || hushLoading) return;

    setHushLoading(true);

    await supabase.from("hush_chat_members").insert({
      chat_id: chatId,
      user_id: targetUserId,
      role: "member",
      status: "invited",
      display_name: hushInviteTarget?.username ?? "user",
    });

    setHushInviteTarget(null);
    await loadHush();
    setHushLoading(false);
  }

  async function requestHushJoin(chatId: string) {
    if (!userId || hushLoading) return;
    if (!canRequestHush(chatId)) return;

    setHushLoading(true);
    setRequestingChatId(chatId);

    await supabase
      .from("hush_chat_members")
      .upsert(
        {
          chat_id: chatId,
          user_id: userId,
          role: "member",
          status: "requested",
          display_name: username,
        },
        { onConflict: "chat_id,user_id" }
      );

    await loadHush();
    setHushLoading(false);
    setRequestingChatId(null);
  }

  async function acceptHushRequest(chatId: string, memberUserId: string) {
    await supabase
      .from("hush_chat_members")
      .update({ status: "accepted" })
      .eq("chat_id", chatId)
      .eq("user_id", memberUserId);

    await loadHush();
  }

  async function declineHushRequest(chatId: string, memberUserId: string) {
    await supabase
      .from("hush_chat_members")
      .update({ status: "declined" })
      .eq("chat_id", chatId)
      .eq("user_id", memberUserId);

    await loadHush();
  }

  async function acceptHushInvite(chatId: string) {
    if (!userId) return;

    await supabase
      .from("hush_chat_members")
      .update({ status: "accepted" })
      .eq("chat_id", chatId)
      .eq("user_id", userId);

    setSelectedHushChatId(chatId);
    await loadHush();
  }

  async function declineHushInvite(chatId: string) {
    if (!userId) return;

    await supabase
      .from("hush_chat_members")
      .update({ status: "declined" })
      .eq("chat_id", chatId)
      .eq("user_id", userId);

    await loadHush();
  }

  async function leaveHushChat(chatId: string) {
    if (!userId) return;

    const myMembership = getMyHushMembership(chatId);
    const activeMembers = hushMembers.filter(
      (member) =>
        member.chat_id === chatId &&
        member.status !== "declined" &&
        member.status !== "removed" &&
        member.status !== "left"
    );

    await supabase
      .from("hush_chat_members")
      .update({ status: "left" })
      .eq("chat_id", chatId)
      .eq("user_id", userId);

    if (myMembership?.role === "owner" && activeMembers.length <= 2) {
      await supabase
        .from("hush_chats")
        .update({ status: "closed" })
        .eq("id", chatId);
    }

    if (selectedHushChatId === chatId) {
      setSelectedHushChatId(null);
    }

    await loadHush();
  }

  async function removeHushMember(chatId: string, memberUserId: string) {
    await supabase
      .from("hush_chat_members")
      .update({ status: "removed" })
      .eq("chat_id", chatId)
      .eq("user_id", memberUserId);

    await loadHush();
  }

  async function sendHushMessage() {
    if (!selectedHushChatId || !userId || !hushInput.trim() || hushSending)
      return;

    const myMembership = getMyHushMembership(selectedHushChatId);
    if (!myMembership || myMembership.status !== "accepted") return;

    setHushSending(true);

    await supabase.from("hush_chat_messages").insert({
      chat_id: selectedHushChatId,
      user_id: userId,
      content: hushInput.trim(),
    });

    setHushInput("");
    setHushSending(false);
    await loadHushMessages(selectedHushChatId);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/");
  }

  const invitesForMe = userId
    ? hushMembers.filter(
        (member) => member.user_id === userId && member.status === "invited"
      )
    : [];

  const myHushChatIds = userId
    ? hushChats.filter((chat) => chat.created_by === userId).map((chat) => chat.id)
    : [];

  const requestsForMe = myHushChatIds.length
    ? hushMembers.filter(
        (member) =>
          member.status === "requested" &&
          myHushChatIds.includes(member.chat_id)
      )
    : [];

  const selectedHushMembership = selectedHushChatId
    ? getMyHushMembership(selectedHushChatId)
    : null;

  const selectedHushMembers = selectedHushChatId
    ? hushMembers.filter(
        (member) =>
          member.chat_id === selectedHushChatId &&
          member.status !== "declined" &&
          member.status !== "requested" &&
          member.status !== "removed" &&
          member.status !== "left"
      )
    : [];

  const canChatInSelectedHush =
    selectedHushMembership?.status === "accepted";
  const isSelectedHushOwner = selectedHushMembership?.role === "owner";

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0b0b0b",
        color: "#eaeaea",
        padding: 40,
        position: "relative",
      }}
    >
{/* LOGO */}
<div
  style={{
    position: "absolute",
    top: 30,
    left: "50%",
    transform: "translateX(-54%)",
    zIndex: 5,
  }}
>
  <img
    src="/kozmos-logomother1.png"
    alt="Kozmos"
      className="kozmos-logo kozmos-logo-ambient"
    style={{
      maxWidth: 80,          // ana sayfadakiyle uyumlu
      opacity: 0.9,
      cursor: "pointer",
      transition:
        "opacity 0.25s ease, transform 0.08s ease, box-shadow 0.25s ease",
    }}
    onClick={() => window.location.href = "https://kozmos.social"}
    onMouseEnter={(e) => {
      e.currentTarget.style.opacity = "1";
      e.currentTarget.style.boxShadow =
        "0 0 18px rgba(107,255,142,0.45)";
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.opacity = "0.9";
      e.currentTarget.style.boxShadow = "none";
    }}
    onMouseDown={(e) => {
      e.currentTarget.style.transform = "scale(0.97)";
    }}
    onMouseUp={(e) => {
      e.currentTarget.style.transform = "scale(1)";
    }}
  />
</div>

      {/* TOP LEFT */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          fontSize: 12,
          letterSpacing: "0.12em",
          opacity: 0.6,
        }}
      >
        <span style={{ cursor: "pointer" }} onClick={() => router.push("/main")}>
          main
        </span>{" "}
        /{" "}
        <span
          style={{ cursor: "pointer" }}
          onClick={() => router.push("/my-home")}
        >
          my home
        </span>
      </div>

      {/* TOP RIGHT */}
      <div
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          fontSize: 12,
          letterSpacing: "0.12em",
          opacity: 0.6,
        }}
      >
        <span
          style={{ marginRight: 8, cursor: "pointer", opacity: 0.8 }}
          onClick={() => router.push("/account")}
        >
          {username}
        </span>
        /{" "}
        <span style={{ cursor: "pointer" }} onClick={handleLogout}>
          logout
        </span>
      </div>

      {/* MAIN GRID */}
      <div style={mainGridStyle}>
        {/* HUSH PANEL */}
        <div style={hushPanelStyle} ref={hushPanelRef}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <div style={{ opacity: 0.6, letterSpacing: "0.2em" }}>
            {"hush\u00b7chat"}
          </div>
          <div
            className="kozmos-tap"
            style={{ opacity: 0.4, cursor: "pointer" }}
            onClick={loadHush}
          >
            refresh
          </div>
        </div>

        {hushInviteTarget && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ opacity: 0.5, marginBottom: 4 }}>
              {hushInviteTarget.chatId ? "invite to hush" : "invite"}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 6,
              }}
            >
              <span>{hushInviteTarget.username}</span>
              <span
                className="kozmos-tap"
                style={{ cursor: "pointer", opacity: 0.7 }}
                onClick={() => {
                  if (hushInviteTarget.chatId) {
                    inviteToHushChat(
                      hushInviteTarget.chatId,
                      hushInviteTarget.userId
                    );
                  } else {
                    createHushWith(hushInviteTarget.userId);
                  }
                }}
              >
                {hushLoading ? "..." : "send"}
              </span>
            </div>
          <div
            className="kozmos-tap"
            style={{ opacity: 0.4, cursor: "pointer" }}
            onClick={() => setHushInviteTarget(null)}
          >
            cancel
          </div>
          </div>
        )}

        {invitesForMe.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ opacity: 0.5, marginBottom: 4 }}>invites</div>
            {invitesForMe.map((invite) => (
              <div
                key={invite.chat_id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 6,
                }}
              >
                <span>{getHushChatLabel(invite.chat_id)}</span>
                <span
                  className="kozmos-tap"
                  style={{ cursor: "pointer", opacity: 0.7, marginLeft: 8 }}
                  onClick={() => acceptHushInvite(invite.chat_id)}
                >
                  accept
                </span>
                <span
                  className="kozmos-tap"
                  style={{ cursor: "pointer", opacity: 0.4, marginLeft: 6 }}
                  onClick={() => declineHushInvite(invite.chat_id)}
                >
                  decline
                </span>
              </div>
            ))}
          </div>
        )}

        {requestsForMe.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ opacity: 0.5, marginBottom: 4 }}>requests</div>
            {requestsForMe.map((request) => (
              <div
                key={`${request.chat_id}-${request.user_id}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 6,
                }}
              >
                <span>{`request by ${getHushUserName(request.user_id)}?`}</span>
                <span
                  className="kozmos-tap"
                  style={{ cursor: "pointer", opacity: 0.7, marginLeft: 8 }}
                  onClick={() =>
                    acceptHushRequest(request.chat_id, request.user_id)
                  }
                >
                  yes
                </span>
                <span
                  className="kozmos-tap"
                  style={{ cursor: "pointer", opacity: 0.4, marginLeft: 6 }}
                  onClick={() =>
                    declineHushRequest(request.chat_id, request.user_id)
                  }
                >
                  no
                </span>
              </div>
            ))}
          </div>
        )}

        <div style={{ opacity: 0.5, marginBottom: 6 }}>active hushes</div>
        <div style={{ marginBottom: 12 }}>
          {hushChats.map((chat) => {
            const myMember = getMyHushMembership(chat.id);
            const isSelected = selectedHushChatId === chat.id;
            const canRequest = canRequestHush(chat.id);

            return (
              <div
                key={chat.id}
                style={{
                  marginBottom: 10,
                  cursor: "pointer",
                  opacity: isSelected ? 0.9 : 0.6,
                  paddingBottom: 8,
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                }}
                onClick={() =>
                  setSelectedHushChatId((prev) =>
                    prev === chat.id ? null : chat.id
                  )
                }
                onMouseEnter={() => setHoveredHushChatId(chat.id)}
                onMouseLeave={() => setHoveredHushChatId(null)}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span>{getHushChatLabel(chat.id)}</span>
                  {hoveredHushChatId === chat.id && canRequest && (
                    <span
                      className="kozmos-tap"
                      style={{ opacity: 0.6, cursor: "pointer" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        requestHushJoin(chat.id);
                      }}
                    >
                      {requestingChatId === chat.id ? "..." : "request"}
                    </span>
                  )}
                </div>
                {myMember?.status === "invited" && (
                  <div style={{ fontSize: 11, opacity: 0.4 }}>invited</div>
                )}
                {myMember?.status === "requested" && (
                  <div style={{ fontSize: 11, opacity: 0.4 }}>requested</div>
                )}
              </div>
            );
          })}
        </div>

        {selectedHushChatId && (
          <div
            style={{
              borderTop: "1px solid rgba(255,255,255,0.08)",
              paddingTop: 12,
            }}
          >
            <div style={{ opacity: 0.5, marginBottom: 6 }}>hush chat</div>

            <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 8 }}>
              {getHushChatLabel(selectedHushChatId)}
            </div>

            <div style={{ marginBottom: 8 }}>
              {selectedHushMembers.map((member) => (
                <div
                  key={member.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 4,
                  }}
                >
                  <span style={{ opacity: 0.6 }}>
                    {getHushUserName(member.user_id)}
                  </span>
                  <span
                    className={isSelectedHushOwner ? "kozmos-tap" : undefined}
                    style={{
                      opacity: 0.4,
                      fontSize: 11,
                      cursor:
                        isSelectedHushOwner &&
                        member.user_id !== userId &&
                        member.status === "accepted"
                          ? "pointer"
                          : "default",
                    }}
                    onMouseEnter={() => setHoveredHushMemberId(member.id)}
                    onMouseLeave={() => setHoveredHushMemberId(null)}
                    onClick={() => {
                      if (!isSelectedHushOwner) return;
                      if (member.user_id === userId) return;
                      if (member.status !== "accepted") return;
                      removeHushMember(selectedHushChatId!, member.user_id);
                    }}
                  >
                    {isSelectedHushOwner &&
                    member.user_id !== userId &&
                    member.status === "accepted" &&
                    hoveredHushMemberId === member.id
                      ? "remove"
                      : member.status}
                  </span>
                </div>
              ))}
            </div>

            {canChatInSelectedHush ? (
              <>
                <div
                  style={{
                    maxHeight: 160,
                    overflowY: "auto",
                    marginBottom: 8,
                  }}
                >
                  {hushMessages.map((msg) => (
                    <div key={msg.id} style={{ marginBottom: 6 }}>
                      <span style={{ opacity: 0.6 }}>
                        {getHushUserName(msg.user_id)}:
                      </span>{" "}
                      <span>{msg.content}</span>
                    </div>
                  ))}
                </div>

                <input
                  value={hushInput}
                  onChange={(e) => setHushInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      sendHushMessage();
                    }
                  }}
                  placeholder="hush message..."
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    borderBottom: "1px solid rgba(255,255,255,0.2)",
                    color: "#eaeaea",
                    fontSize: 12,
                    outline: "none",
                    paddingBottom: 6,
                  }}
                />

                <div
                  className="kozmos-tap"
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    opacity: 0.6,
                    cursor: "pointer",
                  }}
                  onClick={sendHushMessage}
                >
                  {hushSending ? "..." : "send"}
                </div>

                <div
                  className="kozmos-tap"
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    opacity: 0.4,
                    cursor: "pointer",
                  }}
                  onClick={() => leaveHushChat(selectedHushChatId!)}
                >
                  leave
                </div>
              </>
            ) : selectedHushMembership?.status === "invited" ? (
              <div style={{ opacity: 0.5 }}>
                invite pending.{" "}
                <span
                  style={{ cursor: "pointer", opacity: 0.8 }}
                  onClick={() => acceptHushInvite(selectedHushChatId!)}
                >
                  accept
                </span>{" "}
                /{" "}
                <span
                  style={{ cursor: "pointer", opacity: 0.6 }}
                  onClick={() => declineHushInvite(selectedHushChatId!)}
                >
                  decline
                </span>
              </div>
            ) : (
              <div style={{ opacity: 0.4 }}>not inside</div>
            )}
          </div>
        )}
        </div>

        {/* CHAT */}
        <div style={chatColumnStyle}>
        <div
          className="kozmos-shared-glow"
          style={{
            fontSize: 20,
            letterSpacing: "0.12em",
            fontWeight: 500,
            opacity: 0.6,
            marginBottom: 18,
            textTransform: "none",
          }}
        >
          shared space
        </div>

        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              marginBottom: 12,
              display: "flex",
              gap: 16,
              justifyContent: "space-between",
              alignItems: "flex-start",
            }}
          >
            <div style={{ flex: 1, lineHeight: 1.6 }}>
              <div>
                <span
                  style={{
                    opacity: 0.6,
                    cursor: m.user_id === userId ? "default" : "pointer",
                  }}
                  onMouseEnter={() => setHoveredMsgId(m.id)}
                  onMouseLeave={() => setHoveredMsgId(null)}
                  onClick={() => {
                    if (m.user_id === userId) return;
                    setHushInviteTarget({
                      userId: m.user_id,
                      username: m.username,
                      chatId: isSelectedHushOwner
                        ? selectedHushChatId ?? undefined
                        : undefined,
                    });
                  }}
                >
                  {m.user_id !== userId && hoveredMsgId === m.id && (
                    <span style={hushPillStyle}>hush-chat</span>
                  )}
                  {m.username}:
                </span>{" "}
                <span>{m.content}</span>
                {m.user_id === userId && (
                  <span
                    onClick={() => deleteMessage(m.id)}
                    style={{
                      marginLeft: 8,
                      fontSize: 11,
                      opacity: 0.4,
                      cursor: "pointer",
                    }}
                  >
                    delete
                  </span>
                )}
              </div>

              {axyMsgReflection[m.id] && (
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 13,
                    opacity: 0.75,
                    fontStyle: "italic",
                  }}
                >
                  <span
                    style={{
                      color: "#6BFF8E",
                      letterSpacing: "0.12em",
                      marginRight: 4,
                      cursor: "pointer",
                    }}
                    onClick={() => {
                      setAxyMsgFadeId(m.id);

                      setAxyMsgReflection((prev) => {
                        const copy = { ...prev };
                        delete copy[m.id];
                        return copy;
                      });

                      setTimeout(() => {
                        setAxyMsgFadeId(null);
                      }, 400);
                    }}
                  >
                    Axy reflects:
                  </span>
                  {axyMsgReflection[m.id]}
                </div>
              )}
            </div>

            <img
              src="/axy-logofav.png"
              alt="Axy"
              style={{
                width: 22,
                height: 22,
                cursor: "pointer",
                opacity: axyMsgFadeId === m.id ? 0.25 : 0.6,
                transform: axyMsgPulseId === m.id ? "scale(1.2)" : "scale(1)",
                transition:
                  "opacity 0.4s ease, transform 0.3s ease, filter 0.25s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.filter =
                  "drop-shadow(0 0 4px rgba(107,255,142,0.35))";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.filter = "none";
              }}
              onClick={() => {
                setAxyMsgPulseId(m.id);
                askAxyOnMessage(m.id, m.content);

                setTimeout(() => {
                  setAxyMsgPulseId(null);
                }, 300);
              }}
            />
          </div>
        ))}

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="write something..."
          style={{
            width: "100%",
            minHeight: 80,
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.2)",
            color: "#eaeaea",
            padding: 16,
            resize: "none",
            outline: "none",
            fontSize: 14,
          }}
        />

        <div
          style={{
            marginTop: 12,
            fontSize: 12,
            letterSpacing: "0.12em",
            opacity: 0.6,
            cursor: "pointer",
          }}
          onClick={sendMessage}
        >
          {loading ? "sending..." : "send"}
        </div>
        </div>

        {/* PLAY PANEL */}
        <div
          style={{
            ...playPanelStyle,
            minHeight: playOpen ? undefined : playClosedHeight ?? undefined,
          }}
          onClick={() => setPlayOpen((prev) => !prev)}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <div style={{ opacity: 0.6, letterSpacing: "0.2em" }}>
              {"kozmos\u00b7play"}
            </div>
            <div style={{ opacity: 0.35 }}>beta</div>
          </div>

          <div style={{ opacity: 0.5, marginBottom: 6 }}>
            quiet games inside kozmos
          </div>

          {playOpen && (
            <>
              <div style={{ marginBottom: 10 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 6,
                  }}
                >
                  <span>signal drift</span>
                  <span className="kozmos-tap" style={{ opacity: 0.6 }}>
                    enter
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 6,
                  }}
                >
                  <span>slow orbit</span>
                  <span className="kozmos-tap" style={{ opacity: 0.6 }}>
                    enter
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span>hush puzzle</span>
                  <span className="kozmos-tap" style={{ opacity: 0.6 }}>
                    enter
                  </span>
                </div>
              </div>

              <div style={{ opacity: 0.35, fontSize: 11 }}>
                more arriving soon
              </div>
            </>
          )}
        </div>
      </div>

      {/* AXY */}
      {showAxy && (
        <div
          style={{
            position: "absolute",
            bottom: 96,
            right: 24,
            fontSize: 13,
            textAlign: "right",
            width: 260,
          }}
        >
          <div
            style={{ color: "#6BFF8E", cursor: "pointer" }}
            onClick={() => setOpenAxy(!openAxy)}
          >
            Axy is here.
          </div>

          {openAxy && (
            <div style={{ marginTop: 8, opacity: 0.85 }}>
              <div style={{ marginBottom: 6 }}>
                {axyReply || "I exist inside Kozmos."}
              </div>

              <input
                value={axyInput}
                onChange={(e) => setAxyInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && askAxy()}
                placeholder="say something"
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  borderBottom: "1px solid rgba(255,255,255,0.2)",
                  color: "#eaeaea",
                  fontSize: 12,
                  outline: "none",
                }}
              />

              <div
                onClick={askAxy}
                style={{
                  marginTop: 6,
                  fontSize: 11,
                  opacity: 0.6,
                  cursor: "pointer",
                }}
              >
                {axyLoading ? "..." : "ask"}
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}

const hushPillStyle: React.CSSProperties = {
  display: "inline-block",
  marginRight: 6,
  padding: "2px 6px",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 999,
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "lowercase",
  opacity: 0.6,
};

const hushPanelStyle: React.CSSProperties = {
  width: "100%",
  marginLeft: -32,
  padding: 12,
  fontSize: 12,
  letterSpacing: "0.04em",
  opacity: 0.9,
  borderRadius: 12,
  border: "1px solid rgba(107,255,142,0.15)",
  background:
    "linear-gradient(180deg, rgba(10,16,12,0.92), rgba(6,10,8,0.78))",
  boxShadow:
    "0 0 24px rgba(107,255,142,0.16), inset 0 0 12px rgba(107,255,142,0.08)",
  backdropFilter: "blur(6px)",
};

const mainGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(260px, 1fr) minmax(0, 680px) minmax(0, 1fr)",
  columnGap: 24,
  alignItems: "start",
  marginTop: 120,
  paddingLeft: 36,
  paddingRight: 0,
};

const chatColumnStyle: React.CSSProperties = {
  width: "100%",
};

const playPanelStyle: React.CSSProperties = {
  width: "100%",
  marginRight: 16,
  padding: 12,
  fontSize: 12,
  letterSpacing: "0.04em",
  opacity: 0.9,
  borderRadius: 12,
  border: "1px solid rgba(102, 2, 60, 0.28)",
  background:
    "linear-gradient(180deg, rgba(20,10,24,0.92), rgba(12,6,16,0.78))",
  boxShadow:
    "0 0 24px rgba(102, 2, 60, 0.28), inset 0 0 12px rgba(102, 2, 60, 0.18)",
  backdropFilter: "blur(6px)",
};


