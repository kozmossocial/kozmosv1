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

  const [username, setUsername] = useState<string>("user");
  const [userId, setUserId] = useState<string | null>(null);

  const [noteInput, setNoteInput] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    async function loadUser() {
      // 1️⃣ Auth user
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError || !user) {
        router.push("/login");
        return;
      }

      setUserId(user.id);

      // 2️⃣ Profile username
      const { data: profile } = await supabase
        .from("profileskozmos")
        .select("username")
        .eq("id", user.id)
        .maybeSingle();

      setUsername(profile?.username ?? "user");

      // 3️⃣ Notes
      const { data: notesData } = await supabase
        .from("notes")
        .select("id, content")
        .order("created_at", { ascending: false });

      setNotes(notesData || []);
    }

    loadUser();
  }, [router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/");
  }

  async function saveNote() {
    if (!noteInput.trim() || !userId) return;

    setLoading(true);

    if (editingId) {
      await supabase
        .from("notes")
        .update({ content: noteInput })
        .eq("id", editingId);

      setNotes((prev) =>
        prev.map((n) =>
          n.id === editingId ? { ...n, content: noteInput } : n
        )
      );

      setEditingId(null);
    } else {
      const { data } = await supabase
        .from("notes")
        .insert({
          user_id: userId,
          content: noteInput,
        })
        .select()
        .single();

      if (data) {
        setNotes((prev) => [data, ...prev]);
      }
    }

    setNoteInput("");
    setLoading(false);
  }

  async function deleteNote(id: string) {
    await supabase.from("notes").delete().eq("id", id);
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }

  function editNote(note: Note) {
    setNoteInput(note.content);
    setEditingId(note.id);
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0b0b0b",
        color: "#eaeaea",
        padding: "40px",
        position: "relative",
      }}
    >
      {/* TOP LEFT */}
      <div style={topLeftStyle}>
        <span
          style={{ cursor: "pointer" }}
          onClick={() => router.push("/coming-soon")}
        >
          main
        </span>{" "}
        / <span>my home</span>
      </div>

      {/* TOP RIGHT */}
      <div style={topRightStyle}>
        <span style={{ marginRight: 6 }}>{username}</span> /{" "}
        <span style={{ cursor: "pointer" }} onClick={handleLogout}>
          logout
        </span>
      </div>

      {/* CONTENT */}
      <div
        style={{
          maxWidth: 520,
          margin: "0 auto",
          marginTop: 120,
        }}
      >
        <div style={{ opacity: 0.6, marginBottom: 6 }}>
          this is your space.
        </div>

        <div
          style={{
            fontSize: 12,
            letterSpacing: "0.12em",
            opacity: 0.6,
            marginBottom: 12,
          }}
        >
          keep your notes here
        </div>

        <textarea
          value={noteInput}
          onChange={(e) => setNoteInput(e.target.value)}
          placeholder="write something…"
          style={textareaStyle}
        />

        <div style={saveStyle} onClick={saveNote}>
          {loading ? "saving…" : editingId ? "update" : "save"}
        </div>

        {/* NOTES */}
        <div style={{ marginTop: 40 }}>
          {notes.map((note) => (
            <div key={note.id} style={noteStyle}>
              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
                {note.content}
              </div>

              <div style={noteActionsStyle}>
                <span onClick={() => editNote(note)}>edit</span>
                <span onClick={() => deleteNote(note.id)}>delete</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

/* styles */

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
  display: "flex",
  gap: 12,
  cursor: "pointer",
};
