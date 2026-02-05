"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function Register() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRegister() {
    if (!email || !password || !username) return;

    setLoading(true);

    // 1️⃣ Supabase Auth signup
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      setLoading(false);
      alert(error.message);
      return;
    }

    const user = data.user;

    // 2️⃣ Custom profile insert (SADECE username)
    if (user) {
      const { error: profileError } = await supabase
        .from("profileskozmos")
        .insert({
          id: user.id,        // auth.users.id ile AYNI
          username: username,
        });

      if (profileError) {
        setLoading(false);
        alert(profileError.message);
        return;
      }
    }

    setLoading(false);
    router.push("/login");
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0b0b0b",
        color: "#eaeaea",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 40,
        position: "relative",
      }}
    >
      {/* TOP LEFT — GO BACK */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          fontSize: 12,
          letterSpacing: "0.12em",
          opacity: 0.6,
          cursor: "pointer",
        }}
        onClick={() => router.push("/")}
        onMouseEnter={(e) => (e.currentTarget.style.fontWeight = "600")}
        onMouseLeave={(e) => (e.currentTarget.style.fontWeight = "400")}
      >
        ← go back
      </div>

      <div style={{ width: 320 }}>
        <h1
          style={{
            letterSpacing: "0.25em",
            fontWeight: 400,
            marginBottom: 32,
            textAlign: "center",
          }}
        >
          REGISTER
        </h1>

        <input
          placeholder="email"
          type="email"
          style={inputStyle}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          placeholder="username"
          style={inputStyle}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <input
          placeholder="password"
          type="password"
          style={inputStyle}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button
          style={buttonStyle}
          onClick={handleRegister}
          disabled={loading}
        >
          {loading ? "..." : "register"}
        </button>

        <div
          style={{
            marginTop: 24,
            fontSize: 12,
            opacity: 0.6,
            textAlign: "center",
            cursor: "pointer",
          }}
          onClick={() => router.push("/login")}
        >
          already here? login
        </div>
      </div>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "transparent",
  border: "none",
  borderBottom: "1px solid rgba(255,255,255,0.2)",
  color: "#eaeaea",
  padding: "12px 0",
  marginBottom: 24,
  outline: "none",
  fontSize: 14,
};

const buttonStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 16,
  background: "none",
  border: "1px solid rgba(255,255,255,0.3)",
  color: "#eaeaea",
  padding: "12px",
  cursor: "pointer",
  letterSpacing: "0.15em",
};
