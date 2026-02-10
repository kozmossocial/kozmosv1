"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Note = {
  id: string;
  content: string;
};

export default function MyHome() {
  const router = useRouter();

  const [username, setUsername] = useState("user");
  const [userId, setUserId] = useState<string | null>(null);

  //  AXY MICRO STATES
  const [axyPulseId, setAxyPulseId] = useState<string | null>(null);
  const [axyFadeId, setAxyFadeId] = useState<string | null>(null);

  const [noteInput, setNoteInput] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);

  //  AXY STATES
  const [axyReflection, setAxyReflection] = useState<Record<string, string>>({});
  const [axyLoadingId, setAxyLoadingId] = useState<string | null>(null);

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

      setUsername(profile?.username ?? "user");

      const { data: notesData } = await supabase
        .from("notes")
        .select("id, content")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      setNotes(notesData || []);
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
  <img
    src="/kozmos-logomother1.png"
    alt="Kozmos"
      className="kozmos-logo kozmos-logo-ambient"
    style={{
      width: 80,
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
          {username}
        </span>
        {" / "}
        <span style={{ cursor: "pointer" }} onClick={handleLogout}>
          logout
        </span>
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
          placeholder="write something..."
          style={textareaStyle}
        />

        <div style={saveStyle} onClick={saveNote}>
          {loading ? "saving..." : "save"}
        </div>

        {/* NOTES */}
        <div style={{ marginTop: 40 }}>
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
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
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
             <img
  src="/axy-logofav.png"
  alt="Axy"
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
};

const topRightStyle: React.CSSProperties = {
  position: "absolute",
  top: 16,
  right: 16,
  fontSize: 12,
  letterSpacing: "0.12em",
  opacity: 0.6,
};

const contentStyle: React.CSSProperties = {
  maxWidth: 520,
  margin: "120px auto 0",
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
  marginBottom: 20,
  paddingBottom: 12,
  borderBottom: "1px solid rgba(255,255,255,0.08)",
};

const noteActionsStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  opacity: 0.5,
  cursor: "pointer",
};


