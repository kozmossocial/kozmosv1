"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Message = {
  id: string;
  user_id: string;
  username: string;
  content: string;
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

  /* delayed presence */
  useEffect(() => {
    const t = setTimeout(() => setShowAxy(true), 3000);
    return () => clearTimeout(t);
  }, []);

  /* 🔐 load user + messages */
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

  /* 🔁 REALTIME (insert + delete) */
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

  /* 💬 send */
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

  /* 🗑 delete */
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

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/");
  }

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

      {/* CHAT */}
      <div style={{ maxWidth: 640, margin: "120px auto 0" }}>
        <div
          style={{
            fontSize: 12,
            letterSpacing: "0.12em",
            opacity: 0.6,
            marginBottom: 16,
          }}
        >
          shared space
        </div>

        {messages.map((m) => (
          <div key={m.id} style={{ marginBottom: 12, lineHeight: 1.6 }}>
            <span style={{ opacity: 0.6 }}>{m.username}:</span>{" "}
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
        ))}

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="write something…"
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
          {loading ? "sending…" : "send"}
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
                {axyLoading ? "…" : "ask"}
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
