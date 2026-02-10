"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Message = {
  id: string;
  username: string;
  content: string;
};

export default function Main() {
  const router = useRouter();

  const [username, setUsername] = useState<string>("user");
  const [userId, setUserId] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);

  // 🔐 Load user + messages
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

      // username
      const { data: profile } = await supabase
        .from("profileskozmos")
        .select("username")
        .eq("id", user.id)
        .maybeSingle();

      setUsername(profile?.username ?? "user");

      // messages
      const { data } = await supabase
        .from("main_messages")
        .select("id, username, content")
        .order("created_at", { ascending: true });

      setMessages(data || []);
    }

    load();
  }, [router]);

  // 🔁 REALTIME — yeni mesajları anında al
  useEffect(() => {
    const channel = supabase
      .channel("main-messages-realtime")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "main_messages",
        },
        (payload) => {
          const newMessage = payload.new as Message;

          setMessages((prev) => {
            if (prev.some((m) => m.id === newMessage.id)) {
              return prev;
            }
            return [...prev, newMessage];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // 💬 send message
  async function sendMessage() {
    if (!input.trim() || !userId) return;

    setLoading(true);

    const { data } = await supabase
      .from("main_messages")
      .insert({
        user_id: userId,
        username,
        content: input,
      })
      .select("id, username, content")
      .single();

    if (data) {
      setMessages((prev) => [...prev, data]);
    }

    setInput("");
    setLoading(false);
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
      {/* TOP LEFT — main / my home */}
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
        <span
          style={{ cursor: "pointer" }}
          onClick={() => router.push("/main")}
        >
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

      {/* TOP RIGHT — username / logout */}
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
        <span
          style={{ cursor: "pointer" }}
          onClick={handleLogout}
        >
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

        {/* messages */}
        <div style={{ marginBottom: 32 }}>
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                marginBottom: 12,
                lineHeight: 1.6,
              }}
            >
              <span style={{ opacity: 0.6 }}>
                {m.username}:
              </span>{" "}
              <span>{m.content}</span>
            </div>
          ))}
        </div>

        {/* input */}
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
            lineHeight: 1.6,
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
    </main>
  );
}
