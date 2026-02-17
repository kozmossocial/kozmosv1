"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Note = {
  id: string;
  content: string;
};

type TouchUser = {
  id: string;
  username: string;
  avatar_url: string | null;
};

type TouchRequest = {
  id: number;
  username: string;
  avatar_url: string | null;
};

export default function MyHome() {
  const router = useRouter();

  const [username, setUsername] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const displayUsername = username?.trim() ? username.trim() : "\u00A0";

  //  AXY MICRO STATES
  const [axyPulseId, setAxyPulseId] = useState<string | null>(null);
  const [axyFadeId, setAxyFadeId] = useState<string | null>(null);

  const [noteInput, setNoteInput] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [touchUsers, setTouchUsers] = useState<TouchUser[]>([]);
  const [incomingTouchRequests, setIncomingTouchRequests] = useState<TouchRequest[]>(
    []
  );
  const [touchLoading, setTouchLoading] = useState(false);
  const [touchBusyId, setTouchBusyId] = useState<number | null>(null);
  const [touchEditMode, setTouchEditMode] = useState(false);
  const [touchSavingOrder, setTouchSavingOrder] = useState(false);
  const [touchRemovingUserId, setTouchRemovingUserId] = useState<string | null>(null);

  //  AXY STATES
  const [axyReflection, setAxyReflection] = useState<Record<string, string>>({});
  const [, setAxyLoadingId] = useState<string | null>(null);
  const [personalAxyOpen, setPersonalAxyOpen] = useState(false);
  const [personalAxyInput, setPersonalAxyInput] = useState("");
  const [personalAxyReply, setPersonalAxyReply] = useState<string | null>(null);
  const [personalAxyLoading, setPersonalAxyLoading] = useState(false);
  const [personalLastMessage, setPersonalLastMessage] = useState<string | null>(
    null
  );

  async function loadKeepInTouch() {
    setTouchLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setTouchUsers([]);
        setIncomingTouchRequests([]);
        return;
      }

      const res = await fetch("/api/keep-in-touch", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const body = (await res.json().catch(() => ({}))) as {
        inTouch?: TouchUser[];
        incoming?: TouchRequest[];
      };

      if (!res.ok) {
        setTouchUsers([]);
        setIncomingTouchRequests([]);
        return;
      }

      setTouchUsers(Array.isArray(body.inTouch) ? body.inTouch : []);
      setIncomingTouchRequests(Array.isArray(body.incoming) ? body.incoming : []);
    } finally {
      setTouchLoading(false);
    }
  }

  async function respondKeepInTouch(requestId: number, decision: "accept" | "decline") {
    if (touchBusyId) return;
    setTouchBusyId(requestId);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      await fetch("/api/keep-in-touch/respond", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          requestId,
          decision,
        }),
      });

      await loadKeepInTouch();
    } finally {
      setTouchBusyId(null);
    }
  }

  async function persistTouchOrder(nextUsers: TouchUser[]) {
    setTouchSavingOrder(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      await fetch("/api/keep-in-touch/order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          orderedUserIds: nextUsers.map((row) => row.id),
        }),
      });
    } finally {
      setTouchSavingOrder(false);
    }
  }

  function moveTouchUser(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= touchUsers.length) return;

    const nextUsers = [...touchUsers];
    const swap = nextUsers[index];
    nextUsers[index] = nextUsers[nextIndex];
    nextUsers[nextIndex] = swap;
    setTouchUsers(nextUsers);
    void persistTouchOrder(nextUsers);
  }

  async function removeTouchUser(targetUserId: string) {
    if (!targetUserId || touchRemovingUserId) return;
    setTouchRemovingUserId(targetUserId);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      await fetch("/api/keep-in-touch/remove", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ targetUserId }),
      });

      await loadKeepInTouch();
    } finally {
      setTouchRemovingUserId(null);
    }
  }

  useEffect(() => {

    async function loadUserAndNotes() {
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

      setUsername(profile?.username?.trim() || "user");

      const { data: notesData } = await supabase
        .from("notes")
        .select("id, content")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      setNotes(notesData || []);
      await loadKeepInTouch();
    }

    loadUserAndNotes();
  }, [router]);
useEffect(() => {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      router.replace("/login");
    }
  });

  return () => {
    subscription.unsubscribe();
  };
}, [router]);

  useEffect(() => {
    if (!userId) return;

    const poll = window.setInterval(() => {
      void loadKeepInTouch();
    }, 15000);

    return () => {
      window.clearInterval(poll);
    };
  }, [userId]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/");
  }

  async function saveNote() {
    if (!noteInput.trim() || !userId) return;

    setLoading(true);

    const { data } = await supabase
      .from("notes")
      .insert({
        user_id: userId,
        content: noteInput,
      })
      .select("id, content")
      .single();

    if (data) {
      setNotes((prev) => [data, ...prev]);
    }

    setNoteInput("");
    setLoading(false);
  }

  async function deleteNote(id: string) {
    await supabase.from("notes").delete().eq("id", id);
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }

  //  ASK AXY
  async function askAxy(noteId: string, content: string) {
    setAxyLoadingId(noteId);

    try {
      const res = await fetch("/api/axy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Reflect on this note in one calm sentence:\n\n${content}`,
        }),
      });

      const data = await res.json();

      setAxyReflection((prev) => ({
        ...prev,
        [noteId]: data.reply,
      }));
    } catch {
      setAxyReflection((prev) => ({
        ...prev,
        [noteId]: "...",
      }));
    }

    setAxyLoadingId(null);
  }

  async function askPersonalAxy() {
    const message = personalAxyInput.trim();
    if (!message) return;

    setPersonalAxyLoading(true);
    setPersonalAxyReply(null);
    setPersonalLastMessage(message);
    setPersonalAxyInput("");

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const res = await fetch("/api/axy/personal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token
            ? { Authorization: `Bearer ${session.access_token}` }
            : {}),
        },
        body: JSON.stringify({
          message,
          recentNotes: notes.slice(0, 6).map((n) => n.content),
        }),
      });

      const data = await res.json();
      setPersonalAxyReply(data.reply);
    } catch {
      setPersonalAxyReply("...");
    }

    setPersonalAxyLoading(false);
  }

  function resetPersonalAxy() {
    setPersonalAxyReply(null);
    setPersonalLastMessage(null);
    setPersonalAxyInput("");
    setPersonalAxyLoading(false);
  }

  return (
    <main style={pageStyle}>
{/*  KOZMOS LOGO */}
<div
  style={{
    position: "absolute",
    top: 32,
    left: "50%",
    transform: "translateX(-50%)",
    cursor: "pointer",
    zIndex: 10,
  }}
  onClick={() => router.push("/")}
>
  <Image
    src="/kozmos-logomother1.png"
    alt="Kozmos"
    width={131}
    height={98}
    className="kozmos-logo kozmos-logo-ambient"
    style={{
      width: 80,
      height: "auto",
      opacity: 0.85,
      borderRadius: 6,
      transition:
        "opacity 0.25s ease, box-shadow 0.25s ease, transform 0.08s ease",
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.opacity = "1";
      e.currentTarget.style.boxShadow =
        "0 0 18px rgba(0,255,170,0.45)";
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.opacity = "0.85";
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
      <div style={topLeftStyle}>
        <span style={{ cursor: "pointer" }} onClick={() => router.push("/main")}>
          main
        </span>{" "}
        /{" "}
        <span
          style={{ cursor: "pointer" }}
          onClick={() => router.refresh()}
        >
          my home
        </span>
      </div>

      {/* TOP RIGHT */}
      <div style={topRightStyle}>
        <span
          style={{ cursor: "pointer", opacity: 0.8 }}
          onClick={() => router.push("/account")}
        >
          {displayUsername}
        </span>
        {" / "}
        <span style={{ cursor: "pointer" }} onClick={handleLogout}>
          logout
        </span>
      </div>

      <div style={touchDockStyle}>
        <div style={touchPanelStyle}>
          <div style={touchPanelHeadStyle}>
            <div style={{ ...labelStyle, marginBottom: 0 }}>users in touch</div>
            <button
              type="button"
              onClick={() => setTouchEditMode((prev) => !prev)}
              style={touchEditButtonStyle}
            >
              {touchEditMode ? "done" : "edit"}
            </button>
          </div>

          {touchLoading ? (
            <div style={touchMutedStyle}>loading...</div>
          ) : touchUsers.length === 0 ? (
            <div style={touchMutedStyle}>no users in touch yet</div>
          ) : (
            <div style={touchListStyle}>
              {touchUsers.map((user, idx) => (
                <div key={user.id} style={touchUserRowStyle}>
                  <div style={touchAvatarStyle}>
                    {user.avatar_url ? (
                      <img
                        src={user.avatar_url}
                        alt={`${user.username} avatar`}
                        style={touchAvatarImageStyle}
                      />
                    ) : (
                      <span style={{ fontSize: 12, opacity: 0.72 }}>
                        {(user.username[0] ?? "?").toUpperCase()}
                      </span>
                    )}
                  </div>
                  <span style={{ opacity: 0.82 }}>{user.username}</span>
                  {touchEditMode ? (
                    <div style={touchEditActionsStyle}>
                      <button
                        type="button"
                        onClick={() => moveTouchUser(idx, -1)}
                        disabled={idx === 0 || touchSavingOrder}
                        style={touchMiniButtonStyle}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveTouchUser(idx, 1)}
                        disabled={idx === touchUsers.length - 1 || touchSavingOrder}
                        style={touchMiniButtonStyle}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void removeTouchUser(user.id);
                        }}
                        disabled={touchRemovingUserId === user.id}
                        style={{ ...touchMiniButtonStyle, opacity: 0.72 }}
                      >
                        {touchRemovingUserId === user.id ? "..." : "remove"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {incomingTouchRequests.length > 0 ? (
            <div style={{ marginTop: 14 }}>
              <div style={{ ...labelStyle, marginBottom: 8, opacity: 0.5 }}>
                keep in touch requests
              </div>
              <div style={touchListStyle}>
                {incomingTouchRequests.map((row) => (
                  <div key={`touch-request-${row.id}`} style={touchRequestRowStyle}>
                    <div style={touchUserRowStyle}>
                      <div style={touchAvatarStyle}>
                        {row.avatar_url ? (
                          <img
                            src={row.avatar_url}
                            alt={`${row.username} avatar`}
                            style={touchAvatarImageStyle}
                          />
                        ) : (
                          <span style={{ fontSize: 12, opacity: 0.72 }}>
                            {(row.username[0] ?? "?").toUpperCase()}
                          </span>
                        )}
                      </div>
                      <span style={{ opacity: 0.82 }}>{row.username}</span>
                    </div>

                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => {
                          void respondKeepInTouch(row.id, "accept");
                        }}
                        disabled={touchBusyId === row.id}
                        style={touchActionButtonStyle}
                      >
                        {touchBusyId === row.id ? "..." : "yes"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void respondKeepInTouch(row.id, "decline");
                        }}
                        disabled={touchBusyId === row.id}
                        style={{ ...touchActionButtonStyle, opacity: 0.6 }}
                      >
                        no
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* CONTENT */}
      <div style={contentStyle}>
        <div style={{ opacity: 0.6, marginBottom: 6 }}>
          this is your space.
        </div>

        <div style={labelStyle}>keep your notes here</div>

        <textarea
          value={noteInput}
          onChange={(e) => setNoteInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void saveNote();
            }
          }}
          placeholder="write something..."
          style={textareaStyle}
        />

        <div style={saveStyle} onClick={saveNote}>
          {loading ? "saving..." : "save"}
        </div>

        {/* NOTES */}
        <div style={notesListStyle}>
          {notes.map((note) => (
            <div
              key={note.id}
              style={{
                ...noteStyle,
                display: "flex",
                gap: 16,
                justifyContent: "space-between",
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={noteContentStyle}>
                  {note.content}
                </div>

                {axyReflection[note.id] && (
                  <div
                    style={{
                      marginTop: 8,
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
                        setAxyFadeId(note.id);

                        setAxyReflection((prev) => {
                          const copy = { ...prev };
                          delete copy[note.id];
                          return copy;
                        });

                        setTimeout(() => {
                          setAxyFadeId(null);
                        }, 400);
                      }}
                    >
                      Axy reflects:
                    </span>
                    {axyReflection[note.id]}
                  </div>
                )}

                <div style={noteActionsStyle}>
                  <span onClick={() => deleteNote(note.id)}>delete</span>
                </div>
              </div>

              {/* AXY LOGO */}
              <Image
                src="/axy-logofav.png"
                alt="Axy"
                width={22}
                height={22}
                style={{
                  width: 22,
                  height: 22,
                  cursor: "pointer",
                  opacity: axyFadeId === note.id ? 0.25 : 0.6,
                  transform: axyPulseId === note.id ? "scale(1.2)" : "scale(1)",
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
                  setAxyPulseId(note.id);
                  askAxy(note.id, note.content);

                  setTimeout(() => {
                    setAxyPulseId(null);
                  }, 300);
                }}
              />

            </div>
          ))}
        </div>

        <div style={personalAxyWrapStyle}>
          <div
            className={`axy-shell${personalAxyOpen ? " open" : ""}`}
            onClick={() => setPersonalAxyOpen((prev) => !prev)}
            role="button"
            tabIndex={0}
            aria-expanded={personalAxyOpen}
            style={personalAxyShellStyle}
          >
            <Image
              src="/axy-banner.png"
              alt="Personal Axy"
              width={504}
              height={360}
              className="axy-shell-logo"
              style={personalAxyLogoStyle}
            />

            <div
              className="axy-shell-chat"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="axy-shell-card" style={personalAxyCardStyle}>
                <div style={{ marginBottom: 8, opacity: 0.8, fontSize: 11 }}>
                  {personalAxyReply ? (
                    personalAxyReply
                  ) : (
                    <>
                      I&apos;m <span className="axy-name-glow">Axy</span>. I
                      exist inside Kozmos·
                    </>
                  )}
                </div>

                {personalLastMessage ? (
                  <div
                    style={{
                      marginBottom: 8,
                      fontSize: 11,
                      color: "rgba(150, 95, 210, 0.9)",
                    }}
                  >
                    {personalLastMessage}
                  </div>
                ) : null}

                <input
                  value={personalAxyInput}
                  onChange={(e) => setPersonalAxyInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && askPersonalAxy()}
                  placeholder="say something"
                  style={personalAxyInputStyle}
                />

                <div style={personalAxyActionsStyle}>
                  <span
                    className="kozmos-tap"
                    onClick={askPersonalAxy}
                    style={{ cursor: "pointer" }}
                  >
                    {personalAxyLoading ? "..." : "ask"}
                  </span>
                  <span
                    className="kozmos-tap"
                    onClick={resetPersonalAxy}
                    style={{ cursor: "pointer" }}
                  >
                    reset
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

/* styles */

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "#0b0b0b",
  color: "#eaeaea",
  padding: 40,
  position: "relative",
};

const topLeftStyle: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  fontSize: 12,
  letterSpacing: "0.12em",
  opacity: 0.6,
  cursor: "default",
  userSelect: "none",
};

const topRightStyle: React.CSSProperties = {
  position: "absolute",
  top: 16,
  right: 16,
  fontSize: 12,
  letterSpacing: "0.12em",
  opacity: 0.6,
  cursor: "default",
  userSelect: "none",
};

const contentStyle: React.CSSProperties = {
  maxWidth: 580,
  margin: "120px auto 0",
  paddingBottom: 36,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: "0.12em",
  opacity: 0.6,
  marginBottom: 12,
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 120,
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#eaeaea",
  padding: 16,
  resize: "none",
  outline: "none",
  fontSize: 14,
  lineHeight: 1.6,
};

const saveStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: 12,
  letterSpacing: "0.12em",
  opacity: 0.6,
  cursor: "pointer",
};

const noteStyle: React.CSSProperties = {
  marginBottom: 14,
  paddingBottom: 10,
  borderBottom: "1px solid rgba(255,255,255,0.08)",
};

const noteActionsStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  opacity: 0.5,
  cursor: "pointer",
};

const notesListStyle: React.CSSProperties = {
  marginTop: 24,
  maxHeight: "clamp(340px, 46vh, 560px)",
  overflowY: "auto",
  overflowX: "hidden",
  paddingRight: 8,
};

const noteContentStyle: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  lineHeight: 1.45,
};

const touchDockStyle: React.CSSProperties = {
  position: "absolute",
  left: 44,
  top: 214,
  width: "min(360px, calc(100vw - 88px))",
};

const touchPanelStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 10,
  padding: "12px 14px",
  background: "rgba(255,255,255,0.02)",
};

const touchMutedStyle: React.CSSProperties = {
  fontSize: 12,
  opacity: 0.48,
};

const touchPanelHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 10,
};

const touchEditButtonStyle: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 999,
  background: "transparent",
  color: "#eaeaea",
  fontSize: 10,
  letterSpacing: "0.08em",
  padding: "3px 10px",
  opacity: 0.7,
  cursor: "pointer",
};

const touchListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const touchUserRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  minWidth: 0,
};

const touchEditActionsStyle: React.CSSProperties = {
  marginLeft: "auto",
  display: "flex",
  gap: 6,
};

const touchMiniButtonStyle: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 999,
  background: "transparent",
  color: "#eaeaea",
  fontSize: 10,
  letterSpacing: "0.04em",
  padding: "2px 8px",
  cursor: "pointer",
  opacity: 0.78,
};

const touchAvatarStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: "50%",
  border: "1px solid rgba(255,255,255,0.2)",
  overflow: "hidden",
  display: "grid",
  placeItems: "center",
  background: "rgba(255,255,255,0.05)",
  flexShrink: 0,
};

const touchAvatarImageStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

const touchRequestRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 999,
  padding: "6px 8px",
};

const touchActionButtonStyle: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.22)",
  borderRadius: 999,
  background: "transparent",
  color: "#eaeaea",
  padding: "2px 10px",
  fontSize: 11,
  letterSpacing: "0.08em",
  cursor: "pointer",
  opacity: 0.82,
};

const personalAxyWrapStyle: React.CSSProperties = {
  marginTop: 72,
  marginBottom: 28,
  display: "flex",
  justifyContent: "center",
};

const personalAxyShellStyle: React.CSSProperties = {
  width: "min(280px, 88vw)",
  minHeight: 120,
};

const personalAxyLogoStyle: React.CSSProperties = {
  width: "min(120px, 62%)",
};

const personalAxyCardStyle: React.CSSProperties = {
  width: "min(220px, 84vw)",
  minHeight: 108,
  padding: 10,
};

const personalAxyInputStyle: React.CSSProperties = {
  width: "100%",
  background: "transparent",
  border: "none",
  borderBottom: "1px solid rgba(255,255,255,0.2)",
  color: "#eaeaea",
  fontSize: 11,
  outline: "none",
};

const personalAxyActionsStyle: React.CSSProperties = {
  marginTop: 8,
  display: "flex",
  gap: 12,
  justifyContent: "center",
  fontSize: 10,
  opacity: 0.65,
};


